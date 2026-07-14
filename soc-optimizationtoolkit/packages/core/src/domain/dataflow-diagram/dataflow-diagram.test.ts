/**
 * Characterization tests for the dataflow-diagram renderer. Output is
 * deterministic and pure, so these tests pin exact substrings, the placeholder
 * behaviour for blank fields, ASCII-only-ness of the Mermaid source (every byte
 * < 128, no emoji), and the Mermaid `flowchart` marker.
 */
import { describe, expect, it } from "vitest";
import {
  authFlowMermaid,
  dataExportFlowMermaid,
  dcrDeployFlowMermaid,
  resolveNames,
} from "./index";
import type { DiagramContext } from "./index";

const FULL_CTX: DiagramContext = {
  appName: "Cribl SOC Toolkit",
  config: {
    clientId: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    subscriptionId: "33333333-3333-3333-3333-333333333333",
    resourceGroup: "rg-soc-lab",
    workspaceName: "law-soc-lab",
    setupPath: "existing",
  },
};

const EMPTY_CTX: DiagramContext = {
  appName: "",
  config: {
    clientId: "",
    tenantId: "",
    subscriptionId: "",
    resourceGroup: "",
    workspaceName: "",
    setupPath: "existing",
  },
};

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

const MERMAID_DIAGRAMS = [
  authFlowMermaid,
  dataExportFlowMermaid,
  dcrDeployFlowMermaid,
] as const;

describe("resolveNames", () => {
  it("passes through real values (trimmed)", () => {
    const n = resolveNames({
      appName: "  Padded App  ",
      config: { ...FULL_CTX.config },
    });
    expect(n.appName).toBe("Padded App");
    expect(n.tenantId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("substitutes a clear placeholder for every blank field", () => {
    const n = resolveNames(EMPTY_CTX);
    expect(n).toEqual({
      appName: "<app name>",
      clientId: "<client id>",
      tenantId: "<tenant id>",
      subscriptionId: "<subscription id>",
      resourceGroup: "<resource group>",
      workspaceName: "<workspace name>",
    });
  });
});

describe("mermaid diagrams", () => {
  it("are fenced flowchart blocks", () => {
    for (const render of MERMAID_DIAGRAMS) {
      const out = render(FULL_CTX);
      expect(out).toContain("flowchart");
      expect(out.startsWith("```mermaid")).toBe(true);
      expect(out.endsWith("```")).toBe(true);
    }
  });

  it("contain only 7-bit ASCII and no emoji", () => {
    for (const render of MERMAID_DIAGRAMS) {
      for (const ctx of [FULL_CTX, EMPTY_CTX]) {
        const out = render(ctx);
        expect(hasNonAscii(out)).toBe(false);
        expect(hasEmoji(out)).toBe(false);
        for (let i = 0; i < out.length; i++) {
          expect(out.charCodeAt(i)).toBeLessThan(128);
        }
      }
    }
  });

  it("entity-encode placeholder angle brackets so labels survive rendering", () => {
    const out = authFlowMermaid(EMPTY_CTX);
    expect(out).toContain("&lt;tenant id&gt;");
    expect(out).not.toContain("<tenant id>");
  });

  it("entity-encode a placeholder in every diagram for a blank context", () => {
    for (const render of MERMAID_DIAGRAMS) {
      const out = render(EMPTY_CTX);
      expect(out).toContain("&lt;");
      expect(out).toContain("&gt;");
    }
    expect(dataExportFlowMermaid(EMPTY_CTX)).toContain(
      "workspace &lt;workspace name&gt;",
    );
    expect(dcrDeployFlowMermaid(EMPTY_CTX)).toContain(
      "resource group &lt;resource group&gt;",
    );
  });

  it("carry the real names when present", () => {
    const auth = authFlowMermaid(FULL_CTX);
    expect(auth).toContain("Cribl SOC Toolkit");
    expect(auth).toContain("login.microsoftonline.com");
    expect(auth).toContain("tenant 22222222-2222-2222-2222-222222222222");
    expect(auth).toContain("client 11111111-1111-1111-1111-111111111111");

    const exported = dataExportFlowMermaid(FULL_CTX);
    expect(exported).toContain("Event Hub");
    expect(exported).toContain("law-soc-lab");
    expect(exported).toContain("rg-soc-lab");

    const deploy = dcrDeployFlowMermaid(FULL_CTX);
    expect(deploy).toContain("DCR + custom table");
    expect(deploy).toContain("33333333-3333-3333-3333-333333333333");
  });

  it("are deterministic (same input -> identical output)", () => {
    for (const render of MERMAID_DIAGRAMS) {
      expect(render(FULL_CTX)).toBe(render(FULL_CTX));
      expect(render(EMPTY_CTX)).toBe(render(EMPTY_CTX));
    }
  });
});
