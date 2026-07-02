import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createAppPack } from './pkgutil.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const buildOutDir = join(rootDir, 'build');
const packageJsonPath = join(rootDir, 'package.json');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version) {
  const match = semverPattern.exec(version);
  if (!match) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function parseArgs(args) {
  let bump = 'patch';
  let explicitVersion;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--minor') {
      bump = 'minor';
    } else if (arg === '--major') {
      bump = 'major';
    } else if (arg === '--version') {
      explicitVersion = args[i + 1];
      i += 1;
      if (!explicitVersion) {
        throw new Error('--version requires a value in X.Y.Z format.');
      }
    } else if (arg.startsWith('--version=')) {
      explicitVersion = arg.slice('--version='.length);
      if (!explicitVersion) {
        throw new Error('--version requires a value in X.Y.Z format.');
      }
    } else {
      throw new Error(`Unknown package option "${arg}". Use --minor, --major, or --version X.Y.Z.`);
    }
  }
  return { bump, explicitVersion };
}

function nextVersion(currentVersion, args) {
  const { bump, explicitVersion } = parseArgs(args);
  if (explicitVersion) {
    parseVersion(explicitVersion);
    return explicitVersion;
  }

  const version = parseVersion(currentVersion);
  if (bump === 'major') {
    return formatVersion({ major: version.major + 1, minor: 0, patch: 0 });
  }
  if (bump === 'minor') {
    return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0 });
  }
  return formatVersion({ major: version.major, minor: version.minor, patch: version.patch + 1 });
}

const packageInfo = JSON.parse(await readFile(packageJsonPath, 'utf8'));
packageInfo.version = nextVersion(packageInfo.version || '0.0.0', process.argv.slice(2));
await writeFile(packageJsonPath, `${JSON.stringify(packageInfo, null, 2)}\n`);

const tgzName = `${packageInfo.name || 'app'}-${packageInfo.version}.tgz`;
const tgzPath = join(buildOutDir, tgzName);
await mkdir(buildOutDir, { recursive: true });
const { closePromise, stdout } = await createAppPack(false);
await Promise.all([ pipeline(stdout, createWriteStream(tgzPath)), closePromise ]);

console.log(`\nPackage created: ${tgzPath}`);
