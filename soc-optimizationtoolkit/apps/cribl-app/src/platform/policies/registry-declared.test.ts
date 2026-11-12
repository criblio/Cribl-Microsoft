// registry-declared.test.ts - every Cribl call the least-privilege registry
// says the app makes is one paths.ts declares (DBT-303).
//
// The registry (core domain/least-privilege/operations.ts) feeds the change
// requests an operator sends to their Cribl admin. A row whose call the app
// never makes asks for a role nobody needs: cribl.breakers.create asked for
// Worker Group Editor on POST /m/{groupId}/lib/breakers, which no shell or use
// case ever sent and policies.yml never granted. paths.ts is the list of calls
// the app really makes (policies-coverage.test.ts holds it to policies.yml), so
// a registry Cribl call missing from it is either dead or undeclared - both are
// defects. App-scoped /kvstore calls are granted with the app and are not in
// paths.ts by rule, so they are the one named exception.

import { describe, expect, it } from 'vitest';
import { LEAST_PRIVILEGE_OPERATIONS } from '@soc/core';
import { API_CALLS } from './paths';

/** `METHOD /path` with every path parameter reduced to `:`, for either grammar. */
function key(method: string, path: string): string {
  return `${method} ${path.replace(/\{[^}]+\}/g, ':').replace(/:[A-Za-z]+/g, ':')}`;
}

function undeclaredRegistryCalls(): string[] {
  const declared = new Set(API_CALLS.map((c) => key(c.method, c.path)));
  const out: string[] = [];
  for (const op of Object.values(LEAST_PRIVILEGE_OPERATIONS)) {
    for (const call of op.calls) {
      if (call.api !== 'cribl') continue;
      const k = key(call.method, call.path);
      if (!declared.has(k)) out.push(`${op.id} ${k}`);
    }
  }
  return out.sort();
}

describe('least-privilege registry against paths.ts', () => {
  it('names only calls paths.ts declares, apart from the app-scoped KV store', () => {
    expect(undeclaredRegistryCalls()).toEqual([
      'cribl.kv.delete DELETE /kvstore/:',
      'cribl.kv.list POST /kvstore/keys',
      'cribl.kv.read GET /kvstore/:',
      'cribl.kv.write PUT /kvstore/:',
    ]);
  });

  it('carries no event-breaker write (DBT-303: nothing creates a breaker)', () => {
    const breakerWrites = Object.values(LEAST_PRIVILEGE_OPERATIONS).flatMap((op) =>
      op.calls
        .filter((c) => c.api === 'cribl' && c.method !== 'GET' && c.path.includes('/lib/breakers'))
        .map((c) => `${op.id} ${c.method} ${c.path}`),
    );
    expect(breakerWrites).toEqual([]);
    expect(Object.keys(LEAST_PRIVILEGE_OPERATIONS)).not.toContain('cribl.breakers.create');
  });
});
