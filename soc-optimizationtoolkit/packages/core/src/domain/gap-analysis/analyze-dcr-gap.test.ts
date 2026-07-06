import { describe, it, expect } from "vitest";
import {
  analyzeDcrGap,
  CRIBL_INTERNAL_FIELDS,
  COLLISION_PRONE_INTERNAL_FIELDS,
  typesCompatible,
} from "./analyze-dcr-gap";
import type { DcrFlow, FieldRef } from "./models";
import { CROWDSTRIKE_FDR_PROFILE, DEFAULT_GAP_PROFILE } from "./vendor-profile";

const FLOW: DcrFlow = {
  outputStream: "Custom-T_CL",
  tableName: "T_CL",
  eventSimpleNames: [],
  renames: [{ dest: "DestName", source: "srcRenamed" }],
  typeConversions: [{ field: "coercedByDcr", toType: "long" }],
  columns: [],
};

const DEST: FieldRef[] = [
  { name: "PassName", type: "string" }, // exact + same type -> passthrough
  { name: "coercedByDcr", type: "long" }, // DCR coerces -> passthrough
  { name: "NeedsCoerce", type: "long" }, // mismatch, DCR does not coerce -> Cribl coercion
];

const SOURCE: FieldRef[] = [
  { name: "srcRenamed", type: "string" }, // DCR-renamed -> passthrough + dcrHandled
  { name: "PassName", type: "string" }, // exact passthrough
  { name: "coercedByDcr", type: "string" }, // DCR coerces -> passthrough
  { name: "NeedsCoerce", type: "real" }, // real vs long, DCR silent -> Cribl coercion
  { name: "notInDest", type: "string" }, // overflow
  { name: "source", type: "string" }, // collision-prone drop -> WARNING
  { name: "cribl_pipe", type: "string" }, // internal drop, no warning
];

describe("analyzeDcrGap DCR-side partitioning", () => {
  const gap = analyzeDcrGap(SOURCE, DEST, FLOW);

  it("counts totals, passthrough, overflow, and DCR-handled", () => {
    expect(gap.totalSourceFields).toBe(7);
    expect(gap.totalDestFields).toBe(3);
    expect(gap.passthroughCount).toBe(3);
    expect(gap.overflowCount).toBe(1);
    // init (1 rename + 1 coercion) + 1 source matched a DCR rename
    expect(gap.dcrHandledCount).toBe(3);
  });

  it("routes a DCR-renamed source through untouched (never into criblMustHandle)", () => {
    expect(
      gap.criblMustHandle.coercions.some((c) => c.field === "srcRenamed"),
    ).toBe(false);
    expect(
      gap.criblMustHandle.overflow.some((o) => o.field === "srcRenamed"),
    ).toBe(false);
  });

  it("emits a Cribl coercion only for an incompatible, DCR-unhandled type", () => {
    expect(gap.criblMustHandle.coercions).toEqual([
      {
        field: "NeedsCoerce",
        fromType: "real",
        toType: "long",
        reason:
          "Type mismatch: source real vs dest long, not handled by DCR",
      },
    ]);
  });

  it("passes a DCR-coerced field through (Cribl must not duplicate the coercion)", () => {
    expect(
      gap.criblMustHandle.coercions.some((c) => c.field === "coercedByDcr"),
    ).toBe(false);
  });

  it("overflows a source field absent from the destination schema", () => {
    expect(gap.criblMustHandle.overflow).toEqual([
      { field: "notInDest", type: "string" },
    ]);
  });

  it("NEVER populates criblMustHandle.renames (dead case-mismatch branch removed)", () => {
    // Renames are the field matcher's domain now (dual-engine split). The only
    // legacy code that pushed here was the unreachable case-mismatch branch.
    expect(gap.criblMustHandle.renames).toEqual([]);
  });
});

