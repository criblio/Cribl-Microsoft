// Unit tests for the pure helpers extracted into the Field Mapping Engine.
// matchFields/matchSampleToSchema/getOverflowConfig are covered by field-matcher.test.ts
// (they are re-exported from here); this file covers the type inference and the two projection
// shapes that scaffoldPack relies on.

import { describe, it, expect } from 'vitest';
import {
  inferFieldTypeFromValue,
  projectMatchResult,
  projectRenamesAndCoercions,
  type MatchResult,
  type FieldMatch,
} from './field-mapping-engine';

describe('inferFieldTypeFromValue', () => {
  it('classifies integers and reals', () => {
    expect(inferFieldTypeFromValue(443)).toBe('int');
    expect(inferFieldTypeFromValue(0)).toBe('int');
    expect(inferFieldTypeFromValue(-7)).toBe('int');
    expect(inferFieldTypeFromValue(3.14)).toBe('real');
  });

  it('classifies booleans and objects', () => {
    expect(inferFieldTypeFromValue(true)).toBe('boolean');
    expect(inferFieldTypeFromValue({ a: 1 })).toBe('dynamic');
    expect(inferFieldTypeFromValue([1, 2])).toBe('dynamic');
  });

  it('classifies string shapes: datetime, long, plain string', () => {
    expect(inferFieldTypeFromValue('2025-06-15T14:30:00Z')).toBe('datetime');
    expect(inferFieldTypeFromValue('2025-06-15 14:30')).toBe('datetime');
    expect(inferFieldTypeFromValue('12345')).toBe('long');
    expect(inferFieldTypeFromValue('hello')).toBe('string');
    expect(inferFieldTypeFromValue('10.0.0.1')).toBe('string');
  });

  it('treats a 16+ digit numeric string as a plain string (id-like), not long', () => {
    expect(inferFieldTypeFromValue('1234567890123456')).toBe('string');
  });

  it('treats null as string (typeof null is object but the null guard excludes it)', () => {
    expect(inferFieldTypeFromValue(null)).toBe('string');
  });
});

// Helper to build a minimal MatchResult for projection tests.
function match(partial: Partial<FieldMatch> & Pick<FieldMatch, 'sourceName' | 'destName' | 'destType' | 'action'>): FieldMatch {
  return {
    sourceType: 'string',
    confidence: 'alias',
    needsCoercion: false,
    description: '',
    ...partial,
  };
}

function result(over: Partial<MatchResult>): MatchResult {
  return {
    matched: [],
    overflow: [],
    unmatchedSource: [],
    unmatchedDest: [],
    overflowConfig: { enabled: false, fieldName: '', fieldType: 'dynamic', sourceFields: [] },
    totalSource: 0,
    totalDest: 0,
    matchRate: 0,
    ...over,
  };
}

describe('projectMatchResult', () => {
  it('maps matched actions: keep, coerce (keep+coercion), rename (needsCoercion), passthrough action', () => {
    const mr = result({
      matched: [
        match({ sourceName: 'a', destName: 'a', destType: 'string', action: 'keep', needsCoercion: false }),
        match({ sourceName: 'b', destName: 'b', destType: 'int', action: 'keep', needsCoercion: true }),
        match({ sourceName: 'c', destName: 'Dest', destType: 'int', action: 'keep', needsCoercion: true }),
        match({ sourceName: 'd', destName: 'D', destType: 'string', action: 'rename', needsCoercion: false }),
      ],
    });
    const fields = projectMatchResult(mr);
    expect(fields).toEqual([
      { source: 'a', target: 'a', type: 'string', action: 'keep' },
      { source: 'b', target: 'b', type: 'int', action: 'coerce' },
      { source: 'c', target: 'Dest', type: 'int', action: 'coerce' },
      { source: 'd', target: 'D', type: 'string', action: 'rename' },
    ]);
  });

  it('routes overflow and unmatched-source fields to drop', () => {
    const mr = result({
      matched: [],
      overflow: [match({ sourceName: 'x', destName: 'AdditionalExtensions', destType: 'string', action: 'overflow' })],
      unmatchedSource: [{ name: 'cribl_internal', type: 'string' }],
    });
    const fields = projectMatchResult(mr);
    expect(fields).toEqual([
      { source: 'x', target: 'AdditionalExtensions', type: 'string', action: 'drop' },
      { source: 'cribl_internal', target: 'cribl_internal', type: 'string', action: 'drop' },
    ]);
  });
});

describe('projectRenamesAndCoercions', () => {
  it('keeps only rename and coerce matches, renames first, ignoring keep/overflow/unmatched', () => {
    const mr = result({
      matched: [
        match({ sourceName: 'k', destName: 'k', destType: 'string', action: 'keep' }),
        match({ sourceName: 'src', destName: 'SourceIP', destType: 'string', action: 'rename' }),
        match({ sourceName: 'p', destName: 'Port', destType: 'int', action: 'coerce', needsCoercion: true }),
      ],
      overflow: [match({ sourceName: 'o', destName: 'Extra', destType: 'string', action: 'overflow' })],
      unmatchedSource: [{ name: 'u', type: 'string' }],
    });
    expect(projectRenamesAndCoercions(mr)).toEqual([
      { source: 'src', target: 'SourceIP', type: 'string', action: 'rename' },
      { source: 'p', target: 'Port', type: 'int', action: 'coerce' },
    ]);
  });
});
