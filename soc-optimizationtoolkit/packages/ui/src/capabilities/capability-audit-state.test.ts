/**
 * Tests for the pure capability-audit derivations.
 *
 * The load-bearing one is the identity rule: it is what lets the domain tell
 * "Connect Azure to enable" apart from "not checked yet", and conflating those
 * is exactly what the capability model was created to stop.
 */
import { describe, expect, it } from "vitest";

import {
  auditStatusTone,
  deriveCapabilityContext,
  hasAzureIdentity,
  refreshLabel,
} from "./capability-audit-state";
import { EMPTY_AZURE_CONFIG, verdictFor, emptyCapabilitySet } from "@soc/core";
import type { AzureConfig, AuditStatus } from "@soc/core";

const identified: AzureConfig = {
  ...EMPTY_AZURE_CONFIG,
  tenantId: "tenant-a",
  clientId: "client-a",
};

describe("hasAzureIdentity", () => {
  it("requires BOTH ids", () => {
    // Half an identity cannot authenticate, so calling it present would have the
    // UI blame permissions for an incomplete connection.
    expect(hasAzureIdentity(identified)).toBe(true);
    expect(hasAzureIdentity({ ...identified, clientId: "" })).toBe(false);
    expect(hasAzureIdentity({ ...identified, tenantId: "" })).toBe(false);
    expect(hasAzureIdentity(EMPTY_AZURE_CONFIG)).toBe(false);
  });
});

describe("deriveCapabilityContext", () => {
  it("drives the unreachable-vs-unknown distinction", () => {
    const connected = deriveCapabilityContext(identified, true);
    const noIdentity = deriveCapabilityContext(EMPTY_AZURE_CONFIG, true);
    const set = emptyCapabilitySet();

    expect(verdictFor("dcr.write", set, connected)).toBe("unknown");
    expect(verdictFor("dcr.write", set, noIdentity)).toBe("unreachable");
  });

  it("takes criblReachable from the shell rather than the Azure config", () => {
    // The two shells know it differently - cloud is granted by the platform,
    // local connects out - so it is never inferred from Azure fields here.
    expect(deriveCapabilityContext(identified, false).criblReachable).toBe(false);
    expect(deriveCapabilityContext(EMPTY_AZURE_CONFIG, true).criblReachable).toBe(true);
  });
});

describe("presentation helpers", () => {
  it("tones every audit status", () => {
    const statuses: AuditStatus[] = ["current", "never-run", "other-connection"];
    for (const status of statuses) {
      expect(auditStatusTone(status)).not.toBe("");
    }
    expect(auditStatusTone("current")).toBe("ok");
  });

  it("labels the refresh control with its own state", () => {
    expect(refreshLabel(false)).toBe("Re-check permissions");
    expect(refreshLabel(true)).toBe("Checking...");
  });
});
