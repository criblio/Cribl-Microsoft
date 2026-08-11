/**
 * Tests for the app-setup codecs.
 *
 * The mode blocks that lived here - parseAppMode, serializeAppMode, the
 * hasAzure/hasCribl capability predicates, and filterNavItems - went with app
 * modes in capability-model-plan step 5. Their replacement is not a codec but a
 * measurement: domain/capabilities and the capability audit. filterNavItems in
 * particular is superseded by annotateNavItems, which does the OPPOSITE (it
 * annotates every item instead of removing some) and is pinned there.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_SETUP_RECORD,
  parseAcceptanceRecord,
  parseSetupRecord,
  serializeAcceptanceRecord,
  serializeSetupRecord,
} from "./app-setup";

describe("AcceptanceRecord codec", () => {
  it("parses a well-formed record", () => {
    expect(parseAcceptanceRecord('{"acceptedAt":"2026-07-03T12:00:00.000Z"}'))
      .toEqual({ acceptedAt: "2026-07-03T12:00:00.000Z" });
  });

  it("accepts the legacy accepted-terms.json shape, dropping extra keys", () => {
    const record = parseAcceptanceRecord(
      '{"accepted":true,"acceptedAt":"2025-01-01T00:00:00.000Z"}',
    );
    expect(record).toEqual({ acceptedAt: "2025-01-01T00:00:00.000Z" });
  });

  it("returns null (not accepted) for anything unusable", () => {
    expect(parseAcceptanceRecord(null)).toBeNull();
    expect(parseAcceptanceRecord(undefined)).toBeNull();
    expect(parseAcceptanceRecord("")).toBeNull();
    expect(parseAcceptanceRecord("not json")).toBeNull();
    expect(parseAcceptanceRecord("[]")).toBeNull();
    expect(parseAcceptanceRecord('"2026-07-03"')).toBeNull();
    expect(parseAcceptanceRecord("{}")).toBeNull();
    expect(parseAcceptanceRecord('{"accepted":true}')).toBeNull();
    expect(parseAcceptanceRecord('{"acceptedAt":""}')).toBeNull();
    expect(parseAcceptanceRecord('{"acceptedAt":"   "}')).toBeNull();
    expect(parseAcceptanceRecord('{"acceptedAt":12345}')).toBeNull();
  });

  it("round-trips through serialize/parse", () => {
    const record = { acceptedAt: "2026-07-03T12:34:56.789Z" };
    expect(parseAcceptanceRecord(serializeAcceptanceRecord(record))).toEqual(
      record,
    );
  });

  it("serializes only the known field", () => {
    const dirty = {
      acceptedAt: "2026-07-03T12:00:00.000Z",
      token: "leak",
    } as { acceptedAt: string };
    expect(JSON.parse(serializeAcceptanceRecord(dirty))).toEqual({
      acceptedAt: "2026-07-03T12:00:00.000Z",
    });
  });
});

describe("SetupRecord codec", () => {
  it("round-trips a completed setup", () => {
    const record = { completedAt: "2026-08-06T12:00:00Z" };
    expect(parseSetupRecord(serializeSetupRecord(record))).toEqual(record);
  });

  it("emits only the known field", () => {
    const raw = serializeSetupRecord({
      completedAt: "2026-08-06T12:00:00Z",
      mode: "full",
    } as unknown as { completedAt: string });
    expect(JSON.parse(raw)).toEqual({ completedAt: "2026-08-06T12:00:00Z" });
  });

  it("reads Reconfigure's empty record as NOT set up", () => {
    // Reconfigure writes {} to reopen the wizard - the same contract the mode
    // record used to carry.
    expect(parseSetupRecord(EMPTY_SETUP_RECORD)).toBeNull();
  });

  it("is total: junk reopens the wizard rather than stranding a half-setup app", () => {
    for (const raw of [null, undefined, "", "not json", "[]", "42", '{"completedAt":""}']) {
      expect(parseSetupRecord(raw), String(raw)).toBeNull();
    }
  });
});
