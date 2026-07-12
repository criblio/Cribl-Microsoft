import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  rm,
  cp,
  writeFile,
  readFile,
  access,
} from 'node:fs/promises';
import { join, dirname, relative, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** @param {string} cwd */
async function runNpmBuild(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `npm run build exited with code ${code}`));
    });
  });
}

let packageInProgress = false;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRIBL_CREATE_APP_SCRIPT_VERSION = '0.2.0';

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `tar` to a REAL FILE (not a pipe). tar must write to a file, never to a
 * Node-consumed stdout pipe: Windows bsdtar exits 1 on the pipe path (a
 * non-fatal warning under libarchive) while GNU tar exits 0, and the old
 * streaming design then called stdout.destroy() on that non-zero exit, which
 * could truncate the archive mid-write (observed: a 2 KB package with an empty
 * static/ folder). File output exits 0 on both GNU tar and bsdtar.
 *
 * The -f path is passed RELATIVE to cwd, never absolute: Node on Windows
 * commonly resolves `tar` to Git's GNU tar, which reads an absolute `C:\...`
 * path as a REMOTE host spec ("Cannot connect to C: resolve failed") and writes
 * nothing. A relative path has no colon, so both GNU tar and bsdtar write the
 * local file.
 *
 * @param {string} cwd
 * @param {string} outPath - absolute path for the .tgz (outside the tarred dir)
 * @param {string} srcDir - directory (relative to cwd) whose contents are packed
 */
async function tarToFile(cwd, outPath, srcDir) {
  const relOut = (relative(cwd, outPath) || outPath).replace(/\\/g, '/');
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', relOut, '-C', srcDir, '.'], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      // Non-zero from tar is not blindly fatal (bsdtar warns on benign
      // conditions); the archive is validated separately by verifyArchive.
      resolve({ code, stderr });
    });
  });
}

/**
 * Validate a produced .tgz: gzip magic bytes, a sane minimum size, and that it
 * actually contains the app entry point. Catches a truncated or empty archive
 * regardless of tar's exit code.
 *
 * @param {string} tgzPath
 * @param {boolean} expectStatic - a non-dev pack must carry static/index.html
 */
