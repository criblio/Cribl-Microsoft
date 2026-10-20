// The app workspace's version as package-lock.json records it (DBT-82).
//
// package.mjs is the only thing that writes package.json's version, and it used
// to stop there - so every release commit left the lock naming the PREVIOUS
// version and check-release red until someone remembered "npm install
// --package-lock-only". This module is how package.mjs does that step itself.
//
// Edited in place rather than by shelling out to npm, for three reasons. The
// field is the ONLY thing a bump changes in the lock: measured 2026-09-03, npm
// regenerating it after a bump changed exactly one line, this workspace's
// version. Writing it directly is deterministic and needs neither a network nor
// an npm on PATH at packaging time. And it can be pinned: the output is
// JSON.stringify with two-space indent and a trailing newline, which is what npm
// writes, and the pins hold the result to a one-line diff against the real lock.
//
// Its own module because package.mjs packages the moment it is loaded, so
// nothing can import a helper from there, and check-release-drift needs the
// same workspace key to read the field back.

import path from 'node:path';

/**
 * The lock keys its workspace entries by PATH relative to the lock, in posix
 * form, so the key is derived rather than written out - a workspace move then
 * keeps working instead of reporting the lock as versionless. The separator
 * swap is not cosmetic: node's relative() yields "apps\\cribl-app" on Windows,
 * which matches no key in any lock file.
 *
 * @param {string} toolkitDir the directory holding package-lock.json
 * @param {string} appDir the app workspace directory
 * @param {typeof path} [pathApi] node:path by default; a parameter only so the
 *   Windows case (path.win32) can be pinned from any platform, CI included
 */
export function lockWorkspaceKey(toolkitDir, appDir, pathApi = path) {
  return pathApi.relative(toolkitDir, appDir).split(pathApi.sep).join('/');
}

/**
 * The lock text with packages[workspaceKey].version set to version, and nothing
 * else changed.
 *
 * THROWS rather than guessing, unlike check-release-drift's reader, which
 * returns null. The reader reports; this writes. Several agents share one tree
 * here, so a half-written or conflict-marked lock is a state that happens, and
 * overwriting one with a re-serialised guess would destroy the evidence of the
 * conflict. A missing workspace entry throws for the same reason: inventing one
 * would produce a lock npm never wrote.
 *
 * @param {string} lockText
 * @param {string} workspaceKey
 * @param {string} version
 * @returns {string}
 */
export function syncLockVersion(lockText, workspaceKey, version) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON (${error.message}). Resolve it - a conflict-marked lock is the usual cause - before packaging.`,
    );
  }

  const entry = lock?.packages?.[workspaceKey];
  if (!entry || typeof entry !== 'object') {
    throw new Error(
      `package-lock.json has no packages["${workspaceKey}"] entry. Run "npm install --package-lock-only" to regenerate it; if the workspace moved, update lock-version.mjs.`,
    );
  }

  entry.version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}
