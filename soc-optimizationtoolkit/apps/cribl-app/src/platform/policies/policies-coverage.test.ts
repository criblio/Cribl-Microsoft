/// <reference types="node" />
// policies-coverage.test.ts - config/policies.yml grants exactly what the app calls.
//
// From the cribl-app-kit template (skills/cribl-app-kit/reference/policies/
// policyCoverage.test.template.ts), plus ONE waiver: the wildcard grants that
// predate this test. A '*' path is Undefined in the platform's matcher (one
// segment or a subtree?), so the kit check rejects every one. Replacing them is
// DBT-153; until then each is listed in KNOWN_EXCEPTIONS, and:
//   - the exception list must EQUAL the set of '*' entries in policies.yml, so a
//     fixed wildcard leaves a stale exception (fails) and a new wildcard has none
//     (fails);
//   - a waived wildcard is exempt from both directions: its own over-declared
//     and wildcard-path findings, and any registered call it covers (with '*'
//     read as ONE OR MORE segments, for the waiver only). Those calls are
//     reported as "relies on wildcard" and pinned below, so the list changes
//     only deliberately.
//
// If it fails, read which class:
//   undeclared     a call with no grant - the 403 only non-admins see
//   over-declared  a grant with no call - remove it, or add the call to paths.ts
//   wildcard       '*' in a path or action - name every segment and method
//   app-scoped     /kvstore or /proxy declared - remove it; it is granted with the app

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_CALLS } from './paths';
import {
  checkCoverage,
  covers,
  describeReport,
  isClean,
  parsePoliciesYml,
  type ApiCall,
  type CoverageReport,
  type PolicyEntry,
} from './policyCoverage';

// This file lives at src/platform/policies/ in the app; the app root is three levels up.
const POLICIES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'policies.yml');

interface KnownException {
  object: string;
  cardId: string;
  reason: string;
}

const WILDCARD_CARD = 'DBT-153';

const KNOWN_EXCEPTIONS: readonly KnownException[] = [
  {
    object: '/m/:gid/system/outputs/*',
    cardId: WILDCARD_CARD,
    reason: 'onboard-table verify GET /system/outputs/{id}; should be /m/:gid/system/outputs/:id',
  },
  {
    object: '/m/:gid/packs/*',
    cardId: WILDCARD_CARD,
    reason: 'PlatformPackInstall PATCH/DELETE /packs/{id}; should be /m/:gid/packs/:id',
  },
  {
    object: '/m/:gid/system/secrets/*',
    cardId: WILDCARD_CARD,
    reason: 'ensure-secret PATCH on a 409 (wiring-section, deploy-flowlog-pack); should be /m/:gid/system/secrets/:id',
  },
  {
    object: '/m/:gid/search/jobs/*',
    cardId: WILDCARD_CARD,
    reason: 'search job status and results pages; should be /m/:gid/search/jobs/:id/status and .../results',
  },
];

/** The registered calls a waived wildcard is the ONLY grant for. Pinned: changes are deliberate. */
const RELIES_ON_WILDCARD: readonly string[] = [
  'DELETE /m/:gid/packs/:id',
  'GET /m/:gid/search/jobs/:id/results',
  'GET /m/:gid/search/jobs/:id/status',
  'GET /m/:gid/system/outputs/:id',
  'PATCH /m/:gid/packs/:id',
  'PATCH /m/:gid/system/secrets/:id',
];

const segs = (p: string) => p.split('/').filter(Boolean);

/** Waiver-only matching: '*' is one or more segments, ':name' one segment (either side). */
function wildcardCovers(object: string, path: string): boolean {
  const a = segs(object);
  const b = segs(path);
  const go = (i: number, j: number): boolean => {
    if (i === a.length) return j === b.length;
    if (a[i] === '*') {
      for (let k = j + 1; k <= b.length; k += 1) if (go(i + 1, k)) return true;
      return false;
    }
    if (j === b.length) return false;
    const ok = a[i] === b[j] || a[i]!.startsWith(':') || b[j]!.startsWith(':');
    return ok && go(i + 1, j + 1);
  };
  return go(0, 0);
}

const isWildcard = (p: PolicyEntry) => p.object.includes('*') || p.actions.includes('*');

interface WaivedReport {
  report: CoverageReport;
  reliesOnWildcard: string[];
}

/** The kit report with the KNOWN_EXCEPTIONS waived, both directions. */
function waive(
  calls: readonly ApiCall[],
  policies: readonly PolicyEntry[],
  exceptions: readonly KnownException[],
): WaivedReport {
  const waived = new Set(exceptions.map((e) => e.object));
  const waivedEntries = policies.filter((p) => waived.has(p.object));
  const literal = policies.filter((p) => !waived.has(p.object));
  const base = checkCoverage(calls, policies);
  const coveredBy = (entries: readonly PolicyEntry[], c: ApiCall, match: (o: string, p: string) => boolean) =>
    entries.some((p) => match(p.object, c.path) && (p.actions.includes(c.method) || p.actions.includes('*')));

  const reliesOnWildcard: string[] = [];
  for (const c of calls) {
    if (!coveredBy(literal, c, covers) && coveredBy(waivedEntries, c, wildcardCovers)) {
      reliesOnWildcard.push(`${c.method} ${c.path}`);
    }
  }
  const report: CoverageReport = {
    undeclared: base.undeclared.filter((c) => !coveredBy(waivedEntries, c, wildcardCovers)),
    overDeclared: base.overDeclared.filter((o) => !waived.has(o.object)),
    wildcardPaths: base.wildcardPaths.filter((w) => !waived.has(w)),
    wildcardActions: base.wildcardActions.filter((w) => !waived.has(w)),
    appScoped: base.appScoped,
  };
  return { report, reliesOnWildcard: [...new Set(reliesOnWildcard)].sort() };
}

