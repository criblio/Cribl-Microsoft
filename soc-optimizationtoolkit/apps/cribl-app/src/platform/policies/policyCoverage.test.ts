import { describe, expect, it } from 'vitest';
import { checkCoverage, covers, describeReport, isClean, parsePoliciesYml, type ApiCall } from './policyCoverage';

const YML = `
# Product API access for the app.
policies:
  - object: '/master/groups'
    actions: ['GET']
  - object: '/m/:gid/system/inputs'   # the collection
    actions:
      - GET
  - object: "/m/default_search/search/jobs"
    actions: [POST]
`;

const calls: ApiCall[] = [
  { method: 'GET', path: '/master/groups', caller: 'a' },
  { method: 'GET', path: '/m/:gid/system/inputs', caller: 'b' },
  { method: 'POST', path: '/m/default_search/search/jobs', caller: 'c' },
];

describe('parsePoliciesYml', () => {
  it('reads inline and block action lists, quoted and unquoted, ignoring comments', () => {
    expect(parsePoliciesYml(YML)).toEqual([
      { object: '/master/groups', actions: ['GET'] },
      { object: '/m/:gid/system/inputs', actions: ['GET'] },
      { object: '/m/default_search/search/jobs', actions: ['POST'] },
    ]);
  });

  it('refuses a line it does not understand instead of skipping it', () => {
    expect(() => parsePoliciesYml("policies:\n  - object: '/x'\n    verbs: [GET]\n")).toThrow(/line 3/);
  });
});

describe('covers', () => {
  it('matches one segment per :name, never more', () => {
    expect(covers('/m/:gid/system/inputs', '/m/:gid/system/inputs')).toBe(true);
    expect(covers('/m/:gid/system/inputs/:id', '/m/:gid/system/inputs/in_x')).toBe(true);
    expect(covers('/m/:gid/system/inputs', '/m/:gid/system/inputs/in_x')).toBe(false);
    expect(covers('/m/:gid/system/inputs/:id', '/m/:gid/system/inputs/in_x/status')).toBe(false);
  });
});

describe('checkCoverage', () => {
  it('is clean when grants and calls agree', () => {
    const r = checkCoverage(calls, parsePoliciesYml(YML));
    expect(describeReport(r)).toBe('');
    expect(isClean(r)).toBe(true);
  });

  it('reports a call with no grant (the non-admin 403)', () => {
    const r = checkCoverage([...calls, { method: 'PATCH', path: '/m/:gid/system/inputs/:id', caller: 'edit.ts' }], parsePoliciesYml(YML));
    expect(r.undeclared).toHaveLength(1);
    expect(r.undeclared[0]).toMatchObject({ method: 'PATCH', caller: 'edit.ts' });
  });

  it('reports a grant with no call (the over-grant)', () => {
    const r = checkCoverage(calls.slice(0, 2), parsePoliciesYml(YML));
    expect(r.overDeclared).toEqual([{ object: '/m/default_search/search/jobs', action: 'POST' }]);
  });

  it('reports a method granted on a path that is only called with another method', () => {
    const r = checkCoverage(calls, [...parsePoliciesYml(YML), { object: '/master/groups', actions: ['DELETE'] }]);
    expect(r.overDeclared).toEqual([{ object: '/master/groups', action: 'DELETE' }]);
  });

  it('rejects * in paths and actions, and app-scoped declarations', () => {
    const r = checkCoverage(calls, [
      ...parsePoliciesYml(YML),
      { object: '/m/:gid/system/outputs/*', actions: ['GET'] },
      { object: '/m/:gid/pipelines', actions: ['*'] },
      { object: '/kvstore/prefs', actions: ['GET'] },
    ]);
    expect(r.wildcardPaths).toEqual(['/m/:gid/system/outputs/*']);
    expect(r.wildcardActions).toEqual(['/m/:gid/pipelines']);
    expect(r.appScoped).toEqual(['/kvstore/prefs']);
    expect(isClean(r)).toBe(false);
  });
});
