/**
 * GEN-24, END TO END on the UAT capture: a PAN-OS CEF pack built from the
 * THREAT and TRAFFIC samples DBT-196 splits out routes each by its header TYPE.
 *
 * The core pins (route-panos-cef.test.ts) cover the derivation and the edge
 * lines. This one runs the path the integrate screen takes - captureSamples on
 * the live-shaped body, plannedCaptureSamples, value evidence from the parsed
 * records exactly as integrate-screen builds it, and the REAL
 * derivePipelinePreview - so wiring that type-checks and never arrives fails
 * here. Before the fix this capture routed THREAT on `PanOSContentVer ===
 * 'AppThreat-8800-8888'` and, with a narrow mapping, left TRAFFIC on a
 * placeholder.
 */

import { describe, expect, it } from "vitest";
import type { CriblClient, GapFieldMapping, GapReport } from "@soc/core";
import {
  EMPTY_OVERFLOW_TRIAGE,
  captureSamples,
  fieldValuesFromRecords,
} from "@soc/core";
import {
  panosCefCaptureBody,
  panosCefRaw,
} from "../samples/panos-cef-capture-test-fixture";
import { plannedCaptureSamples } from "../samples/capture-panel-state";
import { derivePipelinePreview } from "./pipeline-preview-state";

const EVENTS = 100;

const THREAT_FILTER =
  "typeof _raw === 'string' && /CEF:(?:\\\\[\\s\\S]|[^|\\\\])*\\|Palo Alto Networks\\|PAN-OS\\|(?:\\\\[\\s\\S]|[^|\\\\])*\\|(?:\\\\[\\s\\S]|[^|\\\\])*\\|THREAT\\|/.test(_raw)";
const TRAFFIC_FILTER = THREAT_FILTER.replace("THREAT", "TRAFFIC");

/** A YAML double-quoted scalar's value; any escape but `\\` and `\"` throws. */
function yamlDoubleQuoted(body: string): string {
  return body.replace(/\\([\s\S])/g, (_, c: string) => {
    if (c === "\\" || c === '"') return c;
    throw new Error(`invalid YAML escape \\${c} in ${body}`);
  });
}

function routeFilters(yaml: string): string[] {
  return [...yaml.matchAll(/^ {4}filter: "((?:[^"\\]|\\.)*)"$/gm)].map((m) =>
    yamlDoubleQuoted(m[1] ?? ""),
  );
}

function matches(filter: string, raw: string): boolean {
  return Boolean(new Function("_raw", `return (${filter});`)(raw));
}

function keep(name: string): GapFieldMapping {
  return {
    source: name,
    dest: name,
    sourceType: "string",
    destType: "string",
    confidence: "exact",
    action: "keep",
    needsCoercion: false,
    description: "",
  };
}

function report(logType: string, fields: readonly string[]): GapReport {
  return {
    tableName: "CommonSecurityLog",
    logType,
    stats: [],
    sourceFieldCount: fields.length,
    destFieldCount: 0,
    passthroughCount: 0,
    dcrHandledCount: 0,
    criblHandledCount: 0,
    overflowCount: 0,
    dcrRenames: [],
    dcrCoercions: [],
    criblRenames: [],
    criblCoercions: [],
    dcrHandlesSummary: "",
    criblHandlesSummary: "",
    routeCondition: "true",
    fieldMappings: fields.map(keep),
    destSchema: [],
    overflowLossy: false,
    overflowTriage: EMPTY_OVERFLOW_TRIAGE,
    warnings: [],
  };
}

async function capturedSamples() {
  const cribl = {
    request: async () => ({ status: 200, body: panosCefCaptureBody(EVENTS) }),
  } as unknown as CriblClient;
  const result = await captureSamples(cribl, {
    groupId: "default",
    filter: "__inputId=='syslog:in_syslog'",
    maxEvents: EVENTS,
  });
  return plannedCaptureSamples(result.splits, "capture:in_syslog");
}

describe("the UAT PAN-OS CEF capture builds a pack that routes by header TYPE", () => {
  // Two mapping shapes: every field kept (what a gap analysis hands over), and
  // a single shared field (the narrow case that used to placeholder TRAFFIC).
  for (const shape of ["every field", "one shared field"] as const) {
    it(`emits exactly the two header-TYPE filters, with ${shape} mapped`, async () => {
      const samples = await capturedSamples();
      expect(samples.map((s) => [s.logType, s.parsed.records.length])).toEqual([
        ["THREAT", 50],
        ["TRAFFIC", 50],
      ]);

      const view = derivePipelinePreview({
        solutionName: "PaloAlto-PAN-OS",
        packName: "paloalto-sentinel",
        reports: samples.map((s) =>
          report(
            s.logType,
            shape === "every field" ? s.parsed.fields.map((f) => f.name) : ["src"],
          ),
        ),
        sampleFormats: Object.fromEntries(samples.map((s) => [s.logType, s.format])),
        sampleFieldValues: Object.fromEntries(
          samples.map((s) => [
            s.logType,
            fieldValuesFromRecords(s.logType, s.parsed.records),
          ]),
        ),
        approved: true,
      });

      expect(view.plan?.tables.map((t) => [t.logType, t.routeCondition])).toEqual([
        ["THREAT", THREAT_FILTER],
        ["TRAFFIC", TRAFFIC_FILTER],
      ]);
      expect(view.placeholderLogTypes).toEqual([]);
      expect(view.unreachableLogTypes).toEqual([]);
      expect(view.routeYmlIssues).toEqual([]);

      // Reduction + passthrough per log type: the two filters, nothing else.
      const filters = routeFilters(view.routeYml);
      expect(filters).toEqual([
        THREAT_FILTER,
        THREAT_FILTER,
        TRAFFIC_FILTER,
        TRAFFIC_FILTER,
      ]);

      // Each filter, as loaded from route.yml, selects exactly its own lines
      // out of all 100 the capture returned (even = THREAT, odd = TRAFFIC).
      const lines = Array.from({ length: EVENTS }, (_, i) => panosCefRaw(i));
      const own = (parity: number) => lines.filter((_, i) => i % 2 === parity);
      expect(lines.filter((l) => matches(filters[0] ?? "false", l))).toEqual(own(0));
      expect(lines.filter((l) => matches(filters[2] ?? "false", l))).toEqual(own(1));
    });
  }
});
