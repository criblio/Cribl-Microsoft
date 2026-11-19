import { describe, expect, it } from "vitest";
import {
  TENANT_GAP_READS_KEY,
  canWriteGapReads,
  decodeGapReads,
  emptyGapReads,
  encodeGapReads,
  gapReadsFrom,
  gapReadsLoadNote,
  readGapReadsDocument,
  savedGapReadFor,
  withGapRead,
  type SavedGapRead,
} from "./saved-reads";
import { GAP_SOURCES, rowUnknown, type GapCell, type TenantGapRow } from "./tenant-gap";

const TA = "aaaaaaaa-0000-0000-0000-000000000001";
const TB = "bbbbbbbb-0000-0000-0000-000000000002";

function row(over: Partial<TenantGapRow> = {}): TenantGapRow {
  const cells: GapCell[] = GAP_SOURCES.map((s, i) => ({
    sourceId: s.id,
    azure: i === 0 ? { state: "red", reason: "Not configured as planned: x." } : { state: "green", reason: "Configured." },
    cribl: { state: "unknown", reason: "Cribl was not read." },
  }));
  return {
    profileId: "pa",
    tenantId: TA,
    cells,
    status: { state: "green", reason: "Proven." },
    warnings: ["one warning"],
    plannedReads: 7,
    cancelled: false,
    ...over,
  };
}

const ENTRY: SavedGapRead = { row: row(), readAt: Date.UTC(2026, 10, 19, 9, 0, 0) };

describe("the key", () => {
  it("is tenant-gap-reads", () => {
    expect(TENANT_GAP_READS_KEY).toBe("tenant-gap-reads");
  });
});

describe("withGapRead", () => {
  it("files the row under its normalized tenant id", () => {
    const reads = withGapRead(emptyGapReads(), { row: row({ tenantId: TA.toUpperCase() }), readAt: 5 });
    expect(Object.keys(reads.tenants)).toEqual([TA]);
    expect(reads.tenants[TA]!.row.tenantId).toBe(TA);
    expect(reads.tenants[TA]!.readAt).toBe(5);
  });

  it("replaces only the same tenant's answer", () => {
    const one = withGapRead(emptyGapReads(), ENTRY);
    const two = withGapRead(one, { row: row({ profileId: "pb", tenantId: TB }), readAt: 9 });
    const three = withGapRead(two, { row: row({ plannedReads: 1 }), readAt: 11 });
    expect(Object.keys(three.tenants).sort()).toEqual([TA, TB]);
    expect(three.tenants[TA]!.readAt).toBe(11);
    expect(three.tenants[TB]!.readAt).toBe(9);
  });

  it("never keeps a cancelled row or a row with no tenant", () => {
    const base = withGapRead(emptyGapReads(), ENTRY);
    expect(withGapRead(base, { row: row({ cancelled: true }), readAt: 99 })).toBe(base);
    expect(withGapRead(base, { row: row({ tenantId: "  " }), readAt: 99 })).toBe(base);
  });
});

describe("encode and decode", () => {
  it("round-trips exactly, with nothing dropped", () => {
    const reads = withGapRead(withGapRead(emptyGapReads(), ENTRY), { row: row({ profileId: "pb", tenantId: TB }), readAt: 3 });
    const text = encodeGapReads(reads);
    const doc = readGapReadsDocument({ kind: "value", value: text });
    expect(doc.status).toBe("ok");
    if (doc.status !== "ok") return;
    expect(doc.decoded.dropped).toEqual([]);
    expect(doc.decoded.reads).toEqual(reads);
  });

  it("is deterministic regardless of insertion order", () => {
    const a = withGapRead(withGapRead(emptyGapReads(), ENTRY), { row: row({ profileId: "pb", tenantId: TB }), readAt: 3 });
    const b = withGapRead(withGapRead(emptyGapReads(), { row: row({ profileId: "pb", tenantId: TB }), readAt: 3 }), ENTRY);
    expect(encodeGapReads(a)).toBe(encodeGapReads(b));
    expect(JSON.parse(encodeGapReads(a))).toMatchObject({ kind: "tenant-gap-reads", version: 1 });
  });

  it("drops and reports what it cannot read, keeping the rest", () => {
    const decoded = decodeGapReads({
      kind: "tenant-gap-reads",
      version: 1,
      extra: true,
      tenants: {
        [TA]: {
          readAt: 10,
          profileId: "pa",
          status: { state: "green", reason: "ok" },
          warnings: ["w", 3],
          plannedReads: -1,
          surprise: 1,
          cells: [
            { sourceId: "activityLog", azure: { state: "red", reason: "r" }, cribl: { state: "green", reason: "g" } },
            { sourceId: "activityLog", azure: { state: "green", reason: "dup" }, cribl: { state: "green", reason: "dup" } },
            { sourceId: "noSuchSource", azure: { state: "green", reason: "" }, cribl: { state: "green", reason: "" } },
            { sourceId: "entraId", azure: { state: "purple", reason: "" }, cribl: { state: "green", reason: "" } },
            "junk",
          ],
        },
        // Not a normalized tenant id: whose it is cannot be told.
        [TB.toUpperCase()]: { readAt: 1, profileId: "pb", status: { state: "green", reason: "" }, cells: [] },
        // No time: its age could not be shown.
        "cccccccc-0000-0000-0000-000000000003": { profileId: "pc", status: { state: "green", reason: "" }, cells: [] },
        // A red status breaks the scan's contract.
        "dddddddd-0000-0000-0000-000000000004": { readAt: 1, profileId: "pd", status: { state: "red", reason: "" }, cells: [] },
      },
    });
    expect(Object.keys(decoded.reads.tenants)).toEqual([TA]);
    const kept = decoded.reads.tenants[TA]!;
    expect(kept.row.cells).toEqual([
      { sourceId: "activityLog", azure: { state: "red", reason: "r" }, cribl: { state: "green", reason: "g" } },
    ]);
    expect(kept.row.warnings).toEqual(["w"]);
    expect(kept.row.plannedReads).toBe(0);
    expect(kept.row.cancelled).toBe(false);
    expect(decoded.dropped).toEqual([
      `tenants.${TA}.cells[1]`,
      `tenants.${TA}.cells[2]`,
      `tenants.${TA}.cells[3]`,
      `tenants.${TA}.cells[4]`,
      `tenants.${TA}.warnings[1]`,
      `tenants.${TA}.plannedReads`,
      `tenants.${TA}.surprise`,
      `tenants.${TB.toUpperCase()}`,
      "tenants.cccccccc-0000-0000-0000-000000000003",
      "tenants.dddddddd-0000-0000-0000-000000000004",
      "extra",
    ]);
  });
});

