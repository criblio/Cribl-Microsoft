// KvDocumentStore over the platform's app-scoped KV store (AZR-18): the
// cloud-shell adapter for the @soc/core port of the same name. The port's
// header says why it exists; this module is only the mapping from what the
// bridge answers to the three-way read.
//
//   GET 404, empty body, body that is not JSON   -> absent
//   GET 2xx with a JSON body                     -> value (parsed)
//   GET 403, 5xx, any other non-ok, timeout,
//   transport error                              -> unknown
//
// 403 is the line that matters. PlatformSecretsStore and KvContentCache read a
// 403 as absent - correct for an encrypted secret, which is write-only - and
// that is exactly the branch this adapter must NOT copy: an operator's saved
// selection that the bridge refused to read would otherwise decode as "no
// selection", and the next Save would replace it with the defaults. Changing
// those two adapters is a separate board card; this one sidesteps the defect
// for the documents that go through it.
//
// Writes follow claude-kit standards/cribl-kv-store.md: PUT with
// Content-Type text/plain and a JSON.stringify body (an application/json body
// is persisted as the literal "[object Object]" with a 200), never the
// ?encrypted flag, and the PUT's own status is the only evidence of success.
//
// Separate from adapters.ts so its pins can mock platform/http without
// loading the rest of the cloud bundle.

import { isKvDocumentKey } from '@soc/core';
import type { KvDocumentLoad, KvDocumentStore } from '@soc/core';

import { fetchWithTimeout, kvUrl } from './http';

export class PlatformKvDocumentStore implements KvDocumentStore {
  async load(key: string): Promise<KvDocumentLoad> {
    if (!isKvDocumentKey(key)) {
      // A percent-escaped key 404s, and that 404 would read as "never
      // written". Refusing it here keeps a wiring bug from posing as a first run.
      return { kind: 'unknown', reason: `unsafe KV key '${key}'` };
    }
    let res: Response;
    let text: string;
    try {
      res = await fetchWithTimeout(kvUrl(key));
      if (res.status === 404) {
        return { kind: 'absent', why: 'not-found' };
      }
      if (!res.ok) {
        return {
          kind: 'unknown',
          reason: `GET kvstore/${key}: HTTP ${res.status}`,
          status: res.status,
        };
      }
      text = await res.text();
    } catch (err) {
      // fetchWithTimeout's timer, a detached bridge, or a body that could not
      // be read: the document may well exist, so this is not an absence.
      return {
        kind: 'unknown',
        reason: `GET kvstore/${key}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (text.trim() === '') {
      return { kind: 'absent', why: 'empty' };
    }
    try {
      return { kind: 'value', value: JSON.parse(text) as unknown };
    } catch {
      // A value that was READ and is unrecognisable is absent and is left in
      // place (cribl-kv-store.md): the operator's next explicit Save replaces
      // it. Repairing it here would be a write on load.
      return { kind: 'absent', why: 'corrupt' };
    }
  }

  async save(key: string, value: unknown): Promise<void> {
    if (!isKvDocumentKey(key)) {
      throw new Error(`PUT kvstore: refusing unsafe KV key '${key}'`);
    }
    const body = JSON.stringify(value);
    if (body === undefined) {
      throw new Error(`PUT kvstore/${key}: the document is not JSON-serializable`);
    }
    // kvUrl(key) with no query string: no ?encrypted=true, ever. An encrypted
    // document could never be loaded again.
    const res = await fetchWithTimeout(kvUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${key}: HTTP ${res.status}\n${await res.text()}`);
    }
  }
}
