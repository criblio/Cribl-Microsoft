import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseSampleContent } from './sample-parser';
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

describe('sample-parser: CrowdStrike FDR', () => {
  for (const table of CROWDSTRIKE_TABLES) {
    describe(table, () => {
      const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
      const content = fs.readFileSync(samplePath, 'utf-8');
      const parsed = parseSampleContent(content, `${table}.json`);

      it('detects NDJSON format', () => {
        expect(['ndjson', 'json']).toContain(parsed.format);
      });

      it('parses at least 1 event', () => {
        expect(parsed.eventCount).toBeGreaterThan(0);
      });

      it('discovers fields', () => {
        expect(parsed.fields.length).toBeGreaterThan(0);
      });

      it('has no parse errors', () => {
        expect(parsed.errors).toHaveLength(0);
      });

      it('finds common CrowdStrike fields', () => {
        const fieldNames = new Set(parsed.fields.map(f => f.name));
        expect(fieldNames.has('event_simpleName')).toBe(true);
        expect(fieldNames.has('aid')).toBe(true);
        expect(fieldNames.has('timestamp')).toBe(true);
        expect(fieldNames.has('cid')).toBe(true);
      });

      it('detects timestamp field correctly', () => {
        expect(parsed.timestampField).toBe('timestamp');
      });

      it('produces valid JSON raw events', () => {
        expect(parsed.rawEvents.length).toBeGreaterThan(0);
        for (const raw of parsed.rawEvents) {
          expect(() => JSON.parse(raw)).not.toThrow();
        }
      });

      it('infers timestamp as int or string type', () => {
        const tsField = parsed.fields.find(f => f.name === 'timestamp');
        expect(tsField).toBeDefined();
        expect(['int', 'string']).toContain(tsField!.type);
      });
    });
  }
});

describe('sample-parser: format detection', () => {
  it('parses JSON array', () => {
    const result = parseSampleContent('[{"a":1},{"a":2}]', 'test.json');
    expect(result.format).toBe('json');
    expect(result.eventCount).toBe(2);
  });

  it('parses NDJSON', () => {
    const result = parseSampleContent('{"a":1}\n{"a":2}\n', 'test.ndjson');
    expect(result.format).toBe('ndjson');
    expect(result.eventCount).toBe(2);
  });

  it('parses CSV', () => {
    // CSV detection requires >3 comma-separated header fields
    const result = parseSampleContent('name,value,status,count\nfoo,1,ok,10\nbar,2,err,20\n', 'test.csv');
    expect(result.format).toBe('csv');
    expect(result.eventCount).toBe(2);
  });

  it('parses CEF', () => {
    const result = parseSampleContent(
      'CEF:0|Vendor|Product|1.0|100|Test|5|src=10.0.0.1 dst=10.0.0.2',
      'test.cef',
    );
    expect(result.format).toBe('cef');
    expect(result.eventCount).toBe(1);
    const fieldNames = new Set(result.fields.map(f => f.name));
    expect(fieldNames.has('DeviceVendor')).toBe(true);
    expect(fieldNames.has('src')).toBe(true);
  });

  it('parses key=value', () => {
    const result = parseSampleContent(
      'action=allow srcip=10.0.0.1 dstip=10.0.0.2 proto=TCP',
      'test.kv',
    );
    expect(result.format).toBe('kv');
    expect(result.eventCount).toBe(1);
  });

  it('parses syslog RFC 3164', () => {
    const result = parseSampleContent(
      '<134>Jan  5 14:30:00 myhost sshd[1234]: Accepted password for user',
      'test.syslog',
    );
    expect(result.format).toBe('syslog');
    expect(result.eventCount).toBe(1);
    const fieldNames = new Set(result.fields.map(f => f.name));
    expect(fieldNames.has('Hostname')).toBe(true);
    expect(fieldNames.has('Program')).toBe(true);
  });

  it('returns error for empty content', () => {
    const result = parseSampleContent('', 'empty.txt');
    expect(result.eventCount).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
