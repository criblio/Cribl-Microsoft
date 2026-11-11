// LOCAL test, not a kit copy. The kit's metrics.test.ts also imports seriesEstimate,
// metricName and the metrics fakes, none of which core adopts, so it cannot run here
// unedited. These are its metricsQuery and counting cases, ported over the one
// clock-free transport (config-writes/fakes.test-util's fakeRequest), plus pins on the
// behaviour the onboarding live flow builds on.
import { describe, expect, it } from 'vitest';
import { fakeRequest } from '../config-writes/fakes.test-util';
import {
  buildMetricsQueryBody,
  describeMetricsRequest,
  groupScopeWhere,
  secondsAgo,
  METRICS_QUERY_PATH,
  scopedToGroup,
  parseMetricsAnswer,
  queryMetrics,
  type MetricsQuery,
} from './metricsQuery';
import {
  comparableWindows,
  deliveryByOutput,
  hopState,
  INTAKE_AGGREGATION,
  intakeByInput,
  parseEndpointLabel,
  parseRouteLabel,
} from './counting';

const q: MetricsQuery = {
  aggregations: ['sum("total.in_events").as(in_events)'],
  splitBys: ['input'],
  window: { cumulative: true },
  earliest: '3600s',
  latest: 'now',
  where: "input == 'syslog:in_syslog:udp'",
};

