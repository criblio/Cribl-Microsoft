/**
 * Pins for the sample-source inventory (plan Phase 3, ADR 0003).
 *
 * The honesty rule under almost all of them: an EMPTY list, a FAILED read and a
 * surface NOBODY ASKED ABOUT must never render the same. They send the operator
 * to upload a file, to fix a permission, and nowhere respectively - and the
 * second or third silently rendered as the first is how someone concludes their
 * environment has nothing to offer.
 */

import { describe, expect, it } from "vitest";

import {
  allEntries,
  buildSampleSourceInventory,
  hasAnySource,
  parseCriblSources,
  parseLakeDatasets,
  sectionFor,
} from "./inventory";
import type { SampleSourceKind } from "./models";

const okBody = (items: unknown[]) => ({ status: 200, body: { count: items.length, items } });

function sectionOf(inv: ReturnType<typeof buildSampleSourceInventory>, kind: SampleSourceKind) {
  const s = sectionFor(inv, kind);
  if (s === undefined) throw new Error(`no section for ${kind}`);
  return s;
}

describe("parseLakeDatasets", () => {
  it("reads the retained size and retention out of the dataset", () => {
    const out = parseLakeDatasets([
      {
        id: "lake_ds",
        description: "Retained",
        retentionPeriodInDays: 30,
        metrics: { currentSizeBytes: 4096, metricsDate: "2026-08-18" },
      },
    ]);
    expect(out[0].sizeBytes).toBe(4096);
    expect(out[0].retentionDays).toBe(30);
    expect(out[0].detail).toBe("Retained");
  });

  it("carries NO groupId - LISTING Lake datasets is a leader route", () => {
    // The distinction that makes the request correct. Querying one later goes
    // through the Search group, but that is the query's business.
    const out = parseLakeDatasets([{ id: "lake_ds" }]);
    expect(out[0].groupId).toBeUndefined();
    expect(out[0].kind).toBe("lake-dataset");
  });

  it("omits sizeBytes when no metrics snapshot exists, rather than reporting 0", () => {
    // A zero would read as "this dataset is empty", a different claim.
    const out = parseLakeDatasets([{ id: "fresh" }, { id: "odd", metrics: { currentSizeBytes: "big" } }]);
    expect(out[0].sizeBytes).toBeUndefined();
    expect(out[1].sizeBytes).toBeUndefined();
  });

  it("skips entries with no usable id rather than inventing one", () => {
    const out = parseLakeDatasets([{ id: "" }, { id: "  " }, {}, null, "x", { id: "ok" }]);
    expect(out.map((d) => d.id)).toEqual(["ok"]);
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
  it("ALWAYS returns both sections in a fixed order", () => {
    const inv = buildSampleSourceInventory({});
    expect(inv.sections.map((s) => s.kind)).toEqual(["lake-dataset", "cribl-source"]);
  });

  it("is PENDING, not empty, for the surface the chosen mode did not read", () => {
    // The lazy load's core claim: reading Lake says NOTHING about sources.
    const lakeOnly = buildSampleSourceInventory({ lakeDatasets: okBody([{ id: "ds" }]) });
    expect(sectionOf(lakeOnly, "lake-dataset").status).toBe("ok");
    expect(sectionOf(lakeOnly, "cribl-source").status).toBe("pending");
    expect(sectionOf(lakeOnly, "cribl-source").note).toContain("Pick a worker group");

    const sourcesOnly = buildSampleSourceInventory({
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    expect(sectionOf(sourcesOnly, "lake-dataset").status).toBe("pending");
    expect(sectionOf(sourcesOnly, "cribl-source").status).toBe("ok");
  });

  it("distinguishes an EMPTY surface from a FAILED one", () => {
    const empty = buildSampleSourceInventory({ lakeDatasets: okBody([]) });
    expect(sectionOf(empty, "lake-dataset").status).toBe("ok");
    expect(sectionOf(empty, "lake-dataset").note).toBeUndefined();

    const failed = buildSampleSourceInventory({
      lakeDatasets: { status: 403, body: { message: "forbidden" } },
    });
    expect(sectionOf(failed, "lake-dataset").status).toBe("failed");
    expect(sectionOf(failed, "lake-dataset").note).toContain("403");
    expect(sectionOf(failed, "lake-dataset").note).toContain("the other is unaffected");
  });

  it("reads an UNRECOGNIZED body as failed, never as 'you have none'", () => {
    const inv = buildSampleSourceInventory({
      lakeDatasets: { status: 200, body: { unexpected: true } },
    });
    expect(sectionOf(inv, "lake-dataset").status).toBe("failed");
    expect(sectionOf(inv, "lake-dataset").note).toContain('NOT "you have none"');
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
      lakeDatasets: okBody([{ id: "zeta" }, { id: "Alpha" }, { id: "mid" }]),
    });
    expect(sectionOf(inv, "lake-dataset").entries.map((e) => e.id)).toEqual([
      "Alpha",
      "mid",
      "zeta",
    ]);
  });

  it("hints at a permission problem on 401/403 but not on a 500", () => {
    const forbidden = buildSampleSourceInventory({ lakeDatasets: { status: 403, body: "" } });
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
      lakeDatasets: okBody([{ id: "lake1" }]),
      criblSources: [{ groupId: "g", section: okBody([{ id: "in_a" }]) }],
    });
    expect(allEntries(inv).map((e) => e.id)).toEqual(["lake1", "in_a"]);
    expect(hasAnySource(inv)).toBe(true);
  });

  it("hasAnySource is FALSE when every surface failed - upload is the only path", () => {
    const inv = buildSampleSourceInventory({
      lakeDatasets: { status: 403, body: "" },
      criblSources: [{ groupId: "g", section: { status: 403, body: "" } }],
    });
    expect(hasAnySource(inv)).toBe(false);
    // ...and for the RIGHT reason - every section says what broke.
    expect(inv.sections.every((s) => s.status === "failed")).toBe(true);
    expect(inv.sections.every((s) => (s.note ?? "").length > 0)).toBe(true);
  });
});
