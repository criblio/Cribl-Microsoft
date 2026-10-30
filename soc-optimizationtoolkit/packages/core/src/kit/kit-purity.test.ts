// Core is pure: no clock, no timers, no randomness, no crypto (repo CLAUDE.md). The
// claude-kit transport this folder stands in for defines `systemClock` (Date.now and
// setTimeout), so an over-eager re-copy or a `kitDrift sync` of it would quietly put a
// clock into core. This scan is what makes that a red test rather than a review catch.
//
// It covers the kit folder AND the folders the Azure onboarding How-to slice adds, so
// each later unit's file joins the scan the moment it exists. A folder that does not
// exist yet is skipped, not failed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SourceFile {
  path: string;
  text: string;
}

interface Impurity {
  path: string;
  line: number;
  rule: string;
  text: string;
}

const RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: 'Date.now', re: /\bDate\s*\.\s*now\b/ },
  { rule: 'new Date(', re: /\bnew\s+Date\s*\(/ },
  { rule: 'setTimeout', re: /\bsetTimeout\b/ },
  { rule: 'setInterval', re: /\bsetInterval\b/ },
  { rule: 'Math.random', re: /\bMath\s*\.\s*random\b/ },
  { rule: 'crypto.', re: /\bcrypto\s*\./ },
  { rule: 'crypto import', re: /from\s+['"](?:node:)?crypto['"]/ },
  { rule: 'systemClock', re: /\bsystemClock\b/ },
];

/**
 * Blank out comments, keeping line breaks so line numbers survive. String and template
 * literals are KEPT: a pattern inside a string is reported too, which errs towards red.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

const isTestFile = (path: string) => /\.test(-util)?\.tsx?$/.test(path) || /\.dom\.test\.tsx?$/.test(path);

/** Pure: every impure construct in the non-test files given. */
function findImpurities(files: readonly SourceFile[]): Impurity[] {
  const found: Impurity[] = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const lines = stripComments(f.text).split('\n');
    lines.forEach((line, idx) => {
      for (const { rule, re } of RULES) {
        if (re.test(line)) found.push({ path: f.path, line: idx + 1, rule, text: line.trim() });
      }
    });
  }
  return found;
}

describe('findImpurities', () => {
  it('flags Date.now and a systemClock import, and passes a clean file', () => {
    expect(findImpurities([{ path: 'a.ts', text: 'export const t = () => Date.now();\n' }])).toEqual([
      { path: 'a.ts', line: 1, rule: 'Date.now', text: 'export const t = () => Date.now();' },
    ]);
    expect(findImpurities([{ path: 'b.ts', text: "import { systemClock } from './transport';\n" }]).map((i) => i.rule)).toEqual(['systemClock']);
    expect(findImpurities([{ path: 'c.ts', text: 'export const isOk = (s: number) => s >= 200 && s < 300;\n' }])).toEqual([]);
  });

  it('flags every rule', () => {
    const text = [
      'new Date()',
      'setTimeout(f, 1)',
      'setInterval(f, 1)',
      'Math.random()',
      'crypto.randomUUID()',
      "import { createHash } from 'node:crypto';",
    ].join('\n');
    expect(findImpurities([{ path: 'd.ts', text }]).map((i) => [i.line, i.rule])).toEqual([
      [1, 'new Date('],
      [2, 'setTimeout'],
      [3, 'setInterval'],
      [4, 'Math.random'],
      [5, 'crypto.'],
      [6, 'crypto import'],
    ]);
  });

  it('ignores comments and test files, keeps line numbers across block comments', () => {
    const text = '// Date.now is banned\n/* setTimeout\n systemClock */\nconst x = "a//b"; Math.random();\n';
    expect(findImpurities([{ path: 'e.ts', text }]).map((i) => [i.line, i.rule])).toEqual([[4, 'Math.random']]);
    expect(findImpurities([{ path: 'e.test.ts', text: 'Date.now()' }, { path: 'f.test-util.ts', text: 'Date.now()' }])).toEqual([]);
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Folders, relative to packages/core/src, whose code must stay pure. Prefix entries end in '*'. */
const SCANNED: readonly string[] = [
  'kit',
  'domain/onboarding-*',
  'domain/cribl-onboarding-source',
  'usecases/create-cribl-source',
  'usecases/validate-azure-onboarding',
  'usecases/read-source-flow',
];

function expand(entry: string): string[] {
  if (!entry.endsWith('*')) return existsSync(join(SRC, entry)) ? [entry] : [];
  const parent = dirname(entry);
  const prefix = entry.slice(parent.length + 1, -1);
  const dir = join(SRC, parent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && statSync(join(dir, n)).isDirectory())
    .map((n) => `${parent}/${n}`);
}

function walk(dir: string, out: SourceFile[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push({ path: relative(SRC, full).split('\\').join('/'), text: readFileSync(full, 'utf8') });
  }
}

describe('kit and onboarding folders are pure', () => {
  const files: SourceFile[] = [];
  for (const entry of SCANNED) for (const folder of expand(entry)) walk(join(SRC, folder), files);

  it('scans the local transport and the adopted kit files', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toContain('kit/config-writes/transport.ts');
    expect(paths).toContain('kit/config-writes/commitDeploy.ts');
    expect(paths).toContain('kit/metrics/metricsQuery.ts');
    expect(paths).toContain('kit/cribl-request.ts');
  });

  it('finds no clock, timer, randomness or crypto in any non-test file', () => {
    expect(findImpurities(files)).toEqual([]);
  });
});
