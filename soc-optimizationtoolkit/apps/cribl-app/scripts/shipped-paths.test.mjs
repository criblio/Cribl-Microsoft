// Pins for the ONE definition of "this changes the app" (architecture audit
// 2026-11-04): the version-bump gate and the release check's unreleased-source
// count both read it, so they cannot disagree about the same commit.

import { describe, expect, it } from 'vitest';
import { SHIPPED_PATH_PREFIXES, compareVersions, isShippedPath, shippedPathspecs } from './shipped-paths.mjs';

describe('shippedPathspecs', () => {
  it('is every shipped prefix as a git pathspec, plus the test and markdown exclusions', () => {
    const specs = shippedPathspecs();
    const includes = specs.filter((s) => !s.startsWith(':('));
    expect(includes).toEqual(SHIPPED_PATH_PREFIXES.map((p) => p.replace(/\/$/, '')));
    expect(specs).toContain(':(glob,exclude)**/*.test.*');
    expect(specs).toContain(':(glob,exclude)**/*.md');
  });
});

describe('isShippedPath and the pathspecs agree on the cases that differ from a bare prefix match', () => {
  it('excludes a test file and a CONTEXT.md under packages/', () => {
    expect(isShippedPath('soc-optimizationtoolkit/packages/core/src/a.test.ts')).toBe(false);
    expect(isShippedPath('soc-optimizationtoolkit/packages/core/CONTEXT.md')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders X.Y.Z numerically, so 1.13.10 is above 1.13.9 and 1.12.0 above 1.9.0', () => {
    expect(compareVersions('1.13.10', '1.13.9')).toBeGreaterThan(0);
    expect(compareVersions('1.12.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.13.0', '1.13.0')).toBe(0);
    expect(compareVersions('1.13.0', '2.0.0')).toBeLessThan(0);
  });
});
