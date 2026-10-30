import { describe, expect, it } from 'vitest';
import { describeViolations, findHistoryInCopy } from './copy-rules';

const one = (text: string) => findHistoryInCopy([{ where: 'tip', text }]);

describe('findHistoryInCopy', () => {
  it.each([
    ['Measured 2026-09-24 on a live workspace.', '2026-09-24'],
    ['Served by A-SP21 since the change.', 'A-SP21'],
    ['Decision I-D4 says so.', 'I-D4'],
    ['Fixed under DBT-61.', 'DBT-61'],
    ['Added in Phase 3.', 'Phase 3'],
    ['Since slice 1.6 this is a pill.', 'slice 1.6'],
  ])('flags project history: %s', (text, match) => {
    const v = one(text);
    expect(v.map((x) => x.match)).toEqual([match]);
  });

  it('leaves vocabulary that merely looks like an id alone', () => {
    expect(one('Hashed with SHA-256, encoded UTF-8, timestamps ISO-8601, TLS-1 refused.')).toEqual([]);
  });

  it('passes plain customer copy', () => {
    expect(one('Events per second across every worker in the selected group, over the last hour.')).toEqual([]);
  });

  it('lets a caller allow its own vocabulary without weakening the rule', () => {
    expect(findHistoryInCopy([{ where: 'x', text: 'OCSF-1 schema' }], { allowIds: ['OCSF'] })).toEqual([]);
    expect(findHistoryInCopy([{ where: 'x', text: 'OCSF-1 schema' }])).toHaveLength(1);
  });

  it('names where and why in the failure message', () => {
    expect(describeViolations(one('Phase 2 only.'))).toBe('tip: "Phase 2" is a plan reference (phase / slice / spike / unit / milestone) — move it to a code comment');
  });
});
