/**
 * Pins for the sample-source inventory (plan Phase 3, ADR 0003).
 *
 * The honesty rule under almost all of them: an EMPTY list and a FAILED read
 * must never render the same. "You have no Lake datasets" sends the operator to
 * upload a file; "the Lake read returned 403" sends them to fix a permission.
 * Collapsing the second into the first is how someone concludes their whole
 * environment has nothing to offer.
 */

import { describe, expect, it } from "vitest";

import {
  allEntries,
  buildSampleSourceInventory,
  hasAnySource,
  parseCriblSources,
  parseLakeDatasets,
  parseSearchDatasets,
} from "./inventory";
import type { SampleSourceKind } from "./models";

const okBody = (items: unknown[]) => ({ status: 200, body: { count: items.length, items } });

function sectionOf(inv: ReturnType<typeof buildSampleSourceInventory>, kind: SampleSourceKind) {
  const s = inv.sections.find((x) => x.kind === kind);
  if (s === undefined) throw new Error(`no section for ${kind}`);
  return s;
}

describe("parseSearchDatasets", () => {
  it("keeps id and prefers description over provider for the detail line", () => {
    const out = parseSearchDatasets(
      [
        { id: "pfsense", type: "s3", provider: "aws_s3", description: "Firewall logs" },
        { id: "corelight", type: "s3", provider: "aws_s3" },
      ],
      "default_search",
    );
    expect(out.map((d) => d.id)).toEqual(["pfsense", "corelight"]);
    expect(out[0].detail).toBe("Firewall logs");
    // No description: falls back to the provider rather than showing nothing.
    expect(out[1].detail).toBe("aws_s3");
  });

  it("carries the SEARCH group id on every entry - they are group-addressed", () => {
    const out = parseSearchDatasets([{ id: "d1" }], "default_search");
    expect(out[0].groupId).toBe("default_search");
    expect(out[0].kind).toBe("search-dataset");
  });

  it("skips entries with no usable id rather than inventing one", () => {
    const out = parseSearchDatasets([{ id: "" }, { id: "  " }, {}, null, "x", { id: "ok" }], "g");
    expect(out.map((d) => d.id)).toEqual(["ok"]);
  });
});

describe("parseLakeDatasets", () => {
  it("reads the retained size out of the metrics snapshot", () => {
    const out = parseLakeDatasets([
      { id: "lake_ds", description: "Retained", metrics: { currentSizeBytes: 4096, metricsDate: "2026-08-18" } },
    ]);
    expect(out[0].sizeBytes).toBe(4096);
    expect(out[0].detail).toBe("Retained");
  });

  it("carries NO groupId - Lake datasets are a leader route", () => {
    // The distinction that makes the request correct: Search datasets need
    // /m/{group}/, Lake datasets must not have one.
    const out = parseLakeDatasets([{ id: "lake_ds" }]);
    expect(out[0].groupId).toBeUndefined();
    expect(out[0].kind).toBe("lake-dataset");
  });

  it("omits sizeBytes when no metrics snapshot exists, rather than reporting 0", () => {
    // A zero would read as "this dataset is empty", which is a different claim.
    const out = parseLakeDatasets([{ id: "fresh" }, { id: "odd", metrics: { currentSizeBytes: "big" } }]);
    expect(out[0].sizeBytes).toBeUndefined();
    expect(out[1].sizeBytes).toBeUndefined();
  });
});

describe("parseCriblSources", () => {
  it("keeps disabled sources, FLAGGED rather than hidden", () => {
    // A disabled source is the likeliest reason a capture returns nothing.
    // Hiding it turns a one-glance answer into a support question.
    const out = parseCriblSources(
      [
        { id: "in_syslog", type: "syslog" },
        { id: "in_http", type: "http", disabled: true },
      ],
      "default",
    );
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id === "in_http")?.disabled).toBe(true);
    expect(out.find((s) => s.id === "in_syslog")?.disabled).toBeUndefined();
  });

  it("uses the source type as the detail and carries the stream group", () => {
    const out = parseCriblSources([{ id: "in_syslog", type: "syslog" }], "default");
    expect(out[0].detail).toBe("syslog");
    expect(out[0].groupId).toBe("default");
  });
});

