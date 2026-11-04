// Pins for the version-bump gate (DBT-251). The pure half is stated as facts:
// main's version, this branch's version, and the paths the PR changed.

import { describe, expect, it } from 'vitest';
import { SHIPPED_PATH_PREFIXES, evaluateVersionBump, isShippedPath, parseArgs } from './check-version-bump.mjs';

const APP_SRC = 'soc-optimizationtoolkit/apps/cribl-app/src/App.tsx';
const facts = (overrides) => ({
  baseVersion: '1.13.0',
  headVersion: '1.13.1',
  changedPaths: [APP_SRC],
  ...overrides,
});

describe('evaluateVersionBump', () => {
  it('passes a PR that changes the app and raises the patch version', () => {
    const result = evaluateVersionBump(facts());
    expect(result.errors).toEqual([]);
    expect(result.required).toBe(true);
  });

  it('FAILS a PR that changes the app but leaves the version at main\'s, naming both and the command', () => {
    const result = evaluateVersionBump(facts({ headVersion: '1.13.0' }));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('1.13.0');
    expect(result.errors[0]).toContain('npm run bump');
    expect(result.errors[0]).toContain(APP_SRC);
  });

  it('FAILS a version BELOW main\'s, compared numerically (1.13.9 is below 1.13.10)', () => {
    const result = evaluateVersionBump(facts({ baseVersion: '1.13.10', headVersion: '1.13.9' }));
    expect(result.errors).toHaveLength(1);
  });

  it('accepts a minor or major bump as above main', () => {
    expect(evaluateVersionBump(facts({ headVersion: '1.14.0' })).errors).toEqual([]);
    expect(evaluateVersionBump(facts({ headVersion: '2.0.0' })).errors).toEqual([]);
  });

  it('requires no bump for a docs, board or test-only PR, and says so rather than staying silent', () => {
    const result = evaluateVersionBump(
      facts({
        headVersion: '1.13.0',
        changedPaths: [
          'soc-optimizationtoolkit/docs/board.json',
          'soc-optimizationtoolkit/docs/adr/0009-multi-tenant-azure.md',
          'soc-optimizationtoolkit/packages/core/src/domain/tenancy/tenancy.test.ts',
          'soc-optimizationtoolkit/apps/cribl-app/scripts/board.mjs',
          'CLAUDE.md',
        ],
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.required).toBe(false);
    expect(result.notes.join(' ')).toMatch(/no bump required/);
  });

  it('counts only the first ten changed files in the message, and says how many more', () => {
    const many = Array.from({ length: 14 }, (_, i) => `soc-optimizationtoolkit/packages/ui/src/f${i}.tsx`);
    const result = evaluateVersionBump(facts({ headVersion: '1.13.0', changedPaths: many }));
    expect(result.errors[0]).toContain('f9.tsx');
    expect(result.errors[0]).not.toContain('f10.tsx');
    expect(result.errors[0]).toContain('and 4 more');
  });

  it('errors on a version that is not X.Y.Z instead of guessing', () => {
    expect(evaluateVersionBump(facts({ headVersion: '1.13' })).errors[0]).toMatch(/not X\.Y\.Z/);
    expect(evaluateVersionBump(facts({ baseVersion: 'abc' })).errors[0]).toMatch(/not X\.Y\.Z/);
  });
});

describe('isShippedPath - what ships, or what Live Preview shows', () => {
  it.each([
    'soc-optimizationtoolkit/packages/core/src/domain/tenancy/tenancy.ts',
    'soc-optimizationtoolkit/packages/ui/src/styles.css',
    'soc-optimizationtoolkit/apps/cribl-app/src/App.tsx',
    'soc-optimizationtoolkit/apps/cribl-app/config/policies.yml',
    'soc-optimizationtoolkit/apps/cribl-app/public/icon.svg',
    'soc-optimizationtoolkit/apps/cribl-app/index.html',
    'soc-optimizationtoolkit/apps/cribl-app/vite.config.ts',
    'soc-optimizationtoolkit/apps/cribl-app/package.json',
    'soc-optimizationtoolkit/package.json',
    'soc-optimizationtoolkit/package-lock.json',
  ])('counts %s', (path) => {
    expect(isShippedPath(path)).toBe(true);
  });

  it.each([
    'soc-optimizationtoolkit/docs/board.json',
    'soc-optimizationtoolkit/docs/release-notes.md',
    'soc-optimizationtoolkit/apps/cribl-app/scripts/package.mjs',
    'soc-optimizationtoolkit/apps/cribl-app/release/soc-optimizationtoolkit-1.13.0.tgz',
    'soc-optimizationtoolkit/apps/cribl-app/src/App.test.tsx',
    'soc-optimizationtoolkit/packages/ui/src/screens/x/x.dom.test.tsx',
    'soc-optimizationtoolkit/packages/core/src/domain/a/a.test.ts',
    'soc-optimizationtoolkit/packages/core/CONTEXT.md',
    '.github/workflows/soc-toolkit-ci.yml',
    'Azure/CustomDeploymentTemplates/DCR-Templates/x.json',
  ])('does not count %s', (path) => {
    expect(isShippedPath(path)).toBe(false);
  });

  it('names its prefixes from the repo root, so a moved workspace fails here rather than passing everything', () => {
    for (const prefix of SHIPPED_PATH_PREFIXES) {
      expect(prefix.startsWith('soc-optimizationtoolkit/'), prefix).toBe(true);
    }
  });
});

describe('parseArgs', () => {
  it('defaults the base to origin/main and takes --base', () => {
    expect(parseArgs([], {})).toEqual({ base: 'origin/main', enforce: true });
    expect(parseArgs(['--base', 'origin/release'], {})).toEqual({ base: 'origin/release', enforce: false });
  });

  it('reads the PR base from GITHUB_BASE_REF, and enforces only for main', () => {
    expect(parseArgs([], { GITHUB_BASE_REF: 'main' })).toEqual({ base: 'origin/main', enforce: true });
    expect(parseArgs([], { GITHUB_BASE_REF: 'feature/x' })).toEqual({ base: 'origin/feature/x', enforce: false });
  });
});
