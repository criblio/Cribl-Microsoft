// `npm run bump` (DBT-250): raise the app's patch version in package.json and
// the lock, WITHOUT packaging. Every PR to main that changes what ships or what
// Live Preview shows runs it once; check-version-bump fails the PR otherwise.
//
// The release itself stays batched (operator's choice, 2026-11-04): package the
// version the manifest already names with
//   npm run package -- --version <current>
// so packaging does not bump a second time. check-release-drift warns while the
// manifest is ahead of the last package and prints that command.
//
// Both texts are computed before either file is written, so a conflict-marked
// lock (syncLockVersion throws) leaves the tree untouched rather than half-bumped
// - the same order package.mjs uses.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockWorkspaceKey, syncLockVersion } from './lock-version.mjs';

const XYZ = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextPatch(version) {
  const m = XYZ.exec(version ?? '');
  if (m === null) throw new Error(`The app version "${version}" is not X.Y.Z; fix package.json before bumping.`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** The new package.json and lock texts for the next patch version. */
export function bumpedFiles(manifestText, lockText, workspaceKey) {
  const manifest = JSON.parse(manifestText);
  const version = nextPatch(manifest.version);
  const lock = syncLockVersion(lockText, workspaceKey, version);
  manifest.version = version;
  return { version, manifest: `${JSON.stringify(manifest, null, 2)}\n`, lock };
}

async function main() {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const toolkitDir = join(appDir, '..', '..');
  const manifestPath = join(appDir, 'package.json');
  const lockPath = join(toolkitDir, 'package-lock.json');
  const before = JSON.parse(await readFile(manifestPath, 'utf8')).version;
  const out = bumpedFiles(
    await readFile(manifestPath, 'utf8'),
    await readFile(lockPath, 'utf8'),
    lockWorkspaceKey(toolkitDir, appDir),
  );
  await writeFile(manifestPath, out.manifest);
  await writeFile(lockPath, out.lock);
  console.log(`App version ${before} -> ${out.version} (package.json and package-lock.json). Commit both with the PR.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
