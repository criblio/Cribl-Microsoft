// Pins for the lock write package.mjs makes on every release (DBT-82). The
// real lock is the fixture on purpose: the claim worth holding is that the
// write is the ONE line npm itself would change, and only the file npm wrote
// can show that.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lockWorkspaceKey, syncLockVersion } from './lock-version.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolkitDir = path.join(appDir, '..', '..');
const realLock = readFileSync(path.join(toolkitDir, 'package-lock.json'), 'utf8');
const KEY = lockWorkspaceKey(toolkitDir, appDir);

describe('syncLockVersion', () => {
  it('changes exactly one line of the real lock: the app workspace version', () => {
    const before = realLock.split('\n');
    const after = syncLockVersion(realLock, KEY, '99.0.0').split('\n');

    // Same length and ONE differing line - not merely "the key now says
    // 99.0.0". A re-serialisation in any other format (no indent, a lost
    // trailing newline) still sets the field and fails here instead of
    // showing up as a whole-file diff on the next npm install.
    expect(after).toHaveLength(before.length);
    const changed = before
      .map((line, i) => [line, after[i]])
      .filter(([was, now]) => was !== now);
    expect(changed).toHaveLength(1);
    expect(changed[0][1].trim()).toBe('"version": "99.0.0",');

    // ...and it is the APP's entry that moved, not the root package's.
    const parsed = JSON.parse(after.join('\n'));
    expect(parsed.packages[KEY].version).toBe('99.0.0');
    expect(parsed.packages[''].version).toBe(JSON.parse(realLock).packages[''].version);
  });

  it('refuses a conflict-marked lock instead of overwriting it', () => {
    const conflicted = realLock.replace(
      /"version": "\d+\.\d+\.\d+"/,
      '<<<<<<< HEAD\n$&\n=======\n"version": "0.0.1"\n>>>>>>> other',
    );

    expect(() => syncLockVersion(conflicted, KEY, '99.0.0')).toThrow(/not valid JSON/);
  });

  it('refuses a lock with no entry for the workspace rather than inventing one', () => {
    const lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': {} } });

    expect(() => syncLockVersion(lock, 'apps/cribl-app', '99.0.0')).toThrow(
      /no packages\["apps\/cribl-app"\] entry/,
    );
  });
});

describe('lockWorkspaceKey', () => {
  it('is the posix key the lock uses, even from a Windows path', () => {
    // path.win32 so this runs the Windows case on the Linux CI runner too:
    // relative() there yields "apps\\cribl-app", which matches no lock key.
    expect(
      lockWorkspaceKey('C:\\repo\\toolkit', 'C:\\repo\\toolkit\\apps\\cribl-app', path.win32),
    ).toBe('apps/cribl-app');
  });

  it('names an entry that exists in the real lock', () => {
    expect(KEY).toBe('apps/cribl-app');
    expect(JSON.parse(realLock).packages[KEY]).toBeDefined();
  });
});