describe('metrics query', () => {
  it('POSTs to the leader path with documented body keys only', async () => {
    const { request, calls } = fakeRequest(() => ({ status: 200, body: { results: [{ input: 'a', in_events: 3 }] } }));
    const answer = await queryMetrics(request, 'default', q);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/system/metrics/query');
    const body = calls[0]!.options!.body as Record<string, unknown>;
    expect(body.where).toBe(`(__worker_group=="default" && __dist_mode=="worker") && (input == 'syslog:in_syslog:udp')`);
    expect(Object.keys(body).sort()).toEqual(['aggs', 'earliest', 'latest', 'where']);
    expect(body).not.toHaveProperty('filterExpr');
    expect(answer).toEqual({ kind: 'rows', rows: [{ input: 'a', in_events: 3 }] });
  });

  it('passes the abort signal to the transport', async () => {
    const { request, calls } = fakeRequest(() => ({ status: 200, body: { results: [] } }));
    const ctl = new AbortController();
    await queryMetrics(request, 'g1', q, ctl.signal);
    expect(calls[0]!.options!.signal).toBe(ctl.signal);
  });

  it('builds the cumulative and windowed aggs exactly', () => {
    expect(buildMetricsQueryBody({ ...q, where: undefined })).toEqual({
      aggs: { aggregations: ['sum("total.in_events").as(in_events)'], splitBys: ['input'], cumulative: true },
      earliest: '3600s',
      latest: 'now',
    });
    expect(buildMetricsQueryBody({ ...q, window: { timeWindowSeconds: 60 } }).aggs).toEqual({
      aggregations: ['sum("total.in_events").as(in_events)'],
      splitBys: ['input'],
      timeWindowSeconds: 60,
    });
  });

  // AZR-95 (measured 2026-11-10): a signed relative time answers 200 with ZERO rows, silently.
  it('refuses a relative time the API would answer with nothing, and accepts the measured forms', () => {
    for (const earliest of ['-24h', '-300s', '24h', 'now', '-1h']) {
      expect(() => buildMetricsQueryBody({ ...q, earliest })).toThrow(/no rows/);
    }
    expect(() => buildMetricsQueryBody({ ...q, latest: '-5m' })).toThrow(/no rows/);
    for (const [earliest, latest] of [['86400s', 'now'], ['300s', '0s'], [1, 2]] as const) {
      expect(() => buildMetricsQueryBody({ ...q, earliest, latest })).not.toThrow();
    }
    expect(secondsAgo(86400)).toBe('86400s');
    expect(() => secondsAgo(0)).toThrow();
    expect(() => secondsAgo(1.5)).toThrow();
  });

  it('requires a positive window and at least one aggregation', () => {
    expect(() => buildMetricsQueryBody({ ...q, window: { timeWindowSeconds: 0 } })).toThrow();
    expect(() => buildMetricsQueryBody({ ...q, aggregations: [] })).toThrow();
  });

  // AZR-95 (measured 2026-11-10): /m/<g>/system/metrics/query is a 404 on Cribl.Cloud; Cribl's own
  // Monitoring page sends the leader route and picks the group in `where`.
  it('is a leader-level path; the group is chosen in where, as the Monitoring page writes it', () => {
    expect(METRICS_QUERY_PATH).toBe('/system/metrics/query');
    expect(() => groupScopeWhere('')).toThrow();
    expect(groupScopeWhere('DatacenterEast')).toBe('__worker_group=="DatacenterEast" && __dist_mode=="worker"');
    // A quote in a group id cannot close the string early.
    expect(groupScopeWhere('a"b')).toBe('__worker_group=="a\\"b" && __dist_mode=="worker"');
    expect(scopedToGroup('g1', { ...q, where: undefined }).where).toBe('__worker_group=="g1" && __dist_mode=="worker"');
    expect(scopedToGroup('g1', { ...q, where: "input == 'x'" }).where).toBe(
      '(__worker_group=="g1" && __dist_mode=="worker") && (input == \'x\')',
    );
  });

  it('queryMetrics sends ONE leader POST whose where scopes the group, never /m/<g>/', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const request = async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, body: opts?.body });
      return { status: 200, body: { results: [] } };
    };
    await queryMetrics(request as never, 'DatacenterEast', { ...q, where: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/system/metrics/query');
    expect((calls[0]!.body as { where?: string }).where).toBe('__worker_group=="DatacenterEast" && __dist_mode=="worker"');
  });

  // The measured answer (Cribl Stream Monitoring > Sources, DatacenterEast, 2026-11-10), trimmed to
  // the rows the onboarding flow reads plus two neighbours. Both onboarding inputs had 8 events.
  it('parses the measured live answer: {results, metrics, info}, inputs labelled <type>:<id>', () => {
    const live = {
      results: [
        { events: 8, bytes: 53020, totalRequests: 8, input: 'eventhub:azure_onb_eh_ehnsjpedersoneastus_ehjpedersoneastus', __worker_group: 'DatacenterEast' },
        { events: 8, bytes: 53020, totalRequests: 8, input: 'eventhub:azure_onb_eh_fa882ef2_ehnsjpedersoneastus_ehjpedersoneastus', __worker_group: 'DatacenterEast' },
        { events: 1800, bytes: 646387, input: 'syslog:PaloAlto:tcp', __worker_group: 'DatacenterEast' },
        { p95DurationMillis: 0, input: 'http:http', __worker_group: 'DatacenterEast' },
      ],
      metrics: { 'metrics_reader.matched': 426, 'metrics_aggregator.results': 23 },
      info: {},
    };
    const a = parseMetricsAnswer(200, live);
    expect(a.kind).toBe('rows');
    const rows = a.kind === 'rows' ? a.rows : [];
    expect(rows).toHaveLength(4);
    expect(parseEndpointLabel(String(rows[1]!['input']), new Set())).toMatchObject({
      type: 'eventhub',
      id: 'azure_onb_eh_fa882ef2_ehnsjpedersoneastus_ehjpedersoneastus',
    });
  });

  it('reads {items} as an error, never as empty', () => {
    const a = parseMetricsAnswer(200, { items: [{ x: 1 }] });
    expect(a).toMatchObject({ kind: 'error', reason: 'unexpected-shape', status: 200 });
  });

  it('separates empty from error', () => {
    expect(parseMetricsAnswer(200, { results: [] })).toEqual({ kind: 'empty' });
    expect(parseMetricsAnswer(403, 'Not authorized or licensed')).toEqual({
      kind: 'error',
      status: 403,
      reason: 'http',
      detail: 'Not authorized or licensed',
    });
  });

  it('drops non-object rows, and an all-junk result is empty', () => {
    expect(parseMetricsAnswer(200, { results: [1, null, [2], { input: 'a' }] })).toEqual({ kind: 'rows', rows: [{ input: 'a' }] });
    expect(parseMetricsAnswer(200, { results: [1, null] })).toEqual({ kind: 'empty' });
  });

  it('describes the call honestly as a POST with the literal body', () => {
    const d = describeMetricsRequest('default', q);
    expect(d.method).toBe('POST');
    expect(d.path).toBe('/system/metrics/query');
    expect(JSON.parse(d.body)).toEqual(buildMetricsQueryBody(scopedToGroup('default', q)));
  });
});

