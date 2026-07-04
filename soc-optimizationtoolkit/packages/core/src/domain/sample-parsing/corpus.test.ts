import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseSampleContent } from "./index";
import { CROWDSTRIKE_FDR_CORPUS } from "../../assets/sample-corpus/manifest";

// Characterization ported near-verbatim from the legacy
// IS-T/test-uat-crowdstrike.ts "TEST 2: Sample Parsing" block, run against the
// byte-faithful vendored crowdstrike-fdr corpus. This is the golden guard that
// the ported parser reproduces legacy behavior on real customer data.

function readCorpus(table: string): string {
  const url = new URL(`../../assets/sample-corpus/${table}.json`, import.meta.url);
  return readFileSync(url, "utf8");
}

describe("crowdstrike-fdr corpus (characterization)", () => {
  it.each(CROWDSTRIKE_FDR_CORPUS)("parses %s like legacy", (table) => {
    const parsed = parseSampleContent(readCorpus(table), { sourceName: `${table}.json` });

    // FDR captures are NDJSON.
    expect(["ndjson", "json"]).toContain(parsed.format);
    expect(parsed.eventCount).toBeGreaterThan(0);
    expect(parsed.fields.length).toBeGreaterThan(0);
    expect(parsed.errors).toEqual([]);

    // CrowdStrike common fields.
    const fieldNames = new Set(parsed.fields.map((f) => f.name));
    expect(fieldNames.has("event_simpleName")).toBe(true);
    expect(fieldNames.has("aid")).toBe(true);
    expect(fieldNames.has("timestamp")).toBe(true);
    expect(fieldNames.has("cid")).toBe(true);

    // Timestamp detection + epoch-ms-string type inference.
    expect(parsed.timestampField).toBe("timestamp");
    const tsField = parsed.fields.find((f) => f.name === "timestamp");
    expect(tsField).toBeDefined();
    expect(["int", "string"]).toContain(tsField?.type);

    // Every raw event is valid JSON.
    for (const raw of parsed.rawEvents) {
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it("caps rawEvents at 200 even on the largest file", () => {
    const parsed = parseSampleContent(
      readCorpus("CrowdStrike_Additional_Events_CL"),
    );
    expect(parsed.rawEvents.length).toBeLessThanOrEqual(200);
  });
});
