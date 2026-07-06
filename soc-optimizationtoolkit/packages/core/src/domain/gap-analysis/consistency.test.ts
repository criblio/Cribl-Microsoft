/**
 * TEST 8 consistency contract - porting-plan Unit 18 ("TEST 8 consistency
 * contract becomes the spec"). Ported from legacy
 * tests/test-uat-transformations.ts testGapAnalysisMatcherConsistency.
 *
 * The DUAL-ENGINE SPLIT is only safe if the two engines AGREE on the shared
 * totals and substantially overlap on the overflow set, and if the DCR-side
 * partitioner never re-does a rename the DCR already performs. This pins that
 * agreement against the byte-faithful vendored CrowdStrikeCustomDCR.json (the
 * Process flow: 8 flows, 144-column Process stream) and the vendored
 * CrowdStrike FDR Process corpus.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseSampleContent } from "../sample-parsing/index";
import { matchFields, resolveSchemaFromCatalog } from "../field-matcher/index";
import { CROWDSTRIKE_CUSTOM_DCR } from "../../assets/sentinel-connectors/index";
import { analyzeDcrGap } from "./analyze-dcr-gap";
import { parseDcrJson } from "./kql-parser";
import type { FieldRef } from "./models";

const TABLE = "CrowdStrike_Process_Events_CL";

function readCorpus(table: string): string {
  const url = new URL(
    `../../assets/sample-corpus/${table}.json`,
    import.meta.url,
  );
  return readFileSync(url, "utf8");
}

describe("gap analysis vs field matcher consistency (uat TEST 8)", () => {
  const parsed = parseSampleContent(readCorpus(TABLE), { sourceName: TABLE });
  const sourceFields: FieldRef[] = parsed.fields.map((f) => ({
    name: f.name,
    type: f.type,
  }));
  const destSchema = resolveSchemaFromCatalog(TABLE);
  const dcr = parseDcrJson(JSON.stringify(CROWDSTRIKE_CUSTOM_DCR));
  const flow = dcr.flows.find((f) => f.tableName === TABLE);

  it("finds the Process flow in the vendored DCR (>=8 flows)", () => {
    expect(dcr.flows.length).toBeGreaterThanOrEqual(8);
    expect(flow).toBeDefined();
  });

  it("resolves a Process schema with >=20 columns", () => {
    expect(destSchema).not.toBeNull();
    expect(destSchema!.length).toBeGreaterThanOrEqual(20);
  });

  it("both engines agree on the source field count", () => {
    const gap = analyzeDcrGap(sourceFields, destSchema!, flow!);
    const match = matchFields(sourceFields, destSchema!, undefined, TABLE);
    expect(gap.totalSourceFields).toBe(match.totalSource);
  });

  it("both engines agree on the destination column count", () => {
    const gap = analyzeDcrGap(sourceFields, destSchema!, flow!);
    const match = matchFields(sourceFields, destSchema!, undefined, TABLE);
    expect(gap.totalDestFields).toBe(match.totalDest);
  });

  it("overflow sets overlap substantially (>30%)", () => {
    const gap = analyzeDcrGap(sourceFields, destSchema!, flow!);
    const match = matchFields(sourceFields, destSchema!, undefined, TABLE);
    const gapOverflow = new Set(gap.criblMustHandle.overflow.map((o) => o.field));
    const matchOverflow = new Set(match.overflow.map((o) => o.sourceName));
    let overlap = 0;
    for (const name of gapOverflow) if (matchOverflow.has(name)) overlap++;
    if (gapOverflow.size > 0 && matchOverflow.size > 0) {
      const rate = overlap / Math.min(gapOverflow.size, matchOverflow.size);
      expect(rate).toBeGreaterThan(0.3);
    }
  });

  it("never lists a DCR-renamed source in the Cribl residual (no duplicate work)", () => {
    const gap = analyzeDcrGap(sourceFields, destSchema!, flow!);
    const dcrRenamedSources = new Set(
      flow!.renames.map((r) => r.source.toLowerCase()),
    );
    const criblTouched = new Set<string>([
      ...gap.criblMustHandle.coercions.map((c) => c.field.toLowerCase()),
      ...gap.criblMustHandle.overflow.map((o) => o.field.toLowerCase()),
    ]);
    for (const src of dcrRenamedSources) {
      expect(criblTouched.has(src)).toBe(false);
    }
  });
});
