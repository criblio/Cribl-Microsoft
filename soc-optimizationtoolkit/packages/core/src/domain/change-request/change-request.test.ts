/**
 * Characterization tests for the change-request ticket generators. Output is
 * deterministic, so these tests pin exact substrings for:
 *   - a fully-populated context (real names appear) and a blank context
 *     (placeholders appear so the request is visibly incomplete)
 *   - setupPath-driven role selection in roleAssignmentRequest (lab-new-rg
 *     carries RBAC Administrator + the "Constrain roles and principal types"
 *     condition; existing does not)
 *   - the includeDiagram option and the embedded Mermaid fenced block
 *   - ASCII-only-ness of the full ticket body (the Mermaid SOURCE is 7-bit)
 */
import { describe, expect, it } from "vitest";
import {
  appRegistrationRequest,
  resourceCreationRequest,
  roleAssignmentRequest,
} from "./index";
import type { ChangeRequestContext } from "./index";
import type { AzureConfig, AzureSetupPath } from "../azure-config";

function ctxFor(
  setupPath: AzureSetupPath,
  overrides?: Partial<AzureConfig>,
): ChangeRequestContext {
  return {
    appName: "Cribl SOC Toolkit",
    config: {
      clientId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      subscriptionId: "33333333-3333-3333-3333-333333333333",
      resourceGroup: "rg-soc-lab",
      workspaceName: "law-soc-lab",
      setupPath,
      ...overrides,
    },
  };
}

function emptyCtx(setupPath: AzureSetupPath): ChangeRequestContext {
  return {
    appName: "",
    config: {
      clientId: "",
      tenantId: "",
      subscriptionId: "",
      resourceGroup: "",
      workspaceName: "",
      setupPath,
    },
  };
}

// Code-point checks instead of character-class regexes (which trip oxlint's
// no-control-regex / no-misleading-character-class on the control and
// variation-selector ranges). for...of iterates by code point.
function hasNonAscii(s: string): boolean {
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x7f) return true;
  }
  return false;
}

function hasEmoji(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x2b00 && cp <= 0x2bff) ||
      (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
      return true;
    }
  }
  return false;
}

