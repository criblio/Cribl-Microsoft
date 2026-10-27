import { describe, expect, it } from 'vitest';
import { FakeCriblClient } from '../testing/fake-cribl-client';
import type { CriblClient } from '../ports/cribl-client';
import { commitDeployTimeouts, criblRequestFor, routeCriblPath } from './cribl-request';
import { commitAndDeploy, deployedVersion } from './config-writes/commitDeploy';
import { queryMetrics } from './metrics/metricsQuery';

describe('routeCriblPath', () => {
  it('maps /m/<g>/rest to that group, decoding the id', () => {
    expect(routeCriblPath('/m/g1/system/metrics/query')).toEqual({ kind: 'ok', groupId: 'g1', path: '/system/metrics/query' });
    expect(routeCriblPath('/m/a%20b/system/inputs', 'bound')).toEqual({ kind: 'ok', groupId: 'a b', path: '/system/inputs' });
    expect(routeCriblPath('/m/g1')).toEqual({ kind: 'ok', groupId: 'g1', path: '/' });
  });

  it('sends /products/ and /master/ to the leader', () => {
    expect(routeCriblPath('/products/stream/groups/g1/deploy', 'g1')).toEqual({ kind: 'ok', groupId: undefined, path: '/products/stream/groups/g1/deploy' });
    expect(routeCriblPath('/master/groups/g1', 'g1')).toEqual({ kind: 'ok', groupId: undefined, path: '/master/groups/g1' });
  });

  it('binds a bare path to the bound group, and refuses it without one', () => {
    expect(routeCriblPath('/version/status', 'g1')).toEqual({ kind: 'ok', groupId: 'g1', path: '/version/status' });
    expect(routeCriblPath('/version/status')).toEqual({ kind: 'refused', error: 'no-group' });
    expect(routeCriblPath('/version/status', '')).toEqual({ kind: 'refused', error: 'no-group' });
  });

  it('splits the query string into a record', () => {
    expect(routeCriblPath('/version?offset=0&limit=1', 'g1')).toEqual({
      kind: 'ok',
      groupId: 'g1',
      path: '/version',
      query: { offset: '0', limit: '1' },
    });
    expect(routeCriblPath('/x?a=b%20c&d=e+f&flag', 'g1')).toMatchObject({ query: { a: 'b c', d: 'e f', flag: '' } });
    expect(routeCriblPath('/x?', 'g1')).toEqual({ kind: 'ok', groupId: 'g1', path: '/x' });
  });

  it('refuses a relative path or malformed encoding', () => {
    expect(routeCriblPath('version/status', 'g1')).toEqual({ kind: 'refused', error: 'bad-path' });
    expect(routeCriblPath('/m/%E0%A4%A/x')).toEqual({ kind: 'refused', error: 'bad-path' });
    expect(routeCriblPath('/x?a=%E0%A4%A', 'g1')).toEqual({ kind: 'refused', error: 'bad-path' });
  });
});