describe("analyzeDcrGap deleted dead code: case-insensitive names resolve exactly", () => {
  it("treats a case-differing source name as an exact-map hit, not a rename", () => {
    const gap = analyzeDcrGap(
      [{ name: "PASSNAME", type: "string" }],
      [{ name: "PassName", type: "string" }],
      { ...FLOW, renames: [], typeConversions: [] },
    );
    expect(gap.passthroughCount).toBe(1);
    expect(gap.criblMustHandle.renames).toEqual([]);
    // No "Case mismatch" reason survives (the dead branch is gone).
    expect(gap.criblMustHandle.overflow).toEqual([]);
  });
});

describe("analyzeDcrGap data-loss footgun (surface, do not silently drop)", () => {
  it("drops a real vendor field colliding with the internal drop-set AND warns", () => {
    const gap = analyzeDcrGap(SOURCE, DEST, FLOW);
    expect(gap.criblMustHandle.drops.some((d) => d.field === "source")).toBe(
      true,
    );
    expect(gap.warnings.some((w) => w.includes('"source"'))).toBe(true);
  });

  it("warns for each collision-prone name (source/host/port/sourcetype/index)", () => {
    for (const name of ["source", "host", "port", "sourcetype", "index"]) {
      const gap = analyzeDcrGap([{ name, type: "string" }], DEST, FLOW);
      expect(gap.warnings.length).toBe(1);
      expect(gap.warnings[0]).toContain(`"${name}"`);
    }
  });

  it("drops a genuinely-internal field WITHOUT a data-loss warning", () => {
    const gap = analyzeDcrGap([{ name: "cribl_pipe", type: "string" }], DEST, FLOW);
    expect(gap.criblMustHandle.drops.some((d) => d.field === "cribl_pipe")).toBe(
      true,
    );
    expect(gap.warnings).toEqual([]);
  });
});

describe("analyzeDcrGap enrichments are vendor-parameterized", () => {
  it("default profile emits only the table-generic Type enrichment", () => {
    const gap = analyzeDcrGap(SOURCE, DEST, FLOW, DEFAULT_GAP_PROFILE);
    expect(gap.criblMustHandle.enrichments).toEqual([
      { field: "Type", value: "'T_CL'" },
    ]);
  });

  it("CrowdStrike profile prepends the verbatim _time enrichment", () => {
    const gap = analyzeDcrGap(SOURCE, DEST, FLOW, CROWDSTRIKE_FDR_PROFILE);
    expect(gap.criblMustHandle.enrichments[0]).toEqual({
      field: "_time",
      value:
        "Number(timestamp) / 1000 || Number(ContextTimeStamp) || Date.now() / 1000",
    });
    expect(gap.criblMustHandle.enrichments[1]).toEqual({
      field: "Type",
      value: "'T_CL'",
    });
  });
});

describe("the Cribl-internal drop-set is verbatim", () => {
  it("pins CRIBL_INTERNAL_FIELDS exactly", () => {
    expect([...CRIBL_INTERNAL_FIELDS].sort()).toEqual(
      [
        "cribl_breaker",
        "cribl_pipe",
        "cribl_host",
        "cribl_input",
        "cribl_output",
        "cribl_wp",
        "__inputId",
        "__criblMetrics",
        "__final",
        "__channel",
        "__destHost",
        "__destPort",
        "__spanId",
        "__traceId",
        "__header_content_type",
        "__header_content_length",
        "source",
        "host",
        "port",
        "sourcetype",
        "index",
      ].sort(),
    );
  });

  it("pins the collision-prone subset", () => {
    expect([...COLLISION_PRONE_INTERNAL_FIELDS].sort()).toEqual(
      ["host", "index", "port", "source", "sourcetype"],
    );
  });
});

describe("typesCompatible", () => {
  it("treats string as compatible with anything and reconciles int/long, real/double", () => {
    expect(typesCompatible("string", "long")).toBe(true);
    expect(typesCompatible("int", "long")).toBe(true);
    expect(typesCompatible("real", "double")).toBe(true);
    expect(typesCompatible("real", "long")).toBe(false);
    expect(typesCompatible("boolean", "string")).toBe(false);
  });
});
