import { describe, expect, it } from "vitest";
import type { TargetScope } from "@soc/core";
import {
  RESOURCE_GROUP_MAX_LENGTH,
  buildLoaderPlan,
  commitNoticeText,
  formatScopeChip,
  parseTargetScope,
  sanitizeResourceGroupName,
  serializeTargetScope,
  validateResourceGroupName,
} from "./targeting-state";

describe("sanitizeResourceGroupName (legacy rule mined verbatim)", () => {
  it("keeps letters, digits, underscore, hyphen, parentheses, and period", () => {
    expect(sanitizeResourceGroupName("rg-cribl_dcr(prod).v2")).toBe(
      "rg-cribl_dcr(prod).v2",
    );
  });

  it("strips spaces and every other character, exactly like the legacy field", () => {
    // Legacy: e.target.value.replace(/[^a-zA-Z0-9_\-().]/g, '')
    expect(sanitizeResourceGroupName("rg cribl dcr")).toBe("rgcribldcr");
    expect(sanitizeResourceGroupName("rg!@#$%^&*+=~`'\"<>?/\\|{}[]:;,name")).toBe(
      "rgname",
    );
    expect(sanitizeResourceGroupName("")).toBe("");
  });
});

describe("validateResourceGroupName", () => {
  it("rejects an empty name", () => {
    expect(validateResourceGroupName("")).toMatch(/enter a resource group/i);
  });

  it("rejects names over the Azure 90-character limit", () => {
    const long = "a".repeat(RESOURCE_GROUP_MAX_LENGTH + 1);
    expect(validateResourceGroupName(long)).toMatch(/90 characters/);
    expect(validateResourceGroupName("a".repeat(RESOURCE_GROUP_MAX_LENGTH))).toBeNull();
  });

  it("rejects a trailing period (Azure rule the legacy field let ARM reject)", () => {
    expect(validateResourceGroupName("rg-name.")).toMatch(/period/i);
    expect(validateResourceGroupName("rg.name")).toBeNull();
  });

  it("accepts a normal sanitized name", () => {
    expect(validateResourceGroupName("rg-cribl-dcr-prod")).toBeNull();
  });
});

describe("buildLoaderPlan (the one-loader contract)", () => {
  it("fetches NOTHING in the offline branch", () => {
    expect(
      buildLoaderPlan({ offline: true, subscriptionId: "sub-1", reloadNonce: 3 }),
    ).toEqual({ subscriptionsKey: "", dependentsKey: "" });
  });

  it("loads subscriptions but no dependents before a subscription is chosen", () => {
    expect(
      buildLoaderPlan({ offline: false, subscriptionId: "", reloadNonce: 0 }),
    ).toEqual({ subscriptionsKey: "subs:0", dependentsKey: "" });
  });

  it("changing the browsed subscription changes the dependents key ONLY", () => {
    const a = buildLoaderPlan({ offline: false, subscriptionId: "sub-a", reloadNonce: 1 });
    const b = buildLoaderPlan({ offline: false, subscriptionId: "sub-b", reloadNonce: 1 });
    expect(a.subscriptionsKey).toBe(b.subscriptionsKey);
    expect(a.dependentsKey).not.toBe(b.dependentsKey);
  });

  it("a refresh (reloadNonce bump) reloads both lists", () => {
    const before = buildLoaderPlan({ offline: false, subscriptionId: "sub-a", reloadNonce: 1 });
    const after = buildLoaderPlan({ offline: false, subscriptionId: "sub-a", reloadNonce: 2 });
    expect(after.subscriptionsKey).not.toBe(before.subscriptionsKey);
    expect(after.dependentsKey).not.toBe(before.dependentsKey);
  });
});

describe("commitNoticeText", () => {
  it("surfaces the permission-results consequence for a pure scope commit", () => {
    const text = commitNoticeText({
      clearSecret: false,
      clearToken: false,
      clearPermissionResults: true,
    });
    expect(text).toMatch(/permission results are stale/i);
    expect(text).toMatch(/re-run the permission validation/i);
  });

  it("returns '' when nothing was invalidated (scope unchanged)", () => {
    expect(
      commitNoticeText({
        clearSecret: false,
        clearToken: false,
        clearPermissionResults: false,
      }),
    ).toBe("");
  });

  it("states the secret/token consequence for an identity-level invalidation", () => {
    const text = commitNoticeText({
      clearSecret: true,
      clearToken: true,
      clearPermissionResults: true,
    });
    expect(text).toMatch(/client secret/i);
    expect(text).toMatch(/reconnect/i);
  });
});

describe("formatScopeChip", () => {
  it("reads 'no target committed' for a fully empty scope", () => {
    expect(
      formatScopeChip({ subscriptionId: "", resourceGroup: "", workspaceName: "" }),
    ).toBe("no target committed");
  });

  it("renders workspace @ resourceGroup (subscription) when complete", () => {
    expect(
      formatScopeChip({
        subscriptionId: "sub-1",
        resourceGroup: "rg-prod",
        workspaceName: "law-sentinel",
      }),
    ).toBe("law-sentinel @ rg-prod (sub-1)");
  });

  it("keeps missing pieces visible as explicit placeholders", () => {
    expect(
      formatScopeChip({ subscriptionId: "sub-1", resourceGroup: "", workspaceName: "" }),
    ).toBe("(no workspace) @ (no resource group) (sub-1)");
  });
});

describe("target-scope codec", () => {
  const SCOPE: TargetScope = {
    subscriptionId: "sub-1",
    resourceGroup: "rg-prod",
    workspaceName: "law-sentinel",
  };

  it("round-trips a committed scope", () => {
    expect(parseTargetScope(serializeTargetScope(SCOPE))).toEqual(SCOPE);
  });

  it("emits only the three known fields", () => {
    const extra = { ...SCOPE, clientSecret: "planted" } as TargetScope;
    expect(serializeTargetScope(extra)).not.toContain("planted");
  });

  it("returns null for garbage, non-objects, and blank input", () => {
    expect(parseTargetScope(null)).toBeNull();
    expect(parseTargetScope(undefined)).toBeNull();
    expect(parseTargetScope("")).toBeNull();
    expect(parseTargetScope("not json")).toBeNull();
    expect(parseTargetScope("[1,2]")).toBeNull();
    expect(parseTargetScope('"full"')).toBeNull();
  });

  it("returns null for an all-empty scope (must not wipe base config fields)", () => {
    expect(
      parseTargetScope('{"subscriptionId":"","resourceGroup":"","workspaceName":""}'),
    ).toBeNull();
    expect(parseTargetScope("{}")).toBeNull();
  });

  it("tolerates missing/non-string fields, keeping what is usable", () => {
    expect(parseTargetScope('{"subscriptionId":"sub-1","resourceGroup":42}')).toEqual({
      subscriptionId: "sub-1",
      resourceGroup: "",
      workspaceName: "",
    });
  });
});
