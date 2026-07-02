import { describe, it, expect } from 'vitest';
import { abbreviateTableName, toDirectDcrName, DIRECT_DCR_MAX } from './dcr-name';

describe('dcr-name', () => {
  it('abbreviates known tables', () => {
    expect(abbreviateTableName('CommonSecurityLog')).toBe('CSL');
    expect(abbreviateTableName('SecurityEvent')).toBe('SecEvt');
  });

  it('passes unknown / custom tables through unchanged', () => {
    expect(abbreviateTableName('MyCustom_CL')).toBe('MyCustom_CL');
  });

  it('builds a direct DCR name within the 30-char limit', () => {
    const name = toDirectDcrName('CommonSecurityLog', 'dcr', 'eastus');
    expect(name).toBe('dcr-CSL-eastus');
    expect(name.length).toBeLessThanOrEqual(DIRECT_DCR_MAX);
  });

  it('truncates over-long names and trims trailing hyphens', () => {
    const name = toDirectDcrName('SomeVeryLongCustomTableName_CL', 'dcr-prefix', 'westeurope');
    expect(name.length).toBeLessThanOrEqual(DIRECT_DCR_MAX);
    expect(name.endsWith('-')).toBe(false);
  });
});
