// Pins for readCoverageDocument (AZR-18): the gate a Save goes through.
//
// decodeSelection is tolerant on purpose and never refuses anything, so it
// cannot be the thing that decides whether a write is safe. These pins hold the
// two separate checks the shared KV standard asks for - identity (`kind`) and
// readability (`version === 1` exactly) - and in particular that the version
// test is strict equality: a "numeric and at least 1" check would pass several
// of the unreadable cases below, and the screen would then overwrite them.

import { describe, expect, it } from "vitest";

import {
  COVERAGE_SELECTION_KIND,
  COVERAGE_SELECTION_VERSION,
  defaultSelection,
  encodeSelection,
  readCoverageDocument,
} from "./coverage-selection";

const KIND = COVERAGE_SELECTION_KIND;

describe("readCoverageDocument - unreadable: ours, but not this release's version", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, unknown]> = [
    ["a later release's number", { kind: KIND, version: 2, mode: "Centralized", enabled: [] }, 2],
    ["version 0", { kind: KIND, version: 0, enabled: [] }, 0],
    ["the string '1'", { kind: KIND, version: "1", enabled: [] }, "1"],
    ["no version at all", { kind: KIND, enabled: [] }, undefined],
    ["no kind and version 2", { version: 2, enabled: [] }, 2],
  ];

  for (const [label, doc, version] of cases) {
    it(`reports ${label} as unreadable, carrying the version it found`, () => {
      // Both the object and its stored JSON text: the KV store hands back text.
      for (const raw of [doc, JSON.stringify(doc)]) {
        expect(readCoverageDocument(raw)).toEqual({ status: "unreadable", version });
      }
    });
  }
});

describe("readCoverageDocument - foreign: somebody else's document", () => {
  it("reports a different kind as foreign, even at version 1", () => {
    const doc = { kind: "other", version: COVERAGE_SELECTION_VERSION, enabled: ["entraId"] };
    expect(readCoverageDocument(JSON.stringify(doc))).toEqual({ status: "foreign", kind: "other" });
  });

  it("checks identity before readability", () => {
    // A stranger's document is foreign whatever its version says.
    expect(readCoverageDocument({ kind: "other", version: 7 })).toEqual({
      status: "foreign",
      kind: "other",
    });
  });
});

describe("readCoverageDocument - ok", () => {
  it("round-trips an encoded document as ok, decoded unchanged", () => {
    const original = { ...defaultSelection(), enabled: ["entraId", "defenderExport"] };
    const result = readCoverageDocument(encodeSelection(original));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.decoded.selection).toEqual(original);
    expect(result.decoded.dropped).toEqual([]);
    expect(result.decoded.usedDefaults).toBe(false);
  });

  it("reads a version-1 document with NO kind as ours (a pre-AZR-18 save)", () => {
    const stored = JSON.stringify({ version: 1, mode: "Centralized", enabled: ["entraId"] });
    const result = readCoverageDocument(stored);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.decoded.selection.enabled).toEqual(["entraId"]);
    expect(result.decoded.usedDefaults).toBe(false);
  });

  it("reads nothing stored, and corrupt text, as absent: ok with the defaults", () => {
    // The standard's "absent" row: start from defaults, let the next deliberate
    // write replace it. usedDefaults is what tells the screen it happened.
    for (const raw of [null, undefined, "{not json", "42", []]) {
      const result = readCoverageDocument(raw);
      expect(result.status, JSON.stringify(raw) ?? "undefined").toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.decoded.selection).toEqual(defaultSelection());
      expect(result.decoded.usedDefaults).toBe(true);
    }
  });

  it("reads an object with neither kind nor version as absent, not as ours", () => {
    // Nothing in it claims to be ours, so it fails the identity check and the
    // next Save may replace it. Calling it `unreadable` would block Save for
    // good: only a write could repair the key. Its contents are NOT decoded -
    // `enabled` here must not become the operator's selection.
    for (const doc of [{}, { enabled: ["entraId"] }]) {
      for (const raw of [doc, JSON.stringify(doc)]) {
        const result = readCoverageDocument(raw);
        expect(result.status, JSON.stringify(raw)).toBe("ok");
        if (result.status !== "ok") continue;
        expect(result.decoded.selection).toEqual(defaultSelection());
        expect(result.decoded.usedDefaults).toBe(true);
      }
    }
  });
});
