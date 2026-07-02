import { describe, expect, it } from 'vitest';
import type { JobStep } from '../ports/job-store';
import { FakeJobStore } from './fake-job-store';

/** Deterministic ISO-timestamp clock: t-0001, t-0002, ... (lexicographically ordered). */
function tickingClock(): () => string {
  let tick = 0;
  return () => `2026-07-01T00:00:00.${String(++tick).padStart(4, '0')}Z`;
}

describe('FakeJobStore', () => {
  it('creates pending jobs with unique ids, empty steps, and matching timestamps', async () => {
    const store = new FakeJobStore(tickingClock());
    const first = await store.create('deploy-dcr', { table: 'SecurityEvent' });
    const second = await store.create('deploy-dcr', { table: 'Syslog' });

    expect(first.id).not.toBe(second.id);
    expect(first.status).toBe('pending');
    expect(first.steps).toEqual([]);
    expect(first.input).toEqual({ table: 'SecurityEvent' });
    expect(first.createdAt).toBe(first.updatedAt);
  });

  it('gets a stored job and returns null for unknown ids', async () => {
    const store = new FakeJobStore();
    const created = await store.create('build-pack', null);
    expect(await store.get(created.id)).toEqual(created);
    expect(await store.get('job-999')).toBeNull();
  });

  it('merges patches and refreshes updatedAt while preserving id and createdAt', async () => {
    const store = new FakeJobStore(tickingClock());
    const created = await store.create('deploy-dcr', {});

    await store.update(created.id, { status: 'succeeded', result: { dcrId: 'abc' } });

    const updated = await store.get(created.id);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(created.id);
    expect(updated!.status).toBe('succeeded');
    expect(updated!.result).toEqual({ dcrId: 'abc' });
    expect(updated!.input).toEqual({});
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.updatedAt > created.updatedAt).toBe(true);
  });

  it('replaces the steps array wholesale on update', async () => {
    const store = new FakeJobStore(tickingClock());
    const created = await store.create('deploy-dcr', {});

    const steps: JobStep[] = [
      { name: 'create table', status: 'pending' },
      { name: 'deploy DCR', status: 'pending' },
    ];
    await store.update(created.id, { status: 'running', steps });

    steps[0] = { name: 'create table', status: 'succeeded' };
    steps[1] = { name: 'deploy DCR', status: 'failed', detail: 'ARM 409' };
    await store.update(created.id, { status: 'failed', error: 'deploy DCR failed', steps });

    const final = await store.get(created.id);
    expect(final!.steps).toEqual([
      { name: 'create table', status: 'succeeded' },
      { name: 'deploy DCR', status: 'failed', detail: 'ARM 409' },
    ]);
    expect(final!.error).toBe('deploy DCR failed');
  });

  it('rejects updates for unknown ids', async () => {
    const store = new FakeJobStore();
    await expect(store.update('job-404', { status: 'running' })).rejects.toThrow('job-404');
  });

  it('lists newest first and filters by kind', async () => {
    const store = new FakeJobStore(tickingClock());
    const a = await store.create('deploy-dcr', 1);
    const b = await store.create('build-pack', 2);
    const c = await store.create('deploy-dcr', 3);

    expect((await store.list()).map((job) => job.id)).toEqual([c.id, b.id, a.id]);
    expect((await store.list('deploy-dcr')).map((job) => job.id)).toEqual([c.id, a.id]);
    expect(await store.list('discovery')).toEqual([]);
  });

  it('returns defensive copies from create, get, and list', async () => {
    const store = new FakeJobStore();
    const created = await store.create('deploy-dcr', {});
    await store.update(created.id, { steps: [{ name: 'step', status: 'running' }] });

    const fetched = await store.get(created.id);
    fetched!.status = 'failed';
    fetched!.steps[0]!.status = 'failed';

    const fresh = await store.get(created.id);
    expect(fresh!.status).toBe('pending');
    expect(fresh!.steps[0]!.status).toBe('running');
  });
});
