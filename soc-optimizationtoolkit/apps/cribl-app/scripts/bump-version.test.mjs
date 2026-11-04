// Pins for `npm run bump` (DBT-299): the patch number, and that package.json
// and the lock move together exactly as package.mjs moves them.

import { describe, expect, it } from 'vitest';
import { bumpedFiles, nextPatch } from './bump-version.mjs';

const LOCK = JSON.stringify(
  { name: 'soc', lockfileVersion: 3, packages: { '': { name: 'soc' }, 'apps/cribl-app': { name: 'app', version: '1.13.0' } } },
  null,
  2,
);
const MANIFEST = `${JSON.stringify({ name: 'soc-optimizationtoolkit', version: '1.13.0', private: true }, null, 2)}\n`;

describe('nextPatch', () => {
  it('raises only the patch number, numerically', () => {
    expect(nextPatch('1.13.0')).toBe('1.13.1');
    expect(nextPatch('1.13.9')).toBe('1.13.10');
  });

  it('refuses a version that is not X.Y.Z rather than guessing', () => {
    expect(() => nextPatch('1.13')).toThrow(/X\.Y\.Z/);
  });
});

describe('bumpedFiles', () => {
  it('moves package.json and the lock\'s workspace entry to the same next version, and nothing else', () => {
    const out = bumpedFiles(MANIFEST, LOCK, 'apps/cribl-app');
    expect(out.version).toBe('1.13.1');
    expect(JSON.parse(out.manifest)).toEqual({ name: 'soc-optimizationtoolkit', version: '1.13.1', private: true });
    const lock = JSON.parse(out.lock);
    expect(lock.packages['apps/cribl-app'].version).toBe('1.13.1');
    expect(lock.packages['']).toEqual({ name: 'soc' });
  });

  it('throws on a conflict-marked lock before anything is computed for writing', () => {
    expect(() => bumpedFiles(MANIFEST, '<<<<<<< HEAD\n{}', 'apps/cribl-app')).toThrow(/not valid JSON/);
  });
});
