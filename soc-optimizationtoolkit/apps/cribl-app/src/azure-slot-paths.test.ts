/**
 * AZR-92 review finding: the Diagnostics panels reached Azure without the
 * credential slot - a raw ARM GET under whatever tenant's Bearer sat in the
 * shared slot, and a token mint written straight over the shared
 * azureArmToken - so neither got the owner check, the lease or the slot's
 * note of whose token is in it.
 *
 * Mounting App.tsx needs the whole platform, so this pins the SOURCE: every
 * path in the shell that sends to Azure outside platform/ must sit inside the
 * slot's owner check, and every token mint must be handed to the guarded
 * secret paths (secret-connect.ts) rather than written by hand.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8').split('\n');

/** Line indexes (0-based) whose text contains `needle`. */
function linesWith(needle: string): number[] {
  return app.flatMap((line, i) => (line.includes(needle) ? [i] : []));
}

/** Whether one of the `span` lines before `i` contains `needle`. */
function precededBy(i: number, needle: string, span: number): boolean {
  return app.slice(Math.max(0, i - span), i + 1).some((line) => line.includes(needle));
}

describe('App.tsx sends to Azure only through the credential slot (AZR-92)', () => {
  it('every raw ARM request is inside the owner check', () => {
    const arm = linesWith("'https://management.azure.com");
    expect(arm.length).toBeGreaterThan(0);
    for (const i of arm) {
      expect({ line: i + 1, guarded: precededBy(i, 'azureCredentialSlot.shared(', 4) }).toEqual({ line: i + 1, guarded: true });
    }
  });

  it('every token mint is handed to the guarded secret paths, never written to the slot by hand', () => {
    const mints = linesWith('acquireArmToken(').filter((i) => !app[i]!.trimStart().startsWith('import'));
    expect(mints.length).toBeGreaterThan(0);
    for (const i of mints) {
      expect({ line: i + 1, guarded: precededBy(i, 'mintArmToken', 2) }).toEqual({ line: i + 1, guarded: true });
    }
    expect(linesWith("kvUrl('azureArmToken")).toEqual([]);
    expect(linesWith("kvUrl('azureBasic")).toEqual([]);
  });
});
