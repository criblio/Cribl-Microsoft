import { describe, expect, it } from 'vitest';
import { fakeRequest } from './fakes.test-util';
import {
  MissingArrayElementError,
  UndeclaredArrayError,
  deepMerge,
  diffRows,
  idOrderProblem,
  planChange,
  sameDiff,
  verifyStored,
  writeApproved,
  type ArrayPolicy,
  type FreshCheck,
  type WriteTarget,
} from './readModifyWrite';
import { commitAndDeploy, commitDeployStep, commitScope, commitScopeGrew, deployGroup, observeCommitDeploy, sameCommit } from './commitDeploy';
import { provePackOwnership, proveOwnership, stampDescription, teardownOrder } from './ownership';
import type { Request } from './transport';

const TARGET: WriteTarget = { path: '/search/saved/s1', method: 'PATCH' };

describe('merge', () => {
  it('merges nested objects so a sub-object keeps its other fields (measured: tz and keepLastN lost)', () => {
    const current = { id: 's1', schedule: { enabled: true, cronSchedule: '0 4 * * *', tz: 'UTC', keepLastN: 2 }, vendorField: 'x' };
    const merged = deepMerge(current, { schedule: { enabled: false } }) as typeof current;
    expect(merged.schedule).toEqual({ enabled: false, cronSchedule: '0 4 * * *', tz: 'UTC', keepLastN: 2 });
    expect(merged.vendorField).toBe('x');
  });

  it('refuses an array with no declared policy', () => {
    expect(() => deepMerge({ tags: ['a'] }, { tags: ['b'] })).toThrow(UndeclaredArrayError);
    expect(deepMerge({ tags: ['a'] }, { tags: ['b'] }, { tags: { kind: 'replace' } })).toEqual({ tags: ['b'] });
  });

  it('merges a shared list by id, keeping elements it does not own', () => {
    const merged = deepMerge(
      { routes: [{ id: 'theirs', final: true }, { id: 'mine', final: true }] },
      { routes: [{ id: 'mine', final: false }] },
      { routes: { kind: 'byId', idKey: 'id' } },
    );
    expect(merged).toEqual({ routes: [{ id: 'theirs', final: true }, { id: 'mine', final: false }] });
  });
});

