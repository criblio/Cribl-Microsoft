import { describe, expect, it } from 'vitest';
import { FakeCriblClient } from './fake-cribl-client';
import { listingRows } from '../domain/inventory-listing';

describe('FakeCriblClient', () => {
  it('serves scripted responses FIFO and records every call including groupId', async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { items: [] } }, { status: 201, body: { id: 'out-1' } });

    const list = await cribl.request({ method: 'GET', path: '/system/outputs', groupId: 'default' });
    const create = await cribl.request({
      method: 'POST',
      path: '/system/outputs',
      groupId: 'default',
      body: { id: 'out-1', type: 'sentinel' },
    });

    expect(list).toEqual({ status: 200, body: { items: [] } });
    expect(create.status).toBe(201);
    expect(cribl.calls).toHaveLength(2);
    expect(cribl.calls[0]!.groupId).toBe('default');
    expect(cribl.calls[1]!.body).toEqual({ id: 'out-1', type: 'sentinel' });
  });

  it('throws (and still records the call) when the response queue is exhausted', async () => {
    const cribl = new FakeCriblClient();
    await expect(cribl.request({ method: 'GET', path: '/system/inputs' })).rejects.toThrow(
      'no scripted response for GET /system/inputs',
    );
    expect(cribl.calls).toHaveLength(1);
  });

  it('returns configured groups from listGroups and counts invocations', async () => {
    const cribl = new FakeCriblClient();
    cribl.groups = [
      { id: 'default', product: 'stream' },
      { id: 'edge-fleet' },
    ];

    const groups = await cribl.listGroups();
    await cribl.listGroups();

    expect(groups).toEqual({
      kind: 'rows',
      rows: [{ id: 'default', product: 'stream' }, { id: 'edge-fleet' }],
    });
    expect(cribl.listGroupsCalls).toBe(2);

    (listingRows(groups)[0] as { id: string }).id = 'tampered';
    expect(listingRows(await cribl.listGroups())[0]!.id).toBe('default');
  });

  it('reports no configured groups as the unverified empty listing, never a zero', async () => {
    // The adapter cannot tell "none exist" from "you may see none", so the fake
    // must not either - a test written against it would otherwise pass on a
    // shape the product never returns.
    expect(await new FakeCriblClient().listGroups()).toEqual({ kind: 'empty' });
  });
});
