import { spawn } from 'node:child_process';
import {
  mkdir,
  rm,
  cp,
  writeFile,
  readFile,
  access,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
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
 * @param {boolean} [dev]
 * @returns {Promise<{ closePromise: Promise<void>; stdout: import('node:stream').Readable }>}
 */
export async function createAppPack(dev = false) {
  const rootDir = join(__dirname, '..');
  const buildDir = join(rootDir, 'package-build');
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

  const child = spawn(
    'tar',
    ['-czf', '-', '-C', 'package-build', '.'],
    {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const closePromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (/** @type {Error | null} */ err) => {
      if (settled) return;
      settled = true;
      try {
        await rm(buildDir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    child.once('error', (err) => {
      child.stdout.destroy(err);
      void finish(err);
    });

    child.once('close', (code) => {
      if (code !== 0) {
        void finish(new Error(`tar exited with code ${code}`));
        return;
      }
      void finish(null);
    });
  });

  return { closePromise, stdout: child.stdout };
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

    const { closePromise, stdout } = await createAppPack(dev);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${tgzName}"`);

    await Promise.all([pipeline(stdout, res), closePromise]);
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