describe('shared lists', () => {
  const byId: Record<string, ArrayPolicy> = { routes: { kind: 'byId', idKey: 'id' } };
  const table = { routes: [{ id: 'a', disabled: false }, { id: 'b', disabled: false, filter: 'x' }] };

  it('a byId change naming a missing id throws instead of appending it back (unless allowAppend)', () => {
    expect(() => deepMerge(table, { routes: [{ id: 'gone', disabled: true }] }, byId)).toThrow(MissingArrayElementError);
    expect(() => deepMerge(table, { routes: [{ disabled: true }] }, byId)).toThrow(MissingArrayElementError);
    const appended = deepMerge(table, { routes: [{ id: 'c' }] }, { routes: { kind: 'byId', idKey: 'id', allowAppend: true } }) as typeof table;
    expect(appended.routes.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('diffs a byId list per element, keyed by id, and a replace list of equal length by index', () => {
    const after = { routes: [{ id: 'a', disabled: false }, { id: 'b', disabled: true, filter: 'x' }] };
    expect(diffRows(table, after, byId)).toEqual([{ path: 'routes[id=b].disabled', from: false, to: true }]);
    const fns = { conf: { functions: [{ id: 'eval' }, { id: 'eval', disabled: false }] } };
    const fnsAfter = { conf: { functions: [{ id: 'eval' }, { id: 'eval', disabled: true }] } };
    expect(diffRows(fns, fnsAfter, { 'conf.functions': { kind: 'replace' } })).toEqual([{ path: 'conf.functions[1].disabled', from: false, to: true }]);
    // Undeclared: one whole row.
    expect(diffRows(table, after).map((r) => r.path)).toEqual(['routes']);
  });

  it('a reorder, an add or a remove is one whole-list row, never an empty diff', () => {
    const reordered = { routes: [table.routes[1], table.routes[0]] };
    expect(diffRows(table, reordered, byId)).toEqual([{ path: 'routes', from: table.routes, to: reordered.routes }]);
    expect(diffRows(table, { routes: [table.routes[0]] }, byId).map((r) => r.path)).toEqual(['routes']);
    const fns = { f: [{ id: 'x' }] };
    expect(diffRows(fns, { f: [{ id: 'x' }, { id: 'y' }] }, { f: { kind: 'replace' } }).map((r) => r.path)).toEqual(['f']);
  });

  it('idOrderProblem names a byId list whose ids moved', () => {
    expect(idOrderProblem(table, table, byId)).toBeNull();
    expect(idOrderProblem(table, { routes: [table.routes[1], table.routes[0]] }, byId)).toBe('routes');
    expect(idOrderProblem(table, { routes: [table.routes[0]] }, byId)).toBe('routes');
    expect(idOrderProblem(table, { routes: [...table.routes, { id: 'c' }] }, { routes: { kind: 'byId', idKey: 'id', allowAppend: true } })).toBeNull();
  });

  it('writeApproved voids, writing nothing, when the approved element was deleted while the dialog was open', async () => {
    let reads = 0;
    const target: WriteTarget = { path: '/m/g/routes/default', method: 'PATCH', arrays: byId };
    const { request, calls } = fakeRequest(({ method }) => {
      if (method !== 'GET') return { status: 200, body: {} };
      reads++;
      return { status: 200, body: { items: [reads === 1 ? table : { routes: [table.routes[0]] }] } };
    });
    const changes = { routes: [{ id: 'b', disabled: true }] };
    const plan = await planChange(request, target, changes);
    expect(plan.kind === 'planned' && plan.diff).toEqual([{ path: 'routes[id=b].disabled', from: false, to: true }]);
    const out = await writeApproved(request, target, changes, plan.kind === 'planned' ? plan.diff : []);
    expect(out).toMatchObject({ kind: 'void', missing: expect.stringMatching(/"routes" no longer holds an element with id "b"/) });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('writeApproved still writes a byId change whose element is present, keeping the others in place', async () => {
    const target: WriteTarget = { path: '/m/g/routes/default', method: 'PATCH', arrays: byId };
    const { request, calls } = fakeRequest(({ method }) => (method === 'GET' ? { status: 200, body: { items: [table] } } : { status: 200, body: {} }));
    const changes = { routes: [{ id: 'b', disabled: true }] };
    const plan = await planChange(request, target, changes);
    const out = await writeApproved(request, target, changes, plan.kind === 'planned' ? plan.diff : []);
    expect(out.kind).toBe('written');
    expect(calls[2]!.options!.body).toEqual({ routes: [{ id: 'a', disabled: false }, { id: 'b', disabled: true, filter: 'x' }] });
  });

  const target: WriteTarget = { path: '/m/g/routes/default', method: 'PATCH', arrays: byId };
  const changes = { routes: [{ id: 'b', disabled: true }] };
  const readsBack = (obj: unknown) => fakeRequest(() => ({ status: 200, body: { items: [obj] } })).request;

  it('verifyStored compares only the named fields, per element: another admin editing a different element is still stored', async () => {
    const after = { routes: [{ id: 'a', disabled: true, filter: 'theirs' }, { id: 'b', disabled: true, filter: 'x' }, { id: 'c' }] };
    expect(await verifyStored(readsBack(after), target, changes)).toEqual({ kind: 'stored' });
  });

  it('verifyStored reports a field Cribl reset after a 200 as a mismatch: stored value in from, sent value in to', async () => {
    const after = { routes: [{ id: 'a', disabled: false }, { id: 'b', disabled: false, filter: 'x' }] };
    expect(await verifyStored(readsBack(after), target, changes)).toEqual({
      kind: 'mismatch',
      mismatches: [{ path: 'routes[id=b].disabled', from: false, to: true }],
    });
  });

  it('verifyStored: an element gone from the read-back is missing-element, an unreadable read is unreadable — never stored', async () => {
    expect((await verifyStored(readsBack({ routes: [table.routes[0]] }), target, changes)).kind).toBe('missing-element');
    const down = fakeRequest(() => ({ status: 503, body: 'down' })).request;
    expect(await verifyStored(down, target, changes)).toEqual({ kind: 'unreadable', response: { status: 503, body: 'down' } });
  });

  it('verifyStored: a read-back that rejects (network, timeout) is read-failed, not a thrown error', async () => {
    const boom = new TypeError('Failed to fetch');
    const rejecting: Request = async () => {
      throw boom;
    };
    expect(await verifyStored(rejecting, target, changes)).toEqual({ kind: 'read-failed', error: boom });
  });
});

describe('confirm-then-write', () => {
  const stored = { id: 's1', query: 'q', schedule: { enabled: true, tz: 'UTC' }, lastModified: 1 };

  it('re-reads after approval and sends the FULL merged fresh body', async () => {
    const { request, calls } = fakeRequest(({ method }) => (method === 'GET' ? { status: 200, body: { items: [stored] } } : { status: 200, body: {} }));
    const plan = await planChange(request, TARGET, { schedule: { enabled: false } });
    expect(plan.kind).toBe('planned');
    const out = await writeApproved(request, TARGET, { schedule: { enabled: false } }, plan.kind === 'planned' ? plan.diff : []);
    expect(out.kind).toBe('written');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(calls[2]!.options!.body).toEqual({ ...stored, schedule: { enabled: false, tz: 'UTC' } });
  });

  it('VOIDS when another admin changed what the dialog described, even in the "safe" direction', async () => {
    let reads = 0;
    const { request, calls } = fakeRequest(({ method }) => {
      if (method !== 'GET') return { status: 200, body: {} };
      reads++;
      return { status: 200, body: { items: [reads === 1 ? { ...stored, retention: 30 } : { ...stored, retention: 60 }] } };
    });
    const plan = await planChange(request, TARGET, { retention: 10 });
    const out = await writeApproved(request, TARGET, { retention: 10 }, plan.kind === 'planned' ? plan.diff : []);
    expect(out.kind).toBe('void');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does not void when only a server-derived field moved', async () => {
    let reads = 0;
    const { request } = fakeRequest(({ method }) => {
      if (method !== 'GET') return { status: 200, body: {} };
      reads++;
      return { status: 200, body: { items: [{ ...stored, lastModified: reads }] } };
    });
    const plan = await planChange(request, TARGET, { query: 'q2' });
    const out = await writeApproved(request, TARGET, { query: 'q2' }, plan.kind === 'planned' ? plan.diff : []);
    expect(out.kind).toBe('written');
  });

  it('reports already-applied when someone set exactly the target value', async () => {
    let reads = 0;
    const { request, calls } = fakeRequest(({ method }) => {
      if (method !== 'GET') return { status: 200, body: {} };
      reads++;
      return { status: 200, body: { items: [reads === 1 ? stored : { ...stored, query: 'q2' }] } };
    });
    const plan = await planChange(request, TARGET, { query: 'q2' });
    expect((await writeApproved(request, TARGET, { query: 'q2' }, plan.kind === 'planned' ? plan.diff : [])).kind).toBe('already-applied');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('strips only declared server-owned keys and audits what was sent', async () => {
    const { request, calls } = fakeRequest(({ method }) =>
      method === 'GET' ? { status: 200, body: { items: [{ ...stored, user: 'someone' }] } } : { status: 200, body: {} },
    );
    const target = { ...TARGET, serverOwned: { user: 'server keeps its own (measured)' } };
    const plan = await planChange(request, target, { query: 'q2' });
    const out = await writeApproved(request, target, { query: 'q2' }, plan.kind === 'planned' ? plan.diff : []);
    expect(calls[2]!.options!.body).not.toHaveProperty('user');
    expect(calls[2]!.options!.body).toHaveProperty('lastModified');
    expect(out.kind === 'written' && out.audit.some((r) => r.path === 'query')).toBe(true);
  });

  it('two-phase checks: async preparation before writeApproved, only a synchronous check between the re-read and the write', async () => {
    const order: string[] = [];
    let reads = 0;
    const { request, calls } = fakeRequest(({ method }) => {
      order.push(method);
      if (method !== 'GET') return { status: 200, body: {} };
      reads++;
      // Another admin saves a field while the preparation runs: the re-read carries it into the write.
      return { status: 200, body: { items: [reads === 1 ? stored : { ...stored, description: 'theirs' }] } };
    });
    const plan = await planChange(request, TARGET, { query: 'q2' });
    // Phase 1, before writeApproved: anything that needs a request of its own.
    const prepared = await Promise.resolve({ owner: 'this-app' });
    const check: FreshCheck = (fresh) => {
      order.push('check');
      return fresh.id === 's1' && prepared.owner === 'this-app' ? null : 'not ours';
    };
    const out = await writeApproved(request, TARGET, { query: 'q2' }, plan.kind === 'planned' ? plan.diff : [], undefined, check);
    expect(out.kind).toBe('written');
    expect(order).toEqual(['GET', 'GET', 'check', 'PATCH']);
    expect(calls[2]!.options!.body).toMatchObject({ query: 'q2', description: 'theirs' });
  });

  it('a FreshCheck that refuses, throws, or returns a promise writes nothing', async () => {
    const refusing: FreshCheck[] = [
      () => 'the record says another app owns this',
      () => {
        throw new Error('boom');
      },
      // A promise is never awaited: awaiting it would put a request between the re-read and the write.
      (() => Promise.resolve(null)) as unknown as FreshCheck,
    ];
    for (const check of refusing) {
      const { request, calls } = fakeRequest(({ method }) => (method === 'GET' ? { status: 200, body: { items: [stored] } } : { status: 200, body: {} }));
      const plan = await planChange(request, TARGET, { query: 'q2' });
      const out = await writeApproved(request, TARGET, { query: 'q2' }, plan.kind === 'planned' ? plan.diff : [], undefined, check);
      expect(out.kind).toBe('refused-before-write');
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    }
    const { request } = fakeRequest(({ method }) => (method === 'GET' ? { status: 200, body: { items: [stored] } } : { status: 200, body: {} }));
    const out = await writeApproved(request, TARGET, { query: 'q2' }, [{ path: 'query', from: 'q', to: 'q2' }], undefined, refusing[2]);
    expect(out).toMatchObject({ kind: 'refused-before-write', reason: expect.stringMatching(/returned a promise/) });
  });

  it('compares diffs, not bodies', () => {
    const a = diffRows({ x: 1, y: 1 }, { x: 2, y: 1 });
    const b = diffRows({ x: 1, y: 9 }, { x: 2, y: 9 });
    expect(sameDiff(a, b)).toBe(true);
  });
});

describe('commit and deploy', () => {
  it('compares configVersion by prefix (measured: short hash vs full HEAD)', () => {
    expect(sameCommit('a1b2c3d', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe(true);
    expect(sameCommit('A1B2C3D4E5F6', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe(true);
    expect(sameCommit('a1b2c3', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe(false);
    expect(sameCommit('aaaaaaa', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe(false);
  });

  it('falls back to the deprecated deploy path only on 404', async () => {
    for (const status of [403, 500, 200]) {
      const { request, calls } = fakeRequest(() => ({ status, body: {} }));
      expect((await deployGroup(request, 'default', 'abc1234')).route).toBe('products');
      expect(calls).toHaveLength(1);
    }
    const { request, calls } = fakeRequest(({ path }) => ({ status: path.startsWith('/products') ? 404 : 403, body: {} }));
    const r = await deployGroup(request, 'default', 'abc1234');
    expect(calls.map((c) => c.path)).toEqual(['/products/stream/groups/default/deploy', '/master/groups/default/deploy']);
    // The caller is told the master path answered, so a 403 latches and is worded for that path.
    expect(r).toEqual({ response: { status: 403, body: {} }, route: 'master' });
  });

  const MINE = 'groups/default/local/cribl/inputs.yml';
  const M = ['local/cribl/inputs.yml'];
  const dirty = { status: 200, body: { items: [{ modified: [MINE] }] } };
  /** GET /version?offset=0&limit=1: the newest commit first (OpenAPI 4.19.0 PaginatedGitLogResult). */
  const head = (hash: string) => ({ status: 200, body: { items: [{ hash, refs: 'HEAD -> main' }], count: 1 } });

  it('a commit that answers 200 without a hash is committed-unknown-hash, not nothing-to-commit, and is not deployed', async () => {
    const { request, calls } = fakeRequest(({ method, path }) => {
      if (path === '/version/status') return dirty;
      if (method === 'POST') return { status: 200, body: { items: [{}] } };
      return { status: 200, body: {} };
    });
    const out = await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' });
    expect(out).toEqual({ kind: 'committed-unknown-hash', response: { status: 200, body: { items: [{}] } } });
    expect(calls.some((c) => c.path.endsWith('/deploy'))).toBe(false);
  });

  it('a failed status read before committing is status-unknown, not nothing-to-commit, and commits nothing', async () => {
    const { request, calls } = fakeRequest(({ path }) => (path === '/version/status' ? { status: 403, body: {} } : { status: 200, body: {} }));
    const out = await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' });
    expect(out).toEqual({ kind: 'status-unknown', response: { status: 403, body: {} } });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a failed status re-read after committing is unverified, not deployed', async () => {
    let statusReads = 0;
    const { request, calls } = fakeRequest(({ method, path }) => {
      if (path === '/version/status') return ++statusReads === 1 ? dirty : { status: 500, body: 'boom' };
      if (method === 'POST') return { status: 200, body: { items: [{ commit: 'abc1234def' }] } };
      return { status: 200, body: {} };
    });
    const out = await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' });
    expect(out).toEqual({ kind: 'unverified', hash: 'abc1234def', response: { status: 500, body: 'boom' } });
    expect(calls.some((c) => c.path.endsWith('/deploy'))).toBe(false);
  });

  it('a clean status read is nothing-to-commit; a clean re-read deploys the commit', async () => {
    const clean = fakeRequest(() => ({ status: 200, body: { items: [] } }));
    expect(await commitAndDeploy(clean.request, { group: 'default', markers: M, message: 'm' })).toEqual({ kind: 'nothing-to-commit' });
    let statusReads = 0;
    const { request, calls } = fakeRequest(({ method, path }) => {
      if (path === '/version/status') return ++statusReads === 1 ? dirty : { status: 200, body: { items: [] } };
      if (method === 'POST') return { status: 200, body: { items: [{ commit: 'abc1234def' }] } };
      if (method === 'GET' && path.split('?')[0] === '/version') return head('abc1234def');
      return { status: 200, body: {} };
    });
    expect(await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' })).toEqual({ kind: 'deployed', hash: 'abc1234def', files: [MINE] });
    expect(calls.find((c) => c.path.endsWith('/deploy'))!.options!.body).toEqual({ version: 'abc1234def' });
  });

  it('does not deploy its commit when a newer commit is HEAD (that deploy would roll the group back), or when HEAD cannot be read', async () => {
    for (const [answer, kind] of [
      [head('fff0000aaaa'), 'newer-commit'],
      [{ status: 500, body: 'boom' }, 'head-unknown'],
      [{ status: 200, body: { items: [] } }, 'head-unknown'],
    ] as const) {
      let statusReads = 0;
      const { request, calls } = fakeRequest(({ method, path }) => {
        if (path === '/version/status') return ++statusReads === 1 ? dirty : { status: 200, body: { items: [] } };
        if (method === 'POST') return { status: 200, body: { items: [{ commit: 'abc1234def' }] } };
        if (method === 'GET' && path.split('?')[0] === '/version') return answer;
        return { status: 200, body: {} };
      });
      const out = await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' });
      expect(out.kind).toBe(kind);
      expect(out).toMatchObject({ hash: 'abc1234def' });
      if (out.kind === 'newer-commit') expect(out.head).toBe('fff0000aaaa');
      expect(calls.some((c) => c.path.endsWith('/deploy'))).toBe(false);
      // HEAD is read once, after the completeness re-read and just before the deploy would be sent.
      const heads = calls.filter((c) => c.path.split('?')[0] === '/version');
      expect(heads.map((c) => c.path)).toEqual(['/version?offset=0&limit=1']);
    }
  });

  it('matches full paths under the group only: a Leader-level or pack file is never this group’s file', () => {
    const outputs = ['local/cribl/outputs.yml'];
    expect(commitScope(['groups/default/local/cribl/outputs.yml'], 'default', outputs)).toEqual({ alreadyDirty: ['groups/default/local/cribl/outputs.yml'], elsewhere: [], unplaced: [], unknown: false });
    // A pack's own outputs.yml in this group, another group's file, and a suffix that only ends the same.
    for (const p of ['groups/default/default/other_pack/local/cribl/outputs.yml', 'groups/default2/local/cribl/outputs.yml', 'groups/default/local/cribl/outputs.yml.bak', 'x/groups/default/local/cribl/outputs.yml']) {
      expect(commitScope([p], 'default', outputs), p).toMatchObject({ alreadyDirty: [], unknown: false });
    }
    // A directory marker matches inside that directory only (`main/` is not `main2/`).
    expect(commitScope(['groups/default/local/cribl/pipelines/main/conf.yml', 'groups/default/local/cribl/pipelines/main2/conf.yml'], 'default', ['local/cribl/pipelines/main/']).alreadyDirty).toEqual([
      'groups/default/local/cribl/pipelines/main/conf.yml',
    ]);
    // A bare path with no group prefix could be the Leader's file or (if status is group-scoped) this
    // group's: it cannot be placed, so the scope is unknown, never "nothing pending".
    expect(commitScope(['local/cribl/outputs.yml'], 'default', outputs)).toMatchObject({ alreadyDirty: [], unplaced: ['local/cribl/outputs.yml'], unknown: true });
    // A bare path that matches no marker is not ours under either reading.
    expect(commitScope(['local/cribl/auth.yml'], 'default', outputs)).toEqual({ alreadyDirty: [], elsewhere: ['local/cribl/auth.yml'], unplaced: [], unknown: false });
  });

  it('commits nothing when a pending path matching a marker cannot be placed in a group', async () => {
    const { request, calls } = fakeRequest(({ path }) =>
      path === '/version/status' ? { status: 200, body: { items: [{ modified: [MINE, 'local/cribl/inputs.yml'] }] } } : { status: 200, body: {} },
    );
    const out = await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' });
    expect(out).toEqual({ kind: 'scope-unknown', unplaced: ['local/cribl/inputs.yml'] });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reads status after the write, commits only matching files, and refuses an incomplete commit', async () => {
    let statusReads = 0;
    const { request, calls } = fakeRequest(({ method, path }) => {
      if (path === '/version/status') {
        statusReads++;
        const files = statusReads === 1
          ? [{ path: 'groups/default/local/cribl/inputs.yml' }, { path: 'groups/other/local/cribl/inputs.yml' }]
          : [{ path: 'groups/default/local/cribl/inputs.yml' }];
        return { status: 200, body: { items: [{ files }] } };
      }
      if (method === 'POST') return { status: 200, body: { items: [{ commit: 'abc1234def' }] } };
      return { status: 200, body: {} };
    });
    const out = await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' });
    expect(calls.find((c) => c.method === 'POST')!.options!.body).toEqual({ message: 'm', files: ['groups/default/local/cribl/inputs.yml'] });
    expect(out.kind).toBe('incomplete');
    expect(calls.some((c) => c.path.endsWith('/deploy'))).toBe(false);
  });

  it('a failed status read is "could not tell", never "clean"', () => {
    expect(commitScope(null, 'default', M)).toEqual({ alreadyDirty: [], elsewhere: [], unplaced: [], unknown: true });
    expect(commitScope([], 'default', M).unknown).toBe(false);
  });
  it('a refused deploy says which path refused it', async () => {
    let statusReads = 0;
    const { request } = fakeRequest(({ method, path }) => {
      if (path === '/version/status') return ++statusReads === 1 ? dirty : { status: 200, body: { items: [] } };
      if (method === 'POST') return { status: 200, body: { items: [{ commit: 'abc1234def' }] } };
      if (method === 'GET' && path.split('?')[0] === '/version') return head('abc1234def');
      if (path.startsWith('/products')) return { status: 404, body: {} };
      return { status: 403, body: {} };
    });
    expect(await commitAndDeploy(request, { group: 'default', markers: M, message: 'm' })).toEqual({
      kind: 'deploy-failed',
      hash: 'abc1234def',
      response: { status: 403, body: {} },
      route: 'master',
    });
  });

  it('commitScopeGrew: new uncommitted work in the carried files, or a scope that became unknown, voids the approval', () => {
    const planned = commitScope([MINE], 'default', M);
    expect(commitScopeGrew(planned, commitScope([MINE], 'default', M))).toBe(false);
    // Someone else's pending file elsewhere is not carried by this commit.
    expect(commitScopeGrew(planned, commitScope([MINE, 'groups/other/local/cribl/inputs.yml'], 'default', M))).toBe(false);
    expect(commitScopeGrew(commitScope([], 'default', M), commitScope([MINE], 'default', M))).toBe(true);
    expect(commitScopeGrew(planned, commitScope(null, 'default', M))).toBe(true);
    // The dialog already said "could not tell": an unknown now is not new information.
    expect(commitScopeGrew(commitScope(null, 'default', M), commitScope(null, 'default', M))).toBe(false);
  });

  it('observeCommitDeploy reports every step, reads included, so a 401/403 on the status or HEAD read can latch', async () => {
    let statusReads = 0;
    const { request } = fakeRequest(({ method, path }) => {
      if (path === '/version/status') return ++statusReads === 1 ? dirty : { status: 200, body: { items: [] } };
      if (method === 'POST') return { status: 200, body: { items: [{ commit: 'abc1234def' }] } };
      if (method === 'GET' && path.split('?')[0] === '/version') return { status: 403, body: {} };
      return { status: 200, body: {} };
    });
    const seen: Array<[string, number]> = [];
    const out = await commitAndDeploy(observeCommitDeploy(request, (step, _m, _p, status) => seen.push([step, status])), { group: 'default', markers: M, message: 'm' });
    expect(out.kind).toBe('head-unknown');
    expect(seen).toEqual([['status', 200], ['commit', 200], ['status', 200], ['head', 403]]);
    expect(commitDeployStep('PATCH', '/master/groups/default/deploy')).toBe('deploy-master');
    expect(commitDeployStep('PATCH', '/products/stream/groups/default/deploy')).toBe('deploy');
    expect(commitDeployStep('GET', '/products/stream/groups/default')).toBeNull();
  });
});

describe('ownership', () => {
  it('needs all three signals', () => {
    const object = { id: 'in_app', description: stampDescription('Syslog in', 'my-app') };
    expect(proveOwnership('my-app', { manifestIds: new Set(['in_app']), object, recordedWrite: true }).mine).toBe(true);
    expect(proveOwnership('my-app', { manifestIds: new Set(['in_app']), object, recordedWrite: false }).mine).toBe(false);
    expect(proveOwnership('my-app', { manifestIds: new Set(['in_app']), object: { id: 'in_app', description: 'copied' }, recordedWrite: true }).mine).toBe(false);
  });

  it('stamps once', () => {
    expect(stampDescription(stampDescription('x', 'a'), 'a')).toBe('x [managed-by:a]');
  });

  it('owns a pack only when version AND source match', () => {
    const release = { id: 'acme_pack', version: '0.2.1', url: 'https://example.com/acme_pack-0.2.1.crbl' };
    expect(provePackOwnership({ id: 'ACME_pack', version: '0.2.1', source: release.url }, release).mine).toBe(true);
    expect(provePackOwnership({ id: 'acme_pack', version: '0.2.1', source: 'upload' }, release).mine).toBe(false);
    expect(provePackOwnership({ id: 'acme_pack', version: '0.2.0', source: release.url }, release).mine).toBe(false);
  });

  it('deletes referrers before what they reference', () => {
    const order = teardownOrder([
      { id: 'out', references: [] },
      { id: 'pipe', references: [] },
      { id: 'route', references: ['pipe', 'out'] },
    ]);
    expect(order.indexOf('route')).toBeLessThan(order.indexOf('out'));
    expect(order.indexOf('route')).toBeLessThan(order.indexOf('pipe'));
    expect(() => teardownOrder([{ id: 'a', references: ['b'] }, { id: 'b', references: ['a'] }])).toThrow(/cycle/);
  });
});
