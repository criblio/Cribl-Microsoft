// `/system/metrics/query` — build the request from typed parts, and read the answer without ever
// turning a wrong shape into "no data".
//
// Standard: standards/cribl-metrics.md §1.
//
// Provenance: Documented, NOT measured live — the request and response shapes come from the
// 4.19.0 `openapi.json` bundled with the App Platform scaffold (`SystemMetricsQueryRequest`,
// `CriblEventEnvelop`). Confirm against one real response before building a headline number on it.
// One app sent `filterExpr`/`metricNameFilter` (not keys) and read `.items` (not the envelope); its
// card most likely never rendered and nothing said so (inferred from the code against the spec).
//
// Declare in policies.yml:  - object: '/m/:gid/system/metrics/query'   actions: ['POST']

import { isOk, type Request } from './transport';

export type MetricsWindow = { cumulative: true } | { timeWindowSeconds: number };

export interface MetricsQuery {
  /** e.g. `sum("total.in_bytes").as(in_bytes)`. At least one. */
  aggregations: readonly string[];
  /** Dimensions to group by, e.g. `["input"]`. */
  splitBys?: readonly string[];
  /** One series for the range, or one row per window. Exactly one is required. */
  window: MetricsWindow;
  /** Relative (`-1h`, `now`) or epoch milliseconds. */
  earliest: string | number;
  latest: string | number;
  /** A filter expression, e.g. `input == 'syslog:in_syslog:udp'`. The key is `where` — not `filterExpr`. */
  where?: string;
  namespace?: string;
  alwaysBounds?: boolean;
}

export function metricsQueryPath(groupId: string): string {
  if (!groupId) throw new Error('metrics query needs a worker group id');
  return `/m/${encodeURIComponent(groupId)}/system/metrics/query`;
}

/** The literal request body. Show it, with method and path, in the panel's info popover. */
export function buildMetricsQueryBody(q: MetricsQuery): Record<string, unknown> {
  if (q.aggregations.length === 0) throw new Error('metrics query needs at least one aggregation');
  const aggs: Record<string, unknown> = { aggregations: [...q.aggregations] };
  if (q.splitBys?.length) aggs.splitBys = [...q.splitBys];
  if ('cumulative' in q.window) aggs.cumulative = true;
  else {
    if (!(q.window.timeWindowSeconds > 0)) throw new Error('timeWindowSeconds must be positive');
    aggs.timeWindowSeconds = q.window.timeWindowSeconds;
  }
  const body: Record<string, unknown> = { aggs, earliest: q.earliest, latest: q.latest };
  if (q.where) body.where = q.where;
  if (q.namespace) body.namespace = q.namespace;
  if (q.alwaysBounds !== undefined) body.alwaysBounds = q.alwaysBounds;
  return body;
}

/** What a panel renders from. Four answers — "empty" and "error" are different states, and neither hides the panel. */
export type MetricsAnswer =
  | { kind: 'rows'; rows: Record<string, unknown>[] }
  | { kind: 'empty' }
  | { kind: 'error'; status: number; reason: 'http' | 'unexpected-shape'; detail: string };

/**
 * Parse a response. `{results: [...]}` is the documented envelope. Anything else — including the
 * `{items: [...]}` envelope most other Cribl collections use — is an error, NOT an empty answer:
 * reading the wrong key is precisely how a headline card silently vanishes.
 */
export function parseMetricsAnswer(status: number, body: unknown): MetricsAnswer {
  if (!isOk(status)) {
    return { kind: 'error', status, reason: 'http', detail: typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body ?? '').slice(0, 300) };
  }
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
    return { kind: 'error', status, reason: 'unexpected-shape', detail: `expected {results: [...]}, got ${keys || 'nothing'}` };
  }
  const rows = results.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  return rows.length ? { kind: 'rows', rows } : { kind: 'empty' };
}

/** Run a metrics query. A config-plane read: no Search job, nothing billed. */
export async function queryMetrics(request: Request, groupId: string, q: MetricsQuery, signal?: AbortSignal): Promise<MetricsAnswer> {
  const r = await request('POST', metricsQueryPath(groupId), { body: buildMetricsQueryBody(q), signal });
  return parseMetricsAnswer(r.status, r.body);
}

/** Method, path and body for an info popover — the call as sent, so a reader can check it against the spec. */
export function describeMetricsRequest(groupId: string, q: MetricsQuery): { method: 'POST'; path: string; body: string } {
  return { method: 'POST', path: metricsQueryPath(groupId), body: JSON.stringify(buildMetricsQueryBody(q), null, 2) };
}