describe("readGapReadsDocument", () => {
  it("classifies every answer, and only absent and ok allow a write", () => {
    const cases = [
      [{ kind: "absent", why: "not-found" }, "absent", true],
      [{ kind: "value", value: "{not json" }, "absent", true],
      [{ kind: "value", value: { hello: 1 } }, "absent", true],
      [{ kind: "value", value: { kind: "someone-else", version: 1 } }, "foreign", false],
      [{ kind: "value", value: { kind: "tenant-gap-reads", version: 2 } }, "unreadable", false],
      [{ kind: "unknown", reason: "HTTP 503" }, "read-unknown", false],
      [{ kind: "value", value: { kind: "tenant-gap-reads", version: 1, tenants: {} } }, "ok", true],
    ] as const;
    for (const [load, status, writable] of cases) {
      const doc = readGapReadsDocument(load);
      expect(doc.status).toBe(status);
      expect(canWriteGapReads(doc)).toBe(writable);
    }
  });

  it("seeds nothing from anything but a readable document of ours - never a colour", () => {
    expect(gapReadsFrom(readGapReadsDocument({ kind: "unknown", reason: "x" }))).toEqual(emptyGapReads());
    expect(gapReadsFrom(readGapReadsDocument({ kind: "value", value: { kind: "tenant-gap-reads", version: 9, tenants: { [TA]: {} } } }))).toEqual(emptyGapReads());
    expect(gapReadsFrom(readGapReadsDocument({ kind: "value", value: "garbage" }))).toEqual(emptyGapReads());
  });

  it("says why nothing was seeded, and is silent for a clean answer", () => {
    expect(gapReadsLoadNote(readGapReadsDocument({ kind: "absent", why: "not-found" }))).toBeNull();
    expect(gapReadsLoadNote(readGapReadsDocument({ kind: "value", value: encodeGapReads(withGapRead(emptyGapReads(), ENTRY)) }))).toBeNull();
    expect(gapReadsLoadNote(readGapReadsDocument({ kind: "unknown", reason: "HTTP 503" }))).toBe(
      "Saved gap reads could not be loaded (HTTP 503), so every tenant shows as not read yet. Reading a tenant again shows its answer, but it is not saved until the saved reads load.",
    );
    expect(
      gapReadsLoadNote(readGapReadsDocument({ kind: "value", value: { kind: "tenant-gap-reads", version: 1, tenants: { BAD: {} } } })),
    ).toBe("Some saved gap reads could not be understood and are shown as not read yet (1 part dropped).");
  });
});

describe("savedGapReadFor", () => {
  const reads = withGapRead(emptyGapReads(), ENTRY);

  it("answers for the connection it was read through, whatever the tenant id's case", () => {
    expect(savedGapReadFor(reads, { id: "pa", config: { tenantId: ` ${TA.toUpperCase()} ` } })).toBe(reads.tenants[TA]);
  });

  it("does not answer for another connection in the same tenant, another tenant, or no tenant", () => {
    expect(savedGapReadFor(reads, { id: "other", config: { tenantId: TA } })).toBeNull();
    expect(savedGapReadFor(reads, { id: "pa", config: { tenantId: TB } })).toBeNull();
    expect(savedGapReadFor(reads, { id: "pa", config: { tenantId: "" } })).toBeNull();
  });

  it("keeps an all-unknown row unknown", () => {
    const unknownRow = withGapRead(emptyGapReads(), { row: row({ cells: rowUnknown("refused") }), readAt: 1 });
    const decoded = readGapReadsDocument({ kind: "value", value: encodeGapReads(unknownRow) });
    if (decoded.status !== "ok") throw new Error(decoded.status);
    expect(decoded.decoded.reads.tenants[TA]!.row.cells.every((c) => c.azure.state === "unknown" && c.cribl.state === "unknown")).toBe(true);
  });
});
