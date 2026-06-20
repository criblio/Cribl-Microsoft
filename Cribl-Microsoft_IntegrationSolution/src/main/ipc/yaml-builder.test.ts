// Unit tests for the YAML emission helpers. These lock the byte-exact contract (quoting and
// the Cribl-function skeleton) that the pack-builder pipeline output depends on.

import { describe, it, expect } from 'vitest';
import { escapeYamlFilter, emitCriblFunction } from './yaml-builder';

describe('escapeYamlFilter', () => {
  it('returns the literal true for empty/missing input', () => {
    expect(escapeYamlFilter('')).toBe('true');
    expect(escapeYamlFilter(undefined)).toBe('true');
    expect(escapeYamlFilter(null)).toBe('true');
  });

  it('passes through a plain expression with no quotes or backslashes unchanged', () => {
    expect(escapeYamlFilter('sourcetype == 1024')).toBe('sourcetype == 1024');
    expect(escapeYamlFilter('a && b || c')).toBe('a && b || c');
  });

  it('escapes backslashes before double quotes', () => {
    expect(escapeYamlFilter('a\\b')).toBe('a\\\\b');
    expect(escapeYamlFilter('say "hi"')).toBe('say \\"hi\\"');
    // backslash then quote: backslash doubled first, then quote escaped
    expect(escapeYamlFilter('x\\"y')).toBe('x\\\\\\"y');
  });
});

describe('emitCriblFunction', () => {
  it('emits the full skeleton with conf body, description, and groupId', () => {
    const out = emitCriblFunction({
      id: 'serde',
      filter: '__cefExtension != undefined',
      conf: [
        '      mode: extract',
        '      type: kvp',
      ],
      description: 'Parse CEF extension fields',
      groupId: 'extract',
    });
    expect(out).toBe(
      [
        '  - id: serde',
        '    filter: "__cefExtension != undefined"',
        '    disabled: false',
        '    conf:',
        '      mode: extract',
        '      type: kvp',
        '    description: Parse CEF extension fields',
        '    groupId: extract',
      ].join('\n'),
    );
  });

  it('defaults filter to true and disabled to false', () => {
    const out = emitCriblFunction({ id: 'eval', conf: ['      add: []'], groupId: 'extract' });
    expect(out).toBe(
      ['  - id: eval', '    filter: "true"', '    disabled: false', '    conf:', '      add: []', '    groupId: extract'].join('\n'),
    );
  });

  it('collapses an empty conf to an inline empty map and omits absent description/groupId', () => {
    const out = emitCriblFunction({ id: 'eval' });
    expect(out).toBe(['  - id: eval', '    filter: "true"', '    disabled: false', '    conf: {}'].join('\n'));
  });
});