describe('labels', () => {
  const packs = new Set(['acme_pack']);
  it('reads the pack-qualified form only for an installed pack', () => {
    expect(parseEndpointLabel('http:acme_pack.in_events', packs)).toMatchObject({ type: 'http', packId: 'acme_pack', id: 'in_events' });
    expect(parseEndpointLabel('http:some.dotted.id', packs)).toMatchObject({ id: 'some.dotted.id' });
    expect(parseEndpointLabel('http:some.dotted.id', packs)?.packId).toBeUndefined();
  });

  it('keeps extra segments and rejects a label with no id', () => {
    expect(parseEndpointLabel('syslog:in_syslog:tcp', packs)).toMatchObject({ id: 'in_syslog', extra: ['tcp'] });
    expect(parseEndpointLabel('eventhub:azure_onb_eh_ns_hub', new Set())).toEqual({
      type: 'eventhub',
      id: 'azure_onb_eh_ns_hub',
      extra: [],
      raw: 'eventhub:azure_onb_eh_ns_hub',
    });
    expect(parseEndpointLabel('eventhub', packs)).toBeNull();
    expect(parseEndpointLabel('eventhub:', packs)).toBeNull();
  });

  it('parses route labels', () => {
    expect(parseRouteLabel('acme_pack.route1', packs)).toEqual({ packId: 'acme_pack', id: 'route1' });
    expect(parseRouteLabel('route1', packs)).toEqual({ id: 'route1' });
  });
});

describe('counting', () => {
  it('sums intake by input and delivery by output, skipping non-numeric values', () => {
    const rows = [
      { input: 'a', in_events: 2 },
      { input: 'a', in_events: 3 },
      { output: 'o1', out_events: 5 },
      { input: 'b', in_events: 'x' },
    ];
    expect(intakeByInput(rows)).toEqual(new Map([['a', 5]]));
    expect(deliveryByOutput(rows)).toEqual(new Map([['o1', 5]]));
  });

  it('keeps a measured zero as a zero, not a missing input', () => {
    expect(intakeByInput([{ input: 'a', in_events: 0 }])).toEqual(new Map([['a', 0]]));
  });

  it('names the intake counter total.in_events', () => {
    expect(INTAKE_AGGREGATION).toBe('sum("total.in_events").as(in_events)');
  });

  it('never reads zero throughput as blocked', () => {
    expect(hopState({ throughput: 0, backpressure: 0, blocked: 0 })).toBe('idle');
    expect(hopState({ throughput: 0, backpressure: 1, blocked: 0 })).toBe('blocked');
    expect(hopState({ throughput: 4, backpressure: null, blocked: null })).toBe('flowing');
    expect(hopState({ throughput: null, backpressure: null, blocked: null })).toBe('unknown');
  });

  it('refuses to compare counts over different windows', () => {
    expect(comparableWindows({ earliest: 0, latest: 10 }, { earliest: 0, latest: 11 })).toBe(false);
    expect(comparableWindows({ earliest: 0, latest: 10 }, { earliest: 0, latest: 11 }, 1)).toBe(true);
  });
});
