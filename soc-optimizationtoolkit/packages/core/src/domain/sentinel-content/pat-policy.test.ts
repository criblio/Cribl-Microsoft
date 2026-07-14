/**
 * GitHub PAT policy - porting-plan Unit 14 (ENG-30). Pins the validate-then-
 * store flow, the hasPat-only status that crosses to the renderer (never the
 * token), and the platform gate (required on cloud, advisory on local).
 */
import { describe, expect, it } from "vitest";
import {
  PAT_MIN_LENGTH,
  PAT_VALIDATION_ENDPOINT,
  decidePatStore,
  evaluatePatGate,
  patFormatIssue,
  patPolicyFor,
  patStatusFrom,
} from "./pat-policy";

describe("format precheck (patFormatIssue)", () => {
  it("rejects empty/short/nullish before any network call", () => {
    expect(patFormatIssue("")).toBe("PAT is required");
    expect(patFormatIssue("   ")).toBe("PAT is required");
    expect(patFormatIssue("short")).toBe("PAT is required");
    expect(patFormatIssue(null)).toBe("PAT is required");
    expect(patFormatIssue(undefined)).toBe("PAT is required");
  });
  it("accepts a plausible token (>= min length after trim)", () => {
    expect(patFormatIssue("ghp_" + "x".repeat(PAT_MIN_LENGTH))).toBeNull();
  });
});

describe("validate-then-store", () => {
  it("validation endpoint is GET /user", () => {
    expect(PAT_VALIDATION_ENDPOINT).toBe("https://api.github.com/user");
  });

  it("only a successful validation stores the token", () => {
    expect(decidePatStore({ ok: true, login: "octocat" })).toEqual({
      store: true,
      status: { hasPat: true, login: "octocat" },
    });
    expect(decidePatStore({ ok: false, error: "401" })).toEqual({
      store: false,
      status: { hasPat: false },
    });
  });

  it("the renderer-facing status NEVER carries the token", () => {
    const status = patStatusFrom({ ok: true, login: "octocat" });
    expect(status).toEqual({ hasPat: true, login: "octocat" });
    // Only hasPat + login may cross; no token/pat/secret key exists.
    expect(Object.keys(status).sort()).toEqual(["hasPat", "login"]);
    expect(patStatusFrom({ ok: false })).toEqual({ hasPat: false });
  });
});

describe("platform policy", () => {
  it("cloud requires a PAT (shared egress IP)", () => {
    const p = patPolicyFor("cloud");
    expect(p.required).toBe(true);
    expect(p.rationale.toLowerCase()).toContain("egress ip");
    expect(p.scopeGuidance.length).toBeGreaterThan(0);
  });
  it("local recommends but does not require a PAT", () => {
    expect(patPolicyFor("local").required).toBe(false);
  });
});

describe("runtime gate (evaluatePatGate)", () => {
  it("cloud without a PAT is a hard block", () => {
    const gate = evaluatePatGate("cloud", false);
    expect(gate.allowed).toBe(false);
    expect(gate.blocking).toBe(true);
    expect(gate.message.length).toBeGreaterThan(0);
  });
  it("local without a PAT is allowed but advisory", () => {
    const gate = evaluatePatGate("local", false);
    expect(gate.allowed).toBe(true);
    expect(gate.blocking).toBe(false);
    expect(gate.message.length).toBeGreaterThan(0);
  });
  it("a present PAT is always allowed with no message", () => {
    for (const platform of ["cloud", "local"] as const) {
      expect(evaluatePatGate(platform, true)).toEqual({
        allowed: true,
        blocking: false,
        message: "",
      });
    }
  });
});
