import { describe, expect, it } from 'vitest';
import { FakeArtifactSink } from './fake-artifact-sink';

describe('FakeArtifactSink', () => {
  it('records string and binary saves in call order', async () => {
    const sink = new FakeArtifactSink();
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08]);

    await sink.save('dcr-SecurityEvent.json', 'application/json', '{"kind":"Direct"}');
    await sink.save('pack.tgz', 'application/gzip', bytes);

    expect(sink.saves).toEqual([
      { name: 'dcr-SecurityEvent.json', mimeType: 'application/json', data: '{"kind":"Direct"}' },
      { name: 'pack.tgz', mimeType: 'application/gzip', data: bytes },
    ]);
  });

  it('finds the most recent save by name', async () => {
    const sink = new FakeArtifactSink();
    await sink.save('report.json', 'application/json', 'v1');
    await sink.save('other.json', 'application/json', 'x');
    await sink.save('report.json', 'application/json', 'v2');

    expect(sink.find('report.json')?.data).toBe('v2');
    expect(sink.find('missing.json')).toBeUndefined();
  });
});
