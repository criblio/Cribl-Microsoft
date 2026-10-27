// Reading metric labels and counting with them.
//
// Standard: standards/cribl-metrics.md §3; the same id forms as standards/cribl-pack-conventions.md
// (`__inputId`) and the route-filter attribution in standards/cribl-dataflow-diagram.md.
//
// Provenance:
//  - Inside a pack, `total.*`/`route.*` labels carry the pack: input `<type>:<packId>.<inputId>`,
//    output `<type>:<packId>.<outputId>`, route `<packId>.<routeId>` — Measured 2026-09-24/25.
//  - Health/backpressure/blocked rows for an idle pack output appeared WITHOUT the prefix —
//    Measured 2026-09-25. `pipe.*` inside a pack is unmeasured: nothing here builds on it.
//  - Outside a pack an input id can carry extra segments (`syslog:<id>:tcp`) — Measured 2026-08-25.
//  - The counting rules (intake from `total.in_events` by input; delivery per destination from
//    `total.out_events`) are the house design over those labels.
//
// A dot in an id is not proof of a pack: ids may legitimately contain dots. Pass the installed pack
// ids and the parser only reads `<packId>.` when it names one of them — no guessing.

export interface ParsedEndpointLabel {
  type: string;
  /** Present only when the prefix names an installed pack. */
  packId?: string;
  id: string;
  /** Segments after the id, e.g. `tcp` in `syslog:in_syslog:tcp`. */
  extra: string[];
  raw: string;
}

/** Parse an `input`/`output` label: `<type>:<id>`, `<type>:<id>:<seg>…`, or `<type>:<packId>.<id>`. */
export function parseEndpointLabel(label: string, installedPackIds: ReadonlySet<string>): ParsedEndpointLabel | null {
  const parts = label.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const [type, idPart, ...extra] = parts as [string, string, ...string[]];
  const dot = idPart.indexOf('.');
  if (dot > 0) {
    const maybePack = idPart.slice(0, dot);
    if (installedPackIds.has(maybePack)) return { type, packId: maybePack, id: idPart.slice(dot + 1), extra, raw: label };
  }
  return { type, id: idPart, extra, raw: label };
}

/** Parse a `route` label: `<routeId>` or, inside a pack, `<packId>.<routeId>`. */
export function parseRouteLabel(label: string, installedPackIds: ReadonlySet<string>): { packId?: string; id: string } {
  const dot = label.indexOf('.');
  if (dot > 0 && installedPackIds.has(label.slice(0, dot))) return { packId: label.slice(0, dot), id: label.slice(dot + 1) };
  return { id: label };
}

export interface MetricRow {
  [label: string]: unknown;
}

function sumBy(rows: readonly MetricRow[], labelKey: string, valueKey: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const label = row[labelKey];
    const value = row[valueKey];
    if (typeof label !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out.set(label, (out.get(label) ?? 0) + value);
  }
  return out;
}

/**
 * Source intake: `total.in_events` split by `input`. Not `pipe.in_events` by `from_input`, which
 * counts per pipeline path. `valueKey` is the alias the aggregation was given.
 */
export const intakeByInput = (rows: readonly MetricRow[], valueKey = 'in_events'): Map<string, number> => sumBy(rows, 'input', valueKey);

/**
 * Delivery: each destination's own `total.out_events`. On a dual-written (source, pipeline) pair
 * `pipe.out_events` counts an event once per path, so summing it over-counts.
 */
export const deliveryByOutput = (rows: readonly MetricRow[], valueKey = 'out_events'): Map<string, number> => sumBy(rows, 'output', valueKey);

/** The `aggregations` that feed the two counters above. */
export const INTAKE_AGGREGATION = 'sum("total.in_events").as(in_events)';
export const DELIVERY_AGGREGATION = 'sum("total.out_events").as(out_events)';

export type HopState = 'flowing' | 'idle' | 'blocked' | 'unknown';

/**
 * A hop's state. Blocked comes from backpressure/blocked counters — zero throughput is also what an
 * idle source looks like, so it never means blocked on its own. Missing inputs answer `unknown`.
 */
export function hopState(input: { throughput: number | null; backpressure: number | null; blocked: number | null }): HopState {
  if ((input.blocked ?? 0) > 0 || (input.backpressure ?? 0) > 0) return 'blocked';
  if (input.throughput === null) return 'unknown';
  return input.throughput > 0 ? 'flowing' : 'idle';
}

/**
 * Record-derived counts (from Search) and telemetry counts (from metrics) compared over different
 * windows read as data loss. Refuse the comparison unless the windows match.
 */
export function comparableWindows(a: { earliest: number; latest: number }, b: { earliest: number; latest: number }, toleranceMs = 0): boolean {
  return Math.abs(a.earliest - b.earliest) <= toleranceMs && Math.abs(a.latest - b.latest) <= toleranceMs;
}