async function verifyArchive(tgzPath, expectStatic) {
  const buf = await readFile(tgzPath);
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error(`package ${tgzPath} is not a valid gzip archive`);
  }
  if (expectStatic && buf.length < 10_000) {
    throw new Error(
      `package ${tgzPath} is only ${buf.length} bytes - the build output is likely missing (empty static/)`
    );
  }
  const entries = await new Promise((resolve, reject) => {
    // Relative -f from the tgz's own directory: an absolute C:\ path trips GNU
    // tar's remote-host parsing on Windows (see tarToFile).
    const child = spawn('tar', ['-tzf', basename(tgzPath)], {
      cwd: dirname(tgzPath),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.once('error', reject);
    child.once('close', () => resolve(out));
  });
  if (!entries.includes('package.json')) {
    throw new Error(`package ${tgzPath} is missing package.json`);
  }
  if (expectStatic && !/static\/index\.html/.test(entries)) {
    throw new Error(`package ${tgzPath} is missing static/index.html`);
  }
}

/**
 * @param {boolean} [dev]
 * @returns {Promise<{ tgzPath: string; cleanup: () => Promise<void> }>}
 */
export async function createAppPack(dev = false, outPath = undefined) {
  const rootDir = join(__dirname, '..');
  const buildDir = join(rootDir, 'package-build');
  // Writing DIRECTLY to the caller's final path avoids the intermediate
  // package-build.tgz copy window entirely (observed live 2026-07-08: the
  // intermediate vanished between verify and copyFile - an external scanner
  // interfering with rapid create/read/delete churn on the same file name).
  const packedPath = outPath ?? join(rootDir, 'package-build.tgz');
  const distDir = join(rootDir, 'dist');
  const proxiesPath = join(rootDir, 'config', 'proxies.yml');
  const policiesPath = join(rootDir, 'config', 'policies.yml');

  if (await pathExists(buildDir)) {
    await rm(buildDir, { recursive: true });
  }

  await mkdir(buildDir, { recursive: true });
  await mkdir(join(buildDir, 'static'), { recursive: true });
  await mkdir(join(buildDir, 'default'), { recursive: true });

  if (!dev) {
    if (!(await pathExists(distDir))) {
      throw new Error('dist folder not found. Run npm run build first.');
    }
    await cp(distDir, join(buildDir, 'static'), { recursive: true });
  }

  if (await pathExists(proxiesPath)) {
    await cp(proxiesPath, join(buildDir, 'default', 'proxies.yml'));
  }

  if (await pathExists(policiesPath)) {
    await cp(policiesPath, join(buildDir, 'default', 'policies.yml'));
  }

  const rootPackageJson = JSON.parse(
    await readFile(join(rootDir, 'package.json'), 'utf8')
  );

  const packageInfo = Object.fromEntries(
    ['name', 'version', 'displayName', 'description', 'author', 'license', 'cribl']
      .filter((k) => rootPackageJson?.[k])
      .map((k) => [k, rootPackageJson[k]])
  );
  packageInfo.cribl = {
    ...(packageInfo.cribl ?? {}),
    createAppScriptVersion: CRIBL_CREATE_APP_SCRIPT_VERSION,
  };

  if (dev && packageInfo.name) {
    packageInfo.name = `__dev__${packageInfo.name}`;
    packageInfo.displayName = `__dev__${packageInfo.displayName || packageInfo.name}`;
  }

  await writeFile(
    join(buildDir, 'package.json'),
    JSON.stringify(packageInfo, null, 2)
  );

  const cleanup = async () => {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
    // Only the DEFAULT intermediate is disposable; an explicit outPath is the
    // caller's final artifact and must survive cleanup.
    if (outPath === undefined) {
      await rm(packedPath, { force: true }).catch(() => {});
    }
  };

  // Retry the pack+verify: on Windows the tar read can race file handles (AV
  // scan/indexer) right after the build wrote dist/, yielding a truncated
  // archive that verifyArchive catches (observed live 2026-07-08: two failed
  // runs, then an identical run succeeded). Transient by nature - retry.
  const PACK_ATTEMPTS = 6;
  try {
    for (let attempt = 1; attempt <= PACK_ATTEMPTS; attempt += 1) {
      await rm(packedPath, { force: true });
      const { code, stderr } = await tarToFile(rootDir, packedPath, 'package-build');
      try {
        // Validate the actual deliverable; a benign tar warning (non-zero exit
        // with a complete archive) passes, a truncated/empty one fails loudly.
        await verifyArchive(packedPath, !dev);
      } catch (verifyErr) {
        if (attempt === PACK_ATTEMPTS) {
          throw verifyErr;
        }
        // Surface WHAT tar said: a 20-byte archive with a silent note is
        // undiagnosable (live 2026-07-12: eight consecutive failures with
        // the stderr visible nowhere). Longer backoff outlasts the AV scan
        // burst that causes this in the first place.
        process.stderr.write(
          `note: archive verification failed (attempt ${attempt}/${PACK_ATTEMPTS}): ` +
            `${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}` +
            ` [tar exit ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}] - retrying...\n`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      if (code !== 0) {
        process.stderr.write(
          `note: tar exited with code ${code} but the archive validated; proceeding.` +
            (stderr ? ` (tar: ${stderr.trim()})` : '') +
            '\n'
        );
      }
      break;
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { tgzPath: packedPath, cleanup };
}

/**
 * HTTP handler: full build + pack stream, or dev pack (skip build) when `?dev=true`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root - project root (npm cwd)
 */
export async function servePackageTgz(req, res, root) {
  if (packageInProgress) {
    res.statusCode = 503;
    res.setHeader('Retry-After', '30');
    res.setHeader('Content-Type', 'text/plain');
    res.end('Package build in progress. Retry in 30 seconds.');
    return;
  }
  packageInProgress = true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const dev = url.searchParams.get('dev') === 'true';

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const baseName = pkg.name ?? 'plugin';
    const version = pkg.version ?? '0.0.0';
    const tgzBase = dev && pkg.name ? `__dev__${pkg.name}` : baseName;
    const tgzName = `${tgzBase}-${version}.tgz`;

    if (!dev) {
      await runNpmBuild(root);
    }

    const { tgzPath, cleanup } = await createAppPack(dev);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${tgzName}"`);

    try {
      await pipeline(createReadStream(tgzPath), res);
    } finally {
      await cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`Package failed: ${message}`);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } finally {
    packageInProgress = false;
  }
}
