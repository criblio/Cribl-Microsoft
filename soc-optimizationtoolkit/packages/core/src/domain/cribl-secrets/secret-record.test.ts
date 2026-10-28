/**
 * Pins findSecretRecord (DBT-187): every shape a GET /system/secrets/:id
 * answer's `items` can take, and the stricter rule on each. The
 * decideSecretConflict pins below, and the classifyExistingSecret pins in
 * classify-existing.test.ts, hold both readers of the answer to this one rule
 * so they cannot drift apart again.
 */

import { describe, expect, it } from "vitest";
import { stampFor } from "../../kit/config-writes/ownership";
import { APP_ID } from "./secret-body";
import { decideSecretConflict } from "./secret-conflict";
import { findSecretRecord } from "./secret-record";

const ID = "sentinel_client_secret";
const ours = { id: ID, secretType: "text", description: `x ${stampFor(APP_ID)}` };

describe("findSecretRecord", () => {
  it.each([
    ["no items (undefined)", undefined],
    ["items is null", null],
    ["items is an object", { id: ID }],
    ["items is a string", "items"],
  ])("%s: malformed, without an items array", (_label, items) => {
    expect(findSecretRecord(items, ID)).toEqual({ kind: "malformed", detail: "answered without an items array" });
  });

  it.each([
    ["before the match", [null, ours]],
    ["after the match", [ours, "junk"]],
    ["an array entry", [[ours]]],
    ["a number with no match", [7]],
  ])("a non-object entry %s: malformed", (_label, items) => {
    expect(findSecretRecord(items, ID)).toEqual({ kind: "malformed", detail: "has an entry that is not an object" });
  });

  it("empty items: missing", () => {
    expect(findSecretRecord([], ID)).toEqual({ kind: "missing" });
  });

  it("only other ids: missing", () => {
    expect(findSecretRecord([{ id: "other" }, { name: ID }], ID)).toEqual({ kind: "missing" });
  });

  // The id matches exactly: a near-miss id is another secret, never this one.
  it("near-miss ids (suffixed, other case, prefix): missing", () => {
    expect(findSecretRecord([{ id: `${ID}_old` }, { id: ID.toUpperCase() }, { id: "sentinel" }], ID)).toEqual({
      kind: "missing",
    });
  });

  it("the right id among others: found, that exact record", () => {
    const result = findSecretRecord([{ id: "other" }, ours], ID);
    expect(result).toEqual({ kind: "found", record: ours });
    expect(result.kind === "found" && result.record).toBe(ours);
  });

  it("two entries with the id: malformed, naming the count", () => {
    expect(findSecretRecord([ours, { id: ID, description: "hand made" }], ID)).toEqual({
      kind: "malformed",
      detail: `has 2 entries for secret '${ID}'`,
    });
  });
});

describe("decideSecretConflict reads the answer through findSecretRecord", () => {
  const unreadable = (detail: string) => ({
    kind: "refuse",
    reason: "unreadable",
    message: `Cribl secret '${ID}' already exists and its owner could not be read (the read ${detail}); it was left unchanged.`,
  });

  it("a stamped match beside a non-object entry: unreadable, not patch", () => {
    expect(decideSecretConflict(ID, { status: 200, body: { items: [ours, null] } })).toEqual(
      unreadable("has an entry that is not an object"),
    );
  });

  it("two entries for the id, the first stamped: unreadable, not patch", () => {
    const items = [ours, { id: ID, description: "hand made" }];
    expect(decideSecretConflict(ID, { status: 200, body: { items } })).toEqual(unreadable(`has 2 entries for secret '${ID}'`));
  });

  it("a body that is not an object: unreadable, without an items array", () => {
    expect(decideSecretConflict(ID, { status: 200, body: "ok" })).toEqual(unreadable("answered without an items array"));
  });

  it("the single stamped match among others: patch", () => {
    expect(decideSecretConflict(ID, { status: 200, body: { items: [{ id: "other" }, ours] } })).toEqual({ kind: "patch" });
  });
});
