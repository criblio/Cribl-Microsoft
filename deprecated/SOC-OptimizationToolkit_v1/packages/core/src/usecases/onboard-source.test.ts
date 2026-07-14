import { describe, it, expect } from 'vitest';
import { OnboardSource } from './onboard-source';
import {
  FakeSourceConnector,
  FakeDcrDeployer,
  FakeCriblClient,
  RecordingProgressSink,
} from '../testing/index';

describe('OnboardSource (walking skeleton)', () => {
  it('onboards one source end to end: source -> DCR -> Cribl destination', async () => {
    const source = new FakeSourceConnector('event-hub');
    const dcr = new FakeDcrDeployer();
    const cribl = new FakeCriblClient();
    const progress = new RecordingProgressSink();

    const result = await new OnboardSource({ source, dcr, cribl, progress }).run({
      sourceTable: 'CommonSecurityLog',
      location: 'eastus',
    });

    // domain: abbreviation + 30-char Direct DCR name
    expect(result.dcrName).toBe('dcr-CSL-eastus');
    expect(result.sourceType).toBe('event-hub');

    // destination: DCR deployed, Cribl destination wired to it
    expect(dcr.deployed).toContain('dcr-CSL-eastus');
    expect(result.dcrId).toBe('dcr/dcr-CSL-eastus');
    expect(cribl.destinations).toContain('dest-dcr-CSL-eastus');
    expect(result.criblDestinationId).toBe('dest-dcr-CSL-eastus');

    // the orchestration sequence (also what the GUI/CLI ProgressSink renders)
    expect(progress.events.map((e) => e.phase)).toEqual(['source', 'dcr', 'cribl', 'done']);
  });
});
