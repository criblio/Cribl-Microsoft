/**
 * The adopted claude-kit code (kit/config-writes, kit/metrics) calls a transport
 * `request(method, path, options)` whose `path` is relative to `/api/v1`. This app's
 * Cribl IO goes through the CriblClient port, which takes `{method, path, groupId,
 * query, body}` and adds the `/m/{groupId}` prefix itself. This module is the one
 * place those two meet (ADR 0007 D19).
 *
 * The kit sends four path shapes, and each maps differently:
 *
 *   '/m/<g>/rest'                  -> {groupId: g, path: '/rest'}
 *                                     (metricsQueryPath; <g> is URI-decoded)
 *   '/products/...', '/master/...' -> {groupId: undefined, path} - leader level
 *                                     (commitDeploy's deploy and deployedVersion)
 *   any other path                 -> {groupId: boundGroup, path}
 *                                     (commitDeploy's '/version/status',
 *                                     readModifyWrite's '/system/inputs/...')
 *   '...?a=b'                      -> the suffix becomes CriblRequest.query
 *
 * A group-relative path with NO bound group never reaches the client: sent bare it
 * would address the LEADER's /version or /system, which is a different object with
 * the same name. It resolves `{status: 0, body: {error: 'no-group'}}` instead, so the
 * kit reads it as a failed call rather than an answer.
 *
 * Contract, the kit transport's (kit/config-writes/transport.ts): resolve on ANY HTTP
 * status, reject only on transport failure. A CriblClient rejection propagates as a
 * rejection. CriblClient carries no AbortSignal, so an abort is honoured only before
 * the call is sent (it rejects with an AbortError, as the kit expects); a call already
 * in flight runs to completion.
 *
 * Wait. The kit's RequestOptions carries no timeout, so without an opinion every
 * call runs under the CriblClient adapter's short default (CriblRequest.timeoutMs).
 * A commit or deploy that finishes on the server after that default would then
 * reach the caller as a REJECTION - read as 'failed' - rather than as the kit's
 * commit or deploy outcome. `timeoutMsFor` lets the caller state a longer wait per
 * call; `commitDeployTimeouts` is the ready-made one for the two slow kit calls.
 * The right value is not measured live yet (ADR 0007 live-verification list).
 *
 * Pure: no clock, no timers, no globals beyond decodeURIComponent.
 */

import type { CriblClient, CriblRequest } from '../ports/cribl-client';
import type { HttpMethod } from '../ports/http';
import { abortError, type ApiResponse, type Request } from './config-writes/transport';

const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'PUT', 'POST', 'PATCH', 'DELETE']);

const LEADER_PREFIXES = ['/products/', '/master/'] as const;

/** Where one kit path goes, or why it cannot be sent. Exported for the tests and the request scan. */
export type CriblRoute =
  | { kind: 'ok'; groupId: string | undefined; path: string; query?: Record<string, string> }
  | { kind: 'refused'; error: 'no-group' | 'bad-path' };

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Split `a=b&c=d` into a record; `+` is a space, as in a form-encoded query. */
function parseQuery(qs: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    const key = safeDecode(rawKey.replace(/\+/g, ' '));
    const value = safeDecode(rawValue.replace(/\+/g, ' '));
    if (key === null || value === null) return null;
    out[key] = value;
  }
  return out;
}

/** Pure: map one kit path onto CriblRequest addressing. */
export function routeCriblPath(rawPath: string, boundGroup?: string): CriblRoute {
  const q = rawPath.indexOf('?');
  const pathname = q < 0 ? rawPath : rawPath.slice(0, q);
  let query: Record<string, string> | undefined;
  if (q >= 0) {
    const parsed = parseQuery(rawPath.slice(q + 1));
    if (parsed === null) return { kind: 'refused', error: 'bad-path' };
    if (Object.keys(parsed).length > 0) query = parsed;
  }
  if (!pathname.startsWith('/')) return { kind: 'refused', error: 'bad-path' };
  const withQuery = (groupId: string | undefined, path: string): CriblRoute =>
    query ? { kind: 'ok', groupId, path, query } : { kind: 'ok', groupId, path };

  const m = /^\/m\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m) {
    const group = safeDecode(m[1]!);
    if (!group) return { kind: 'refused', error: 'bad-path' };
    return withQuery(group, m[2] ?? '/');
  }
  if (LEADER_PREFIXES.some((p) => pathname.startsWith(p))) return withQuery(undefined, pathname);
  if (!boundGroup) return { kind: 'refused', error: 'no-group' };
  return withQuery(boundGroup, pathname);
}

/** Per-call wait in ms, from the kit's method and RAW path; undefined means the adapter default. */
export type TimeoutFor = (method: HttpMethod, path: string) => number | undefined;

export interface CriblRequestOptions {
  timeoutMsFor?: TimeoutFor;
}

/**
 * Pure: a TimeoutFor giving `ms` to the kit's commit (POST .../version/commit) and
 * deploy (PATCH .../groups/<g>/deploy, products or master route) calls only. Every
 * other call keeps the adapter default.
 */
export function commitDeployTimeouts(ms: number): TimeoutFor {
  return (method, path) => {
    const pathname = path.split('?')[0]!;
    if (method === 'POST' && /\/version\/commit$/.test(pathname)) return ms;
    if (method === 'PATCH' && /^\/(products\/stream|master)\/groups\/[^/]+\/deploy$/.test(pathname)) return ms;
    return undefined;
  };
}

/**
 * A kit `Request` over the CriblClient port. `boundGroup` is the worker group that
 * group-relative kit paths (e.g. '/version/status') address. `options.timeoutMsFor`
 * sets CriblRequest.timeoutMs per call (see the header's Wait note).
 */
export function criblRequestFor(client: CriblClient, boundGroup?: string, options?: CriblRequestOptions): Request {
  const timeoutMsFor = options?.timeoutMsFor;
  return async (method, path, opts): Promise<ApiResponse> => {
    if (opts?.signal?.aborted) throw abortError();
    const upper = method.toUpperCase();
    if (!METHODS.has(upper)) return { status: 0, body: { error: 'unsupported-method', method } };
    const route = routeCriblPath(path, boundGroup);
    if (route.kind === 'refused') return { status: 0, body: { error: route.error, path } };
    const req: CriblRequest = { method: upper as HttpMethod, path: route.path };
    if (route.groupId !== undefined) req.groupId = route.groupId;
    if (route.query) req.query = route.query;
    if (opts?.body !== undefined) req.body = opts.body;
    const wait = timeoutMsFor?.(req.method, path);
    if (wait !== undefined) req.timeoutMs = wait;
    const res = await client.request(req);
    return { status: res.status, body: res.body };
  };
}
