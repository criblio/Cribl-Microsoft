/**
 * Contract tests for the capability model (docs/capability-model-plan.md).
 * The rules being pinned are the ones the plan calls binding:
 *   - "not measured" never renders as "denied";
 *   - "no connection" is distinct from both, because it is a fact about the
 *     connection rather than a claim about permissions;
 *   - the audit INFORMS and OFFERS, it never forbids - a denied capability is
 *     still attemptable.
 */
import { describe, expect, it } from "vitest";
import {
  AZURE_CAPABILITIES,
  CRIBL_CAPABILITIES,
  can,
  emptyCapabilitySet,
  isAttemptable,
  isAzureCapability,
  isSetForConnection,
  unavailableReason,
  verdictFor,
  type CapabilityContext,
  type CapabilitySet,
} from "./capabilities";

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};
const disconnected: CapabilityContext = {
  azureIdentityPresent: false,
  criblReachable: false,
};
const audited = (
  verdicts: CapabilitySet["verdicts"],
  connectionId = "conn-1",
): CapabilitySet => ({ verdicts, auditedAt: "2026-08-06T00:00:00Z", connectionId });

describe("capability taxonomy", () => {
  it("splits Azure from Cribl with no overlap", () => {
    for (const c of AZURE_CAPABILITIES) expect(isAzureCapability(c)).toBe(true);
    for (const c of CRIBL_CAPABILITIES) expect(isAzureCapability(c)).toBe(false);
  });
});

describe("verdictFor - pre-audit state derives from identity", () => {
  it("is 'unreachable' with no connection, not 'denied'", () => {
    // The plan's core correction: with no identity we KNOW nothing Azure can
    // work, and that is a fact about the connection - asserting 'denied' would
    // claim a permission fact we never established.
    const set = emptyCapabilitySet();
    expect(verdictFor("dcr.write", set, disconnected)).toBe("unreachable");
    expect(verdictFor("pack.manage", set, disconnected)).toBe("unreachable");
  });

  it("is 'unknown' when connected but never audited", () => {
    expect(verdictFor("dcr.write", emptyCapabilitySet(), connected)).toBe("unknown");
  });

  it("resolves the two sides independently", () => {
    const azureOnly: CapabilityContext = {
      azureIdentityPresent: true,
      criblReachable: false,
    };
    const set = emptyCapabilitySet();
    expect(verdictFor("dcr.write", set, azureOnly)).toBe("unknown");
    expect(verdictFor("pack.manage", set, azureOnly)).toBe("unreachable");
  });

  it("lets a measured verdict win over context - evidence beats inference", () => {
    // Even with no identity in context, a recorded measurement is what we know.
    const set = audited({ "dcr.write": "granted" });
    expect(verdictFor("dcr.write", set, disconnected)).toBe("granted");
  });

  it("never infers 'denied' - it is only ever a measured answer", () => {
    for (const ctx of [connected, disconnected]) {
      for (const c of [...AZURE_CAPABILITIES, ...CRIBL_CAPABILITIES]) {
        expect(verdictFor(c, emptyCapabilitySet(), ctx)).not.toBe("denied");
      }
    }
  });
});

describe("can - strictly 'may we present this as working?'", () => {
  it("is true only for a measured grant", () => {
    expect(can("dcr.write", audited({ "dcr.write": "granted" }), connected)).toBe(true);
    expect(can("dcr.write", audited({ "dcr.write": "denied" }), connected)).toBe(false);
    expect(can("dcr.write", emptyCapabilitySet(), connected)).toBe(false);
    expect(can("dcr.write", emptyCapabilitySet(), disconnected)).toBe(false);
  });
});

describe("isAttemptable - the audit informs, it never forbids", () => {
  it("still permits a denied action", () => {
    // Rule 3. Azure's own 403 is the real gate; a stale or wrong audit must not
    // cost the operator the ability to work.
    expect(isAttemptable("dcr.write", audited({ "dcr.write": "denied" }), connected)).toBe(true);
  });

  it("permits unknown and granted", () => {
    expect(isAttemptable("dcr.write", emptyCapabilitySet(), connected)).toBe(true);
    expect(isAttemptable("dcr.write", audited({ "dcr.write": "granted" }), connected)).toBe(true);
  });

  it("refuses only when there is nowhere to send the request", () => {
    expect(isAttemptable("dcr.write", emptyCapabilitySet(), disconnected)).toBe(false);
  });

  it("is never narrower than can(), for every capability and state", () => {
    for (const c of [...AZURE_CAPABILITIES, ...CRIBL_CAPABILITIES]) {
      for (const set of [
        emptyCapabilitySet(),
        audited({ [c]: "granted" }),
        audited({ [c]: "denied" }),
      ]) {
        for (const ctx of [connected, disconnected]) {
          if (can(c, set, ctx)) expect(isAttemptable(c, set, ctx)).toBe(true);
        }
      }
    }
  });
});

describe("isSetForConnection", () => {
  it("rejects a set measured against a different connection", () => {
    expect(isSetForConnection(audited({}, "conn-1"), "conn-2")).toBe(false);
    expect(isSetForConnection(audited({}, "conn-1"), "conn-1")).toBe(true);
  });

  it("rejects an unaudited set", () => {
    expect(isSetForConnection(emptyCapabilitySet(), "conn-1")).toBe(false);
    expect(isSetForConnection(emptyCapabilitySet(), null)).toBe(false);
  });
});

describe("unavailableReason", () => {
  it("says nothing when granted", () => {
    expect(unavailableReason("dcr.write", audited({ "dcr.write": "granted" }), connected)).toBeNull();
  });

  it("keeps connection wording distinct from permission wording", () => {
    // Conflating these is what the plan set out to avoid.
    const noConn = unavailableReason("dcr.write", emptyCapabilitySet(), disconnected);
    const denied = unavailableReason("dcr.write", audited({ "dcr.write": "denied" }), connected);
    expect(noConn).toContain("Connect Azure");
    expect(denied).toContain("cannot do this");
    expect(denied).not.toContain("Connect Azure");
  });

  it("offers the fallback in the denied wording", () => {
    const denied = unavailableReason("dcr.write", audited({ "dcr.write": "denied" }), connected);
    expect(denied).toContain("someone who can");
  });

  it("names the right side for a Cribl capability", () => {
    expect(unavailableReason("pack.manage", emptyCapabilitySet(), disconnected)).toContain("Connect Cribl");
  });

  it("says unknown is unchecked, never refused", () => {
    const unknown = unavailableReason("dcr.write", emptyCapabilitySet(), connected) ?? "";
    expect(unknown).toContain("Not checked yet");
    expect(unknown).not.toContain("cannot");
  });
});