describe("appRegistrationRequest", () => {
  it("asks for a single-tenant daemon app + secret and embeds the auth flow", () => {
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain(
      "Change request: create Entra app registration for Cribl SOC Toolkit",
    );
    expect(out).toContain("single-tenant Entra app registration");
    expect(out).toContain("no redirect URI");
    expect(out).toContain("Create a client secret");
    expect(out).toContain("client_credentials");
    expect(out).toContain("Securely share");
    // Concrete specifics from ctx.
    expect(out).toContain("Tenant id:");
    expect(out).toContain("22222222-2222-2222-2222-222222222222");
    expect(out).toContain(
      "Application (client) id: 11111111-1111-1111-1111-111111111111",
    );
    // Embedded auth-flow diagram.
    expect(out).toContain("Why (authentication flow)");
    expect(out).toContain("login.microsoftonline.com");
  });

  it("renders placeholders for a blank context", () => {
    const out = appRegistrationRequest(emptyCtx("existing"));
    expect(out).toContain("<app name>");
    expect(out).toContain("<tenant id>");
    expect(out).toContain("<client id>");
  });

  it("asks for EVERY permission the app needs, not just the registration", () => {
    // The defect this section exists for: the ticket used to stop at "create the
    // registration and a secret", so an operator who got exactly what they asked
    // for had an app that could authenticate and do nothing else - then needed a
    // fresh ticket per missing permission, discovered one failure at a time.
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain("Application.Read.All");
    expect(out).toContain("Reader");
    expect(out).toContain("Monitoring Contributor");
    expect(out).toContain("Log Analytics Contributor");
    expect(out).toContain("Microsoft Sentinel Contributor");
    expect(out).toContain("RBAC Administrator");
  });

  it("separates Graph consent from RBAC assignment - different approvers", () => {
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain("Microsoft Graph API permissions (admin consent required)");
    expect(out).toContain("Azure RBAC roles (setup path: existing)");
    // APPLICATION, not delegated: the app runs headless, and a delegated grant
    // would consent cleanly and then fail at runtime with no user to act as.
    expect(out).toContain("APPLICATION permissions");
  });

  it("states which feature needs each permission and what refusing it costs", () => {
    // Without the cost line an approver cannot tell a blocker from a
    // nice-to-have, and the safe answer to that is no.
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain("Needed for:");
    expect(out).toContain("If not granted:");
    expect(out).toContain("[core]");
    expect(out).toContain("[feature]");
  });

  it("resolves each RBAC scope so the approver need not look anything up", () => {
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain("Scope:          /subscriptions/33333333-3333-3333-3333-333333333333");
    expect(out).toContain(
      "Scope:          /subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-soc-lab",
    );
    // A Graph permission has no subscription scope, and rendering one would
    // send the approver to the wrong portal blade entirely.
    expect(out).toContain("tenant-wide (consented on the app registration)");
  });

  it("points each portal step at ITS OWN portal", () => {
    // Graph consent and an RBAC condition both need a portal, but not the same
    // one. A single generic "use the portal" line sends the Graph approver
    // hunting through RBAC blades for a permission that is not there.
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain("Entra ID > App registrations");
    expect(out).toContain("Grant admin consent");
    expect(out).toContain("the condition above cannot be");
  });

  it("wraps long justifications with a hanging indent, never back to column 0", () => {
    // Caught in the live preview: unwrapped 300-character justifications reflowed
    // to column 0 and destroyed the block alignment, beside a document that hard
    // -wraps everything else. Ticketing systems do not reflow this back.
    const out = appRegistrationRequest(ctxFor("existing"), { includeDiagram: false });
    // Only the permission blocks: a field line (4 spaces + label) or one of its
    // continuations (the 20-column hanging indent).
    const blockLines = out
      .split("\n")
      .filter((line) => /^ {4}[A-Z]/.test(line) || /^ {20}\S/.test(line));
    expect(blockLines.length).toBeGreaterThan(20);
    for (const line of blockLines) {
      // The wrapper never BREAKS a word, so a line may only exceed the limit
      // when one token is itself too long to fit - a resource id, say, which is
      // far more useful whole than split across two lines.
      const longest = Math.max(...line.trim().split(" ").map((w) => w.length));
      if (longest <= 58) {
        expect(line.length, line).toBeLessThanOrEqual(78);
      }
    }
    // Continuation lines sit under the value column, not at the margin.
    expect(out).toMatch(/\n {20}\S/);
  });

  it("does not ask a lab path for roles its Contributor grant already covers", () => {
    // Over-asking gets a whole request refused. Contributor writes
    // SecurityInsights resources, so naming Sentinel Contributor beside it reads
    // as someone who does not know what they need.
    const out = appRegistrationRequest(ctxFor("lab-new-rg"));
    expect(out).not.toContain("Microsoft Sentinel Contributor");
  });
});

