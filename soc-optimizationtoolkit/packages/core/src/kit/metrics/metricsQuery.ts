// `/system/metrics/query` — build the request from typed parts, and read the answer without ever
// turning a wrong shape into "no data".
//
// Standard: standards/cribl-metrics.md §1.
//
// Provenance: MEASURED live 2026-11-10 on a Cribl.Cloud leader (AZR-95), by reading Cribl Stream's own
// Monitoring traffic. The query is a LEADER-level POST /system/metrics/query; one worker group is
// selected in `where` (`__worker_group=="<g>" && __dist_mode=="worker"`), exactly as the Monitoring
// page does. The group-scoped POST /m/<g>/system/metrics/query that the 4.19.0 spec implies answers
// 404 ("Cannot POST /api/v1/system/metrics/query") - measured in the same session. The answer is
// `{results: [...], metrics, info}`, and an input row's label is `<type>:<id>` (e.g.
// `eventhub:azure_onb_eh_...`). TIME: a relative `earliest` is seconds-ago with no sign (`"86400s"`)
// or epoch milliseconds; `"-24h"` answers 200 with ZERO results (measured: it hid 158 real events),
// so {@link buildMetricsQueryBody} refuses any other relative form. `latest: "now"` works. One app sent `filterExpr`/`metricNameFilter` (not keys) and read
// `.items` (not the envelope); its card most likely never rendered and nothing said so.
//
// Declare in policies.yml:  - object: '/system/metrics/query'   actions: ['POST']   (leader route)

import { isOk, type Request } from './transport';

export type MetricsWindow = { cumulative: true } | { timeWindowSeconds: number };

export interface MetricsQuery {
  /** e.g. `sum("total.in_bytes").as(in_bytes)`. At least one. */
  aggregations: readonly string[];
  /** Dimensions to group by, e.g. `["input"]`. */
  splitBys?: readonly string[];
  /** One series for the range, or one row per window. Exactly one is required. */
  window: MetricsWindow;
  /**
   * Seconds ago as `"<N>s"` (e.g. `"86400s"`) or epoch milliseconds. Measured 2026-11-10: `"-24h"` and
   * `"-300s"` answer 200 with ZERO results, so any other string is refused ({@link relativeTime}).
   */
  earliest: string | number;
  /** `"now"`, seconds ago as `"<N>s"`, or epoch milliseconds. */
  latest: string | number;
  /** A filter expression, e.g. `input == 'syslog:in_syslog:udp'`. The key is `where` — not `filterExpr`. */
  where?: string;
  namespace?: string;
  alwaysBounds?: boolean;
}

/** The one metrics path: leader level. A worker group is chosen in `where` ({@link groupScopeWhere}). */
export const METRICS_QUERY_PATH = '/system/metrics/query';

/**
 * The `where` clause that limits a query to one worker group's workers, as Cribl's Monitoring page
 * writes it (measured 2026-11-10). `__dist_mode=="worker"` keeps the leader's own series out.
 */
export function groupScopeWhere(groupId: string): string {
  if (!groupId) throw new Error('metrics query needs a worker group id');
  return `__worker_group==${JSON.stringify(groupId)} && __dist_mode=="worker"`;
}

/** The query as sent for one group: the caller's `where`, if any, AND the group scope. */
export function scopedToGroup(groupId: string, q: MetricsQuery): MetricsQuery {
  const scope = groupScopeWhere(groupId);
  return { ...q, where: q.where ? `(${scope}) && (${q.where})` : scope };
}

/** Seconds ago, in the one relative form the metrics API reads: `"<N>s"`. */
export function secondsAgo(seconds: number): string {
  if (!(Number.isInteger(seconds) && seconds > 0)) throw new Error('secondsAgo needs a positive whole number of seconds');
  return `${seconds}s`;
}

/**
 * Throw on a time the metrics API would silently answer with nothing (measured 2026-11-10: a signed
 * `"-24h"` returned 200 and zero rows). Numbers are epoch milliseconds; `now` only where allowed.
 */
function relativeTime(name: 'earliest' | 'latest', value: string | number): void {
  if (typeof value === 'number') return;
  if (/^\d+s$/.test(value) || (name === 'latest' && value === 'now')) return;
  throw new Error(`metrics query ${name} "${value}" is not "<N>s"${name === 'latest' ? ', "now"' : ''} or epoch ms; the API would answer it with no rows`);
}

/** The literal request body. Show it, with method and path, in the panel's info popover. */
export function buildMetricsQueryBody(q: MetricsQuery): Record<string, unknown> {
  if (q.aggregations.length === 0) throw new Error('metrics query needs at least one aggregation');
  relativeTime('earliest', q.earliest);
  relativeTime('latest', q.latest);
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
  const r = await request('POST', METRICS_QUERY_PATH, { body: buildMetricsQueryBody(scopedToGroup(groupId, q)), signal });
  return parseMetricsAnswer(r.status, r.body);
}

/** Method, path and body for an info popover — the call as sent, so a reader can check it against the spec. */
export function describeMetricsRequest(groupId: string, q: MetricsQuery): { method: 'POST'; path: string; body: string } {
  return { method: 'POST', path: METRICS_QUERY_PATH, body: JSON.stringify(buildMetricsQueryBody(scopedToGroup(groupId, q)), null, 2) };
}