describe('criblRequestFor', () => {
  it('turns a kit metrics call into one group-scoped CriblRequest', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { results: [] } });
    const answer = await queryMetrics(criblRequestFor(cribl), 'g1', {
      aggregations: ['sum("total.in_events").as(in_events)'],
      window: { cumulative: true },
      earliest: '-24h',
      latest: 'now',
    });
    expect(answer).toEqual({ kind: 'empty' });
    expect(cribl.calls).toEqual([
      {
        method: 'POST',
        groupId: 'g1',
        path: '/system/metrics/query',
        body: { aggs: { aggregations: ['sum("total.in_events").as(in_events)'], cumulative: true }, earliest: '-24h', latest: 'now' },
      },
    ]);
  });

  it('carries the bound group, the query and the leader addressing exactly', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: 1 }, { status: 200, body: 2 }, { status: 200, body: 3 }, { status: 200, body: 4 });
    const req = criblRequestFor(cribl, 'g1');
    await req('GET', '/version/status');
    await req('GET', '/version?offset=0&limit=1');
    await req('PATCH', '/products/stream/groups/g1/deploy', { body: { version: 'h' } });
    await req('GET', '/master/groups/g1');
    expect(cribl.calls).toEqual([
      { method: 'GET', groupId: 'g1', path: '/version/status' },
      { method: 'GET', groupId: 'g1', path: '/version', query: { offset: '0', limit: '1' } },
      { method: 'PATCH', path: '/products/stream/groups/g1/deploy', body: { version: 'h' } },
      { method: 'GET', path: '/master/groups/g1' },
    ]);
    expect(cribl.calls[2]).not.toHaveProperty('groupId');
    expect(cribl.calls[3]).not.toHaveProperty('groupId');
  });

  it('never calls the client for a bare path with no bound group', async () => {
    const cribl = new FakeCriblClient();
    const r = await criblRequestFor(cribl)('GET', '/version/status');
    expect(r).toEqual({ status: 0, body: { error: 'no-group', path: '/version/status' } });
    expect(cribl.calls).toHaveLength(0);
  });

  it('refuses an unsupported method without a call', async () => {
    const cribl = new FakeCriblClient();
    const r = await criblRequestFor(cribl, 'g1')('HEAD', '/x');
    expect(r.status).toBe(0);
    expect(cribl.calls).toHaveLength(0);
  });

  it('resolves a 403 as data and passes only status and body back', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 403, body: 'Forbidden' });
    expect(await criblRequestFor(cribl, 'g1')('GET', '/system/inputs')).toEqual({ status: 403, body: 'Forbidden' });
  });

  it('propagates a transport rejection as a rejection', async () => {
    const failing: CriblClient = {
      request: () => Promise.reject(new Error('bridge detached')),
      listGroups: () => Promise.reject(new Error('unused')),
    };
    await expect(criblRequestFor(failing, 'g1')('GET', '/system/inputs')).rejects.toThrow('bridge detached');
  });

  it('rejects with an AbortError, without a call, when already aborted', async () => {
    const cribl = new FakeCriblClient();
    const ctl = new AbortController();
    ctl.abort();
    await expect(criblRequestFor(cribl, 'g1')('GET', '/x', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cribl.calls).toHaveLength(0);
  });

  it('runs the kit commitAndDeploy with group-scoped status and a leader-level deploy', async () => {
    const cribl = new FakeCriblClient();
    const file = 'groups/g1/local/cribl/inputs.yml';
    cribl.respondWith(
      { status: 200, body: { items: [{ modified: [file] }] } }, // status
      { status: 200, body: { items: [{ commit: 'abc123' }] } }, // commit
      { status: 200, body: { items: [] } }, // status again
      { status: 200, body: { items: [{ hash: 'abc123' }] } }, // HEAD
      { status: 404, body: 'nope' }, // products deploy
      { status: 200, body: {} }, // master deploy
    );
    const out = await commitAndDeploy(criblRequestFor(cribl, 'g1'), { group: 'g1', markers: ['local/cribl/inputs.yml'], message: 'm' });
    expect(out).toEqual({ kind: 'deployed', hash: 'abc123', files: [file] });
    expect(cribl.calls.map((c) => [c.method, c.groupId ?? null, c.path, c.query ?? null])).toEqual([
      ['GET', 'g1', '/version/status', null],
      ['POST', 'g1', '/version/commit', null],
      ['GET', 'g1', '/version/status', null],
      ['GET', 'g1', '/version', { offset: '0', limit: '1' }],
      ['PATCH', null, '/products/stream/groups/g1/deploy', null],
      ['PATCH', null, '/master/groups/g1/deploy', null],
    ]);
  });

  it('reads deployedVersion at leader level', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { items: [{ id: 'g1', configVersion: 'abc' }] } });
    expect(await deployedVersion(criblRequestFor(cribl, 'g1'), 'g1')).toBe('abc');
    expect(cribl.calls).toEqual([{ method: 'GET', path: '/products/stream/groups/g1' }]);
  });

  it('sets no timeoutMs without an opinion, so the adapter default applies', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: {} });
    await criblRequestFor(cribl, 'g1')('POST', '/version/commit', { body: { message: 'm' } });
    expect(cribl.calls[0]).not.toHaveProperty('timeoutMs');
  });

  it('gives the kit commit and both deploy routes the stated wait, and nothing else', async () => {
    const cribl = new FakeCriblClient();
    const file = 'groups/g1/local/cribl/inputs.yml';
    cribl.respondWith(
      { status: 200, body: { items: [{ modified: [file] }] } }, // status
      { status: 200, body: { items: [{ commit: 'abc123' }] } }, // commit
      { status: 200, body: { items: [] } }, // status again
      { status: 200, body: { items: [{ hash: 'abc123' }] } }, // HEAD
      { status: 404, body: 'nope' }, // products deploy
      { status: 200, body: {} }, // master deploy
    );
    const request = criblRequestFor(cribl, 'g1', { timeoutMsFor: commitDeployTimeouts(90_000) });
    const out = await commitAndDeploy(request, { group: 'g1', markers: ['local/cribl/inputs.yml'], message: 'm' });
    expect(out).toEqual({ kind: 'deployed', hash: 'abc123', files: [file] });
    expect(cribl.calls.map((c) => [c.method, c.path, c.timeoutMs ?? null])).toEqual([
      ['GET', '/version/status', null],
      ['POST', '/version/commit', 90_000],
      ['GET', '/version/status', null],
      ['GET', '/version', null],
      ['PATCH', '/products/stream/groups/g1/deploy', 90_000],
      ['PATCH', '/master/groups/g1/deploy', 90_000],
    ]);
  });

  it('passes the method and the raw kit path to timeoutMsFor', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: {} });
    const seen: [string, string][] = [];
    await criblRequestFor(cribl, 'g1', {
      timeoutMsFor: (m, p) => {
        seen.push([m, p]);
        return 1234;
      },
    })('get', '/m/g2/system/inputs?x=1');
    expect(seen).toEqual([['GET', '/m/g2/system/inputs?x=1']]);
    expect(cribl.calls[0]).toMatchObject({ groupId: 'g2', path: '/system/inputs', timeoutMs: 1234 });
  });
});

describe('commitDeployTimeouts', () => {
  it('matches only the commit POST and the deploy PATCH', () => {
    const t = commitDeployTimeouts(5);
    expect(t('POST', '/version/commit')).toBe(5);
    expect(t('POST', '/m/g1/version/commit')).toBe(5);
    expect(t('PATCH', '/products/stream/groups/g1/deploy')).toBe(5);
    expect(t('PATCH', '/master/groups/g1/deploy')).toBe(5);
    expect(t('GET', '/version/commit')).toBeUndefined();
    expect(t('GET', '/version/status')).toBeUndefined();
    expect(t('POST', '/system/inputs')).toBeUndefined();
    expect(t('PATCH', '/system/inputs/x')).toBeUndefined();
    expect(t('GET', '/products/stream/groups/g1')).toBeUndefined();
    expect(t('PATCH', '/products/stream/groups/g1/deploy/extra')).toBeUndefined();
  });
});
