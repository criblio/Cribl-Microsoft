import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseSampleContent } from './sample-parser';
import { matchFields, matchSampleToSchema, getOverflowConfig } from './field-matcher';
import { loadDcrTemplateSchemaPublic } from './pack-builder';
import { initAppPaths } from './app-paths';

const VENDOR_SAMPLES_DIR = path.resolve(__dirname, '../../../packs/vendor-samples/crowdstrike-fdr');

const CROWDSTRIKE_TABLES = [
  'CrowdStrike_Additional_Events_CL',
  'CrowdStrike_Audit_Events_CL',
  'CrowdStrike_Auth_Events_CL',
  'CrowdStrike_DNS_Events_CL',
  'CrowdStrike_File_Events_CL',
  'CrowdStrike_Network_Events_CL',
  'CrowdStrike_Process_Events_CL',
  'CrowdStrike_Registry_Events_CL',
  'CrowdStrike_Secondary_Data_CL',
  'CrowdStrike_User_Events_CL',
];

beforeAll(() => {
  initAppPaths();
});

describe('field-matcher: schema loading', () => {
  for (const table of CROWDSTRIKE_TABLES) {
    it(`loads schema for ${table}`, () => {
      const columns = loadDcrTemplateSchemaPublic(table);
      expect(columns.length).toBeGreaterThan(10);

      const colNames = new Set(columns.map(c => c.name));
      expect(colNames.has('TenantId')).toBe(false);
      expect(colNames.has('_ResourceId')).toBe(false);
      expect(colNames.has('TimeGenerated')).toBe(true);
      expect(colNames.has('event_simpleName')).toBe(true);

      const validTypes = new Set(['string', 'int', 'long', 'real', 'boolean', 'datetime', 'dynamic', 'guid']);
      for (const col of columns) {
        expect(validTypes.has(col.type)).toBe(true);
      }
    });
  }
});

describe('field-matcher: CrowdStrike field matching', () => {
  for (const table of CROWDSTRIKE_TABLES) {
    describe(table, () => {
      const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
      const content = fs.readFileSync(samplePath, 'utf-8');
      const parsed = parseSampleContent(content, `${table}.json`);
      const schema = loadDcrTemplateSchemaPublic(table);

      const sampleFields = parsed.fields.map(f => ({
        name: f.name, type: f.type, sampleValues: f.sampleValues,
      }));
      const result = matchSampleToSchema(sampleFields, schema, undefined, table);

      it('matches fields', () => {
        expect(result.matched.length).toBeGreaterThan(0);
      });

      it('achieves >30% match rate', () => {
        expect(result.matchRate).toBeGreaterThan(0.3);
      });

      it('matches event_simpleName', () => {
        const matched = result.matched.find(m => m.sourceName === 'event_simpleName');
        expect(matched).toBeDefined();
      });

      it('matches timestamp to a schema column', () => {
        const tsMatch = result.matched.find(m => m.sourceName === 'timestamp');
        expect(tsMatch).toBeDefined();
        expect(['timestamp', 'TimeGenerated']).toContain(tsMatch!.destName);
      });

      it('has no Cribl internal fields in matches', () => {
        const internals = result.matched.filter(m =>
          m.sourceName.startsWith('cribl_') || m.sourceName.startsWith('__') || m.sourceName === '_raw'
        );
        expect(internals).toHaveLength(0);
      });
    });
  }
});

describe('field-matcher: overflow config', () => {
  it('uses AdditionalData_d for _CL tables', () => {
    const cfg = getOverflowConfig('CrowdStrike_DNS_Events_CL');
    expect(cfg.fieldName).toBe('AdditionalData_d');
    expect(cfg.fieldType).toBe('dynamic');
  });

  it('uses AdditionalExtensions for CommonSecurityLog', () => {
    const cfg = getOverflowConfig('CommonSecurityLog');
    expect(cfg.fieldName).toBe('AdditionalExtensions');
    expect(cfg.fieldType).toBe('string');
  });

  it('uses EventData for WindowsEvent', () => {
    const cfg = getOverflowConfig('WindowsEvent');
    expect(cfg.fieldName).toBe('EventData');
    expect(cfg.fieldType).toBe('dynamic');
  });
});

describe('field-matcher: matching strategies', () => {
  it('exact match scores highest', () => {
    const result = matchFields(
      [{ name: 'SourceIP', type: 'string' }],
      [{ name: 'SourceIP', type: 'string' }, { name: 'src', type: 'string' }],
    );
    expect(result.matched[0].sourceName).toBe('SourceIP');
    expect(result.matched[0].destName).toBe('SourceIP');
    expect(result.matched[0].confidence).toBe('exact');
  });

  it('alias match works for known abbreviations', () => {
    const result = matchFields(
      [{ name: 'src', type: 'string' }],
      [{ name: 'SourceIP', type: 'string' }],
    );
    expect(result.matched.length).toBe(1);
    expect(result.matched[0].destName).toBe('SourceIP');
    expect(result.matched[0].confidence).toBe('alias');
  });

  it('case-insensitive match works', () => {
    const result = matchFields(
      [{ name: 'sourceip', type: 'string' }],
      [{ name: 'SourceIP', type: 'string' }],
    );
    expect(result.matched.length).toBe(1);
    expect(result.matched[0].confidence).toBe('exact');
  });

  it('detects type coercion needs', () => {
    const result = matchFields(
      [{ name: 'count', type: 'string' }],
      [{ name: 'count', type: 'int' }],
    );
    expect(result.matched[0].needsCoercion).toBe(true);
    expect(result.matched[0].action).toBe('coerce');
  });

  it('routes unmatched fields to overflow', () => {
    const result = matchFields(
      [{ name: 'vendorSpecificField', type: 'string' }],
      [{ name: 'TimeGenerated', type: 'datetime' }],
      undefined,
      'Custom_CL',
    );
    expect(result.overflow.length).toBe(1);
    expect(result.overflow[0].sourceName).toBe('vendorSpecificField');
  });
});