const POLICY_TEXT = readFileSync(POLICIES, 'utf8');
const policies = parsePoliciesYml(POLICY_TEXT);

describe('config/policies.yml grants exactly what the app calls', () => {
  it('parses a realistic number of grants (guards against a wrong path reading nothing)', () => {
    expect(policies.length).toBeGreaterThan(25);
  });

  it('has no undeclared, over-declared, wildcard or app-scoped entries beyond KNOWN_EXCEPTIONS', () => {
    const { report } = waive(API_CALLS, policies, KNOWN_EXCEPTIONS);
    expect(describeReport(report)).toBe('');
    expect(isClean(report)).toBe(true);
  });

  it('KNOWN_EXCEPTIONS equals the set of wildcard entries actually in policies.yml', () => {
    const wild = policies.filter(isWildcard).map((p) => p.object).sort();
    expect(KNOWN_EXCEPTIONS.map((e) => e.object).sort()).toEqual(wild);
    expect(wild).toContain('/m/:gid/search/jobs/*');
    for (const e of KNOWN_EXCEPTIONS) expect(e.cardId).toBe(WILDCARD_CARD);
  });

  it('reports exactly the calls that rely on a waived wildcard', () => {
    expect(waive(API_CALLS, policies, KNOWN_EXCEPTIONS).reliesOnWildcard).toEqual(RELIES_ON_WILDCARD);
  });

  it('declares the AZR-33/AZR-34 grants exactly (ADR 0007 D11)', () => {
    const actions = (object: string) => policies.find((p) => p.object === object)?.actions;
    expect(actions('/m/:gid/system/inputs')).toEqual(['GET', 'POST']);
    expect(actions('/m/:gid/system/inputs/:id')).toEqual(['GET']);
    expect(actions('/m/:gid/system/secrets/:id')).toEqual(['GET']);
    expect(actions('/m/:gid/version/status')).toEqual(['GET']);
    expect(actions('/m/:gid/version')).toEqual(['GET']);
    expect(actions('/m/:gid/system/metrics/query')).toEqual(['POST']);
    expect(actions('/products/stream/groups/:id/deploy')).toEqual(['PATCH']);
    expect(actions('/products/stream/groups/:id')).toEqual(['GET']);
    // The kit's 404 fallbacks stay granted.
    expect(actions('/master/groups/:id')).toEqual(['GET']);
    expect(actions('/master/groups/:id/deploy')).toEqual(['PATCH']);
    // Create-only: no input write beyond POST anywhere.
    const inputWrites = policies.filter(
      (p) => /\/system\/inputs/.test(p.object) && p.actions.some((a) => a === 'PATCH' || a === 'PUT' || a === 'DELETE'),
    );
    expect(inputWrites).toEqual([]);
  });
});

describe('the coverage check bites (mutations of the real file)', () => {
  const clean = (ps: PolicyEntry[], ex: readonly KnownException[] = KNOWN_EXCEPTIONS) => isClean(waive(API_CALLS, ps, ex).report);
  const without = (object: string, action: string): PolicyEntry[] =>
    policies.map((p) => (p.object === object ? { ...p, actions: p.actions.filter((a) => a !== action) } : p));

  it('removing the inputs POST fails it', () => {
    expect(clean(without('/m/:gid/system/inputs', 'POST'))).toBe(false);
  });

  it('removing the products deploy PATCH fails it', () => {
    expect(clean(without('/products/stream/groups/:id/deploy', 'PATCH'))).toBe(false);
  });

  it('adding an unused grant fails it', () => {
    expect(clean([...policies, { object: '/m/:gid/system/inputs/:id', actions: ['DELETE'] }])).toBe(false);
  });

  it("removing '/m/:gid/search/jobs/*' from the exception list fails it", () => {
    const ex = KNOWN_EXCEPTIONS.filter((e) => e.object !== '/m/:gid/search/jobs/*');
    expect(clean(policies, ex)).toBe(false);
  });

  it('wildcardCovers reads * as one or more segments, never zero', () => {
    expect(wildcardCovers('/m/:gid/search/jobs/*', '/m/:gid/search/jobs/:id/status')).toBe(true);
    expect(wildcardCovers('/m/:gid/search/jobs/*', '/m/:gid/search/jobs/:id')).toBe(true);
    expect(wildcardCovers('/m/:gid/search/jobs/*', '/m/:gid/search/jobs')).toBe(false);
    expect(wildcardCovers('/m/:gid/packs/*', '/m/:gid/routes/x')).toBe(false);
  });
});
