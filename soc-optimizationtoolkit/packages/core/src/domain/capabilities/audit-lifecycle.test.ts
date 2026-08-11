/**
 * Contract tests for the audit lifecycle (capability-model-plan step 2).
 *
 * The plan's decisions are the specification, so these pin the decisions rather
 * than the implementation:
 *   - the key folds in everything that changes the answer, and carries no secret;
 *   - launch is the ONLY trigger that conserves requests;
 *   - secret re-entry re-audits even though the key did not change - the case
 *     key-equality alone would miss;
 *   - age is REPORTED, never enforced: nothing expires on a timer;
 *   - another connection's verdicts are never rendered.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIT_SKIP_CACHED_REASON,
  CAPABILITY_AUDIT_KEY_VERSION,
  auditAgeMs,
  capabilityAuditKey,
  describeAuditAge,
  describeCapabilityAudit,
  shouldRunAudit,
  usableCapabilitySet,
  type AuditTrigger,
  type CapabilityAuditKeyInput,
} from "./audit-lifecycle";
import { emptyCapabilitySet, verdictFor } from "./capabilities";
import type { CapabilityContext, CapabilitySet } from "./capabilities";

const KEY_INPUT: CapabilityAuditKeyInput = {
  tenantId: "tenant-a",
  clientId: "client-a",
  subscriptionId: "sub-a",
  resourceGroup: "rg-a",
  workspaceName: "ws-a",
  setupPath: "existing-rg",
  criblWorkerGroup: "default",
};

const KEY = capabilityAuditKey(KEY_INPUT);
const NOW = "2026-08-06T12:00:00Z";

const auditedAt = (iso: string | null, connectionId: string | null = KEY): CapabilitySet => ({
  verdicts: { "dcr.write": "granted" },
  auditedAt: iso,
  connectionId,
});

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

describe("capabilityAuditKey", () => {
  it("is stable for identical input", () => {
    expect(capabilityAuditKey(KEY_INPUT)).toBe(capabilityAuditKey({ ...KEY_INPUT }));
  });

  it("carries the version prefix so the field can be invalidated at once", () => {
    expect(KEY.startsWith(`${CAPABILITY_AUDIT_KEY_VERSION}|`)).toBe(true);
  });

  it("changes when ANY field that changes the answer changes", () => {
    // Each of these makes a cached audit answer a different question: a
    // different App registration, a different scope, a different action set, or
    // a different worker group.
    const fields: (keyof CapabilityAuditKeyInput)[] = [
      "tenantId",
      "clientId",
      "subscriptionId",
      "resourceGroup",
      "workspaceName",
      "criblWorkerGroup",
    ];
    for (const field of fields) {
      const changed = capabilityAuditKey({ ...KEY_INPUT, [field]: "different" });
      expect(changed, `key ignored a change to ${field}`).not.toBe(KEY);
    }
    expect(
      capabilityAuditKey({ ...KEY_INPUT, setupPath: "existing-subscription" }),
    ).not.toBe(KEY);
  });

  it("cannot be forged by a value containing the delimiters", () => {
    // Without escaping, a crafted tenant could produce the same key as a
    // different connection's.
    const forged = capabilityAuditKey({ ...KEY_INPUT, tenantId: "a|client=b" });
    const plain = capabilityAuditKey({ ...KEY_INPUT, tenantId: "a", clientId: "b" });
    expect(forged).not.toBe(plain);
  });

  it("returns a usable key for a wholly unconfigured connection", () => {
    // No null case: an audit run while unconfigured measured nothing, so reusing
    // it is harmless and the caching rule stays one equality check.
    const blank = capabilityAuditKey({
      tenantId: "",
      clientId: "",
      subscriptionId: "",
      resourceGroup: "",
      workspaceName: "",
      setupPath: "existing-rg",
      criblWorkerGroup: "",
    });
    expect(blank).not.toBe("");
    expect(blank).not.toBe(KEY);
  });

  it("never embeds anything secret", () => {
    // The key is persisted. Only non-secret identity and target fields are read,
    // and the input type has no secret field to leak - this pins that a secret
    // planted alongside cannot reach the key.
    const withSecret = {
      ...KEY_INPUT,
      clientSecret: "super-secret-value",
    } as CapabilityAuditKeyInput;
    expect(capabilityAuditKey(withSecret)).not.toContain("super-secret-value");
    expect(capabilityAuditKey(withSecret)).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe("shouldRunAudit", () => {
  it("does NOT re-audit on launch when the cache matches this connection", () => {
    // The plan's explicit conservation decision - the audit costs real requests
    // against a shared budget and permissions change rarely.
    const decision = shouldRunAudit("launch", auditedAt(NOW), KEY);
    expect(decision.run).toBe(false);
    expect(decision.reason).toBe(AUDIT_SKIP_CACHED_REASON);
  });

  it("audits on launch when nothing is cached", () => {
    expect(shouldRunAudit("launch", emptyCapabilitySet(), KEY).run).toBe(true);
  });

  it("audits on launch when the cache is for another connection", () => {
    expect(shouldRunAudit("launch", auditedAt(NOW, "other-key"), KEY).run).toBe(true);
  });

  it("re-audits on secret re-entry even though the key is unchanged", () => {
    // The case key-equality alone would miss: re-entering a secret leaves the
    // identity identical but may turn an unmeasurable connection measurable.
    const decision = shouldRunAudit("secret-entry", auditedAt(NOW), KEY);
    expect(decision.run).toBe(true);
  });

  it("re-audits on every non-launch trigger regardless of cache state", () => {
    const triggers: AuditTrigger[] = [
      "connection-switch",
      "scope-commit",
      "secret-entry",
      "manual",
    ];
    for (const trigger of triggers) {
      expect(shouldRunAudit(trigger, auditedAt(NOW), KEY).run, trigger).toBe(true);
      expect(shouldRunAudit(trigger, emptyCapabilitySet(), KEY).run, trigger).toBe(true);
    }
  });

  it("gives a greppable reason either way", () => {
    for (const trigger of ["launch", "manual"] as AuditTrigger[]) {
      expect(shouldRunAudit(trigger, auditedAt(NOW), KEY).reason).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

describe("age is reported, never enforced", () => {
  it("never expires a cached set on time alone", () => {
    // A year-old audit is still 'current' for its connection. Rule 3 is what
    // makes this safe: a stale verdict costs an annotation, not the ability to
    // work, so silently discarding it would trade honesty for nothing.
    const ancient = auditedAt("2025-08-06T12:00:00Z");
    expect(describeCapabilityAudit(ancient, KEY, NOW).status).toBe("current");
    expect(describeCapabilityAudit(ancient, KEY, NOW).usable).toBe(true);
    expect(shouldRunAudit("launch", ancient, KEY).run).toBe(false);
    expect(describeCapabilityAudit(ancient, KEY, NOW).label).toContain("365 days ago");
  });

  it("describes coarse buckets", () => {
    expect(describeAuditAge(auditedAt("2026-08-06T11:59:30Z"), NOW)).toBe("just now");
    expect(describeAuditAge(auditedAt("2026-08-06T11:59:00Z"), NOW)).toBe("1 minute ago");
    expect(describeAuditAge(auditedAt("2026-08-06T11:30:00Z"), NOW)).toBe("30 minutes ago");
    expect(describeAuditAge(auditedAt("2026-08-06T09:00:00Z"), NOW)).toBe("3 hours ago");
    expect(describeAuditAge(auditedAt("2026-08-04T12:00:00Z"), NOW)).toBe("2 days ago");
  });

  it("says 'never checked' when there is no timestamp", () => {
    expect(describeAuditAge(emptyCapabilitySet(), NOW)).toBe("never checked");
    expect(auditAgeMs(emptyCapabilitySet(), NOW)).toBeNull();
  });

  it("clamps clock skew rather than rendering a negative age", () => {
    const future = auditedAt("2026-08-06T12:05:00Z");
    expect(auditAgeMs(future, NOW)).toBe(0);
    expect(describeAuditAge(future, NOW)).toBe("just now");
  });

  it("degrades to null on an unparseable timestamp", () => {
    expect(auditAgeMs(auditedAt("not-a-date"), NOW)).toBeNull();
    expect(auditAgeMs(auditedAt(NOW), "not-a-date")).toBeNull();
    expect(describeAuditAge(auditedAt("not-a-date"), NOW)).toBe("never checked");
  });
});

// ---------------------------------------------------------------------------
// The composed view + the render guard
// ---------------------------------------------------------------------------

describe("describeCapabilityAudit", () => {
  it("reports 'current' with the age when the set matches", () => {
    const view = describeCapabilityAudit(auditedAt("2026-08-06T11:30:00Z"), KEY, NOW);
    expect(view.status).toBe("current");
    expect(view.usable).toBe(true);
    expect(view.label).toContain("30 minutes ago");
  });

  it("distinguishes never-run from another connection's audit", () => {
    const never = describeCapabilityAudit(emptyCapabilitySet(), KEY, NOW);
    expect(never.status).toBe("never-run");
    expect(never.usable).toBe(false);
    expect(never.label).toContain("not been checked");

    const other = describeCapabilityAudit(auditedAt(NOW, "other-key"), KEY, NOW);
    expect(other.status).toBe("other-connection");
    expect(other.usable).toBe(false);
    expect(other.label).toContain("different connection");
  });
});

describe("usableCapabilitySet", () => {
  it("returns the cached set when it matches", () => {
    const set = auditedAt(NOW);
    expect(usableCapabilitySet(set, KEY)).toBe(set);
  });

  it("never renders another connection's verdicts", () => {
    // The worst failure this model can have is being confidently wrong about
    // permissions. An empty set degrades honestly instead.
    const other = auditedAt(NOW, "other-key");
    const usable = usableCapabilitySet(other, KEY);
    expect(usable.verdicts).toEqual({});

    const context: CapabilityContext = {
      azureIdentityPresent: true,
      criblReachable: true,
    };
    expect(verdictFor("dcr.write", other, context)).toBe("granted");
    expect(verdictFor("dcr.write", usable, context)).toBe("unknown");
  });

  it("degrades an unmatched set to unreachable when there is no connection", () => {
    const usable = usableCapabilitySet(auditedAt(NOW, "other-key"), KEY);
    expect(
      verdictFor("dcr.write", usable, {
        azureIdentityPresent: false,
        criblReachable: false,
      }),
    ).toBe("unreachable");
  });
});