describe("buildSampleSourceInventory", () => {
  it("ALWAYS returns all three sections in a fixed order", () => {
    const inv = buildSampleSourceInventory({});
    expect(inv.sections.map((s) => s.kind)).toEqual([
      "search-dataset",
      "lake-dataset",
      "cribl-source",
    ]);
  });

  it("distinguishes an EMPTY surface from a FAILED one", () => {
    const inv = buildSampleSourceInventory({
      searchGroupId: "default_search",
      searchDatasets: okBody([]),
      lakeDatasets: { status: 403, body: { message: "forbidden" } },
      criblSources: [{ groupId: "default", section: okBody([{ id: "in_syslog" }]) }],
    });

    const search = sectionOf(inv, "search-dataset");
    expect(search.status).toBe("ok");
    expect(search.entries).toEqual([]);
    expect(search.note).toBeUndefined();

    const lake = sectionOf(inv, "lake-dataset");
    expect(lake.status).toBe("failed");
    expect(lake.entries).toEqual([]);
    expect(lake.note).toContain("403");
    // Names what the operator loses, and that the rest still works.
    expect(lake.note).toContain("the others are unaffected");
  });

  it("reads an UNRECOGNIZED body as failed, never as 'you have none'", () => {
    const inv = buildSampleSourceInventory({
      searchGroupId: "g",
      searchDatasets: { status: 200, body: { unexpected: true } },
    });
    const search = sectionOf(inv, "search-dataset");
    expect(search.status).toBe("failed");
    expect(search.note).toContain('NOT "you have none"');
  });

  it("says WHY when there is no Search group, and offers the alternatives", () => {
    const inv = buildSampleSourceInventory({
      groupsListed: true,
      criblSources: [{ groupId: "default", section: okBody([{ id: "in_syslog" }]) }],
    });
    const search = sectionOf(inv, "search-dataset");
    expect(search.status).toBe("unavailable");
    expect(search.note).toContain("no Cribl Search group");
    expect(search.note).toContain("Capture from a source, or upload");
    // The other surfaces are unaffected by Search being absent.
    expect(sectionOf(inv, "cribl-source").entries).toHaveLength(1);
  });

  it("separates NOT-LOOKED-YET from DOES-NOT-EXIST for the Search group", () => {
    // The whole reason `groupsListed` exists. Both have no searchGroupId, and
    // they owe the operator opposite sentences: one is "we have not asked", the
    // other is "this workspace does not have Search".
    const notLooked = buildSampleSourceInventory({});
    expect(sectionOf(notLooked, "search-dataset").status).toBe("pending");
    expect(sectionOf(notLooked, "search-dataset").note).not.toContain("no Cribl Search group");

    const looked = buildSampleSourceInventory({ groupsListed: true });
    expect(sectionOf(looked, "search-dataset").status).toBe("unavailable");
    expect(sectionOf(looked, "search-dataset").note).toContain("no Cribl Search group");
  });

  it("is PENDING, not empty, for every surface nobody has asked about", () => {
    // The lazy load's core claim: before a worker group is picked, NOTHING is
    // known. Reporting that as empty would be a statement about the workspace
    // made before asking it a question.
    const inv = buildSampleSourceInventory({ groupsListed: true, searchGroupId: "s" });
    expect(sectionOf(inv, "search-dataset").status).toBe("pending");
    expect(sectionOf(inv, "lake-dataset").status).toBe("pending");
    expect(sectionOf(inv, "cribl-source").status).toBe("pending");
    expect(sectionOf(inv, "cribl-source").note).toContain("Pick a worker group");
    expect(hasAnySource(inv)).toBe(false);
  });

  it("one failing worker group degrades to a note; the rest still populate", () => {
    const inv = buildSampleSourceInventory({
      criblSources: [
        { groupId: "good", section: okBody([{ id: "in_a" }]) },
        { groupId: "bad", section: { status: 500, body: "boom" } },
      ],
    });
    const sources = sectionOf(inv, "cribl-source");
    expect(sources.status).toBe("ok");
    expect(sources.entries.map((e) => e.id)).toEqual(["in_a"]);
    expect(sources.note).toContain("bad");
    expect(sources.note).toContain("500");
  });

  it("is FAILED only when EVERY worker group failed", () => {
    const inv = buildSampleSourceInventory({
      criblSources: [
        { groupId: "a", section: { status: 500, body: "boom" } },
        { groupId: "b", section: { status: 403, body: "nope" } },
      ],
    });
    expect(sectionOf(inv, "cribl-source").status).toBe("failed");
  });

  it("sorts entries by label so a dropdown is scannable", () => {
    const inv = buildSampleSourceInventory({
      criblSources: [
        { groupId: "g", section: okBody([{ id: "zeta" }, { id: "Alpha" }, { id: "mid" }]) },
      ],
    });
    expect(sectionOf(inv, "cribl-source").entries.map((e) => e.id)).toEqual([
      "Alpha",
      "mid",
      "zeta",
    ]);
  });

  it("hints at a permission problem on 401/403 but not on a 500", () => {
    const forbidden = buildSampleSourceInventory({
      lakeDatasets: { status: 403, body: "" },
    });
    expect(sectionOf(forbidden, "lake-dataset").note).toContain("credentials");

    const broken = buildSampleSourceInventory({ lakeDatasets: { status: 500, body: "" } });
    expect(sectionOf(broken, "lake-dataset").note).not.toContain("credentials");
  });

  it("reads a 404 as 'not enabled in this workspace'", () => {
    const inv = buildSampleSourceInventory({ lakeDatasets: { status: 404, body: "" } });
    expect(sectionOf(inv, "lake-dataset").note).toContain("not enabled in this workspace");
  });
});

describe("allEntries + hasAnySource", () => {
  it("flattens every section and reports whether anything is reachable", () => {
    const inv = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: okBody([{ id: "ds1" }]),
      lakeDatasets: okBody([{ id: "lake1" }]),
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    expect(allEntries(inv).map((e) => e.id)).toEqual(["ds1", "lake1", "in_a"]);
    expect(hasAnySource(inv)).toBe(true);
  });

  it("hasAnySource is FALSE when every surface failed - upload is the only path", () => {
    const inv = buildSampleSourceInventory({
      searchGroupId: "s",
      searchDatasets: { status: 403, body: "" },
      lakeDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: { status: 403, body: "" } }],
    });
    expect(hasAnySource(inv)).toBe(false);
    // ...and it is false for the RIGHT reason - every section says what broke.
    expect(inv.sections.every((s) => s.status === "failed")).toBe(true);
    expect(inv.sections.every((s) => (s.note ?? "").length > 0)).toBe(true);
  });
});
