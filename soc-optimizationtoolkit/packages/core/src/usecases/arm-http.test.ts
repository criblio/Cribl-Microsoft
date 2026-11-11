/**
 * arm-http - pins for the shared ARM/HTTP idioms. These behaviors were
 * previously asserted indirectly through every usecase's own copy; the
 * consolidation makes the contract explicit once.
 */

import { describe, expect, it } from "vitest";
import {
  armErrorCode,
  asString,
  attemptArm,
  classifyArmFailure,
  httpErrorText,
  is2xx,
  isErrorCode,
  mergedTags,
  prop,
} from "./arm-http";

describe("is2xx", () => {
  it("accepts the 2xx range and nothing else", () => {
    expect(is2xx(200)).toBe(true);
    expect(is2xx(204)).toBe(true);
    expect(is2xx(299)).toBe(true);
    expect(is2xx(199)).toBe(false);
    expect(is2xx(300)).toBe(false);
    expect(is2xx(403)).toBe(false);
  });
});

describe("prop", () => {
  it("reads object properties and returns undefined for non-objects", () => {
    expect(prop({ a: 1 }, "a")).toBe(1);
    expect(prop({ a: 1 }, "b")).toBeUndefined();
    expect(prop(null, "a")).toBeUndefined();
    expect(prop("text", "a")).toBeUndefined();
    expect(prop(42, "a")).toBeUndefined();
  });

  it("reads array properties (arrays are objects here; update-dcr keeps its own stricter variant)", () => {
    expect(prop([1, 2], "length")).toBe(2);
  });
});

describe("asString", () => {
  it("passes strings through and coerces everything else to ''", () => {
    expect(asString("x")).toBe("x");
    expect(asString("")).toBe("");
    expect(asString(7)).toBe("");
    expect(asString(null)).toBe("");
    expect(asString(undefined)).toBe("");
  });
});

describe("httpErrorText", () => {
  it("renders context, status, and the JSON body", () => {
    expect(httpErrorText("create widget", 403, { error: { code: "Denied" } })).toBe(
      'create widget: HTTP 403 {"error":{"code":"Denied"}}',
    );
  });

  it("trims when the body stringifies to undefined", () => {
    expect(httpErrorText("get widget", 500, undefined)).toBe("get widget: HTTP 500");
  });

  it("falls back to String() for unstringifiable bodies", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(httpErrorText("x", 400, cyclic)).toBe("x: HTTP 400 [object Object]");
  });
});

describe("armErrorCode / isErrorCode", () => {
  it("reads the nested ARM error code", () => {
    expect(armErrorCode({ error: { code: "RoleAssignmentExists" } })).toBe(
      "RoleAssignmentExists",
    );
  });

  it("tolerates the flattened single-level shape", () => {
    expect(armErrorCode({ code: "Conflict" })).toBe("Conflict");
  });

  it("returns '' when no code is present", () => {
    expect(armErrorCode({})).toBe("");
    expect(armErrorCode(null)).toBe("");
    expect(armErrorCode("nope")).toBe("");
  });

  it("compares case-insensitively", () => {
    expect(isErrorCode({ error: { code: "principalnotfound" } }, "PrincipalNotFound")).toBe(
      true,
    );
    expect(isErrorCode({ error: { code: "Other" } }, "PrincipalNotFound")).toBe(false);
  });
});

describe("mergedTags", () => {
  it("keeps existing string tags and lets desired tags win", () => {
    expect(
      mergedTags({ tags: { keep: "yes", TTL: "old" } }, { TTL: "new" }),
    ).toEqual({ keep: "yes", TTL: "new" });
  });

  it("drops non-string existing values and tolerates missing tags", () => {
    expect(mergedTags({ tags: { n: 3, ok: "1" } }, { a: "b" })).toEqual({ ok: "1", a: "b" });
    expect(mergedTags({}, { a: "b" })).toEqual({ a: "b" });
    expect(mergedTags(undefined, { a: "b" })).toEqual({ a: "b" });
  });
});

describe("classifyArmFailure", () => {
  const answer = (status: number, body: unknown) => ({ ok: true as const, response: { status, body } });

  it("puts MissingSubscriptionRegistration before 403, so the fix named is registration", () => {
    const r = classifyArmFailure(
      answer(403, { error: { code: "MissingSubscriptionRegistration", message: "register it" } }),
      "List things",
    );
    expect(r).toEqual({
      kind: "unregistered",
      status: 403,
      code: "MissingSubscriptionRegistration",
      message: "List things: HTTP 403 - register it",
    });
  });

  it("a plain 403 is denied, any other non-2xx is failed, no answer is failed with a null status", () => {
    expect(classifyArmFailure(answer(403, { error: { code: "AuthorizationFailed" } }), "X").kind).toBe("denied");
    expect(classifyArmFailure(answer(500, {}), "X")).toEqual({
      kind: "failed",
      status: 500,
      code: "",
      message: "X: HTTP 500",
    });
    expect(classifyArmFailure({ ok: false, error: "socket hang up" }, "X")).toEqual({
      kind: "failed",
      status: null,
      code: "",
      message: "X: socket hang up",
    });
  });
});

describe("attemptArm", () => {
  it("turns a rejection into ok:false with its text, and never rejects", async () => {
    await expect(attemptArm(() => Promise.reject(new Error("dns")))).resolves.toEqual({ ok: false, error: "dns" });
    await expect(attemptArm(() => Promise.resolve({ status: 204, body: null }))).resolves.toEqual({
      ok: true,
      response: { status: 204, body: null },
    });
  });
});