describe("roleAssignmentRequest role selection", () => {
  it("existing: Reader + Monitoring/Log Analytics Contributor, no RBAC Administrator", () => {
    const out = roleAssignmentRequest(ctxFor("existing"));
    expect(out).toContain("Reader at /subscriptions/33333333-3333-3333-3333-333333333333");
    expect(out).toContain(
      "Monitoring Contributor at /subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-soc-lab",
    );
    expect(out).toContain(
      "Log Analytics Contributor at /subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-soc-lab",
    );
    expect(out).not.toContain("RBAC Administrator");
    expect(out).not.toContain("Constrain roles and principal types");
    // One justification line per role, and the SP named by client id.
    expect(out).toContain("client id: 11111111-1111-1111-1111-111111111111");
  });

  it("lab-new-rg: subscription Contributor + RBAC Administrator with the constraint condition", () => {
    const out = roleAssignmentRequest(ctxFor("lab-new-rg"));
    expect(out).toContain(
      "Contributor at /subscriptions/33333333-3333-3333-3333-333333333333",
    );
    expect(out).toContain(
      "RBAC Administrator at /subscriptions/33333333-3333-3333-3333-333333333333",
    );
    expect(out).toContain(
      "Condition: Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.",
    );
    // Not scoped to a resource group on this path.
    expect(out).not.toContain("Reader at");
  });

  it("lab-byo-rg: Contributor on the pre-created RG only, no RBAC Administrator", () => {
    const out = roleAssignmentRequest(ctxFor("lab-byo-rg"));
    expect(out).toContain(
      "Contributor at /subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-soc-lab",
    );
    expect(out).not.toContain("RBAC Administrator");
    expect(out).not.toContain("Reader at");
  });

  it("embeds both the deploy and ingestion flows, and renders placeholders when blank", () => {
    const out = roleAssignmentRequest(ctxFor("existing"));
    expect(out).toContain("Why (deploy and ingestion flows)");
    expect(out).toContain("DCR + custom table");
    expect(out).toContain("Microsoft Sentinel");

    const blank = roleAssignmentRequest(emptyCtx("existing"));
    expect(blank).toContain(
      "Reader at /subscriptions/<subscription id>",
    );
    expect(blank).toContain("<client id>");
  });
});

describe("resourceCreationRequest", () => {
  it("lab-new-rg: asks for a TTL lab resource group plus an Event Hub namespace", () => {
    const out = resourceCreationRequest(ctxFor("lab-new-rg"));
    expect(out).toContain("Create a lab resource group named rg-soc-lab");
    expect(out).toContain("time-to-live (TTL)");
    expect(out).toContain("self-destructs");
    expect(out).toContain("Create an Event Hub namespace in resource group rg-soc-lab");
    // Embedded data export flow.
    expect(out).toContain("Why (data export flow)");
    expect(out).toContain("Event Hub");
  });

  it("existing: asks only for the Event Hub namespace, not a lab resource group", () => {
    const out = resourceCreationRequest(ctxFor("existing"));
    expect(out).toContain("Create an Event Hub namespace");
    expect(out).not.toContain("Create a lab resource group");
    expect(out).not.toContain("self-destructs");
  });

  it("renders placeholders for a blank context", () => {
    const out = resourceCreationRequest(emptyCtx("lab-new-rg"));
    expect(out).toContain("<resource group>");
    expect(out).toContain("<subscription id>");
  });
});

describe("diagram options", () => {
  it("includeDiagram: false omits the embedded diagram section", () => {
    const out = appRegistrationRequest(ctxFor("existing"), {
      includeDiagram: false,
    });
    expect(out).not.toContain("Why (authentication flow)");
    expect(out).not.toContain("```mermaid");
    // The rest of the ticket is still present.
    expect(out).toContain("What is requested");
  });

  it("includeDiagram: true (explicit) embeds the mermaid fenced block", () => {
    const out = roleAssignmentRequest(ctxFor("existing"), {
      includeDiagram: true,
    });
    expect(out).toContain("```mermaid");
    expect(out).toContain("flowchart");
  });

  it("defaults to embedding the mermaid fenced block", () => {
    const out = appRegistrationRequest(ctxFor("existing"));
    expect(out).toContain("```mermaid");
    expect(out).toContain("flowchart");
  });
});

describe("byte-safety and determinism", () => {
  const generators = [
    appRegistrationRequest,
    roleAssignmentRequest,
    resourceCreationRequest,
  ] as const;
  const paths: AzureSetupPath[] = ["existing", "lab-new-rg", "lab-byo-rg"];

  it("every ticket body is 7-bit ASCII with no emoji (mermaid source included)", () => {
    for (const gen of generators) {
      for (const path of paths) {
        const out = gen(ctxFor(path));
        expect(hasNonAscii(out)).toBe(false);
        expect(hasEmoji(out)).toBe(false);
      }
    }
  });

  it("is deterministic (same input -> identical output)", () => {
    for (const gen of generators) {
      expect(gen(ctxFor("lab-new-rg"))).toBe(gen(ctxFor("lab-new-rg")));
    }
  });
});
