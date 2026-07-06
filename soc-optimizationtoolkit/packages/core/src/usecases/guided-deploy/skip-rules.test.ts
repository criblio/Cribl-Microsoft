import { describe, expect, it } from "vitest";
import {
  decideBuildPackStep,
  decideCustomTablesStep,
  decideDcrsStep,
  decideEmbedStep,
  destinationExistsForTable,
  hasCustomTables,
  normalizeTableKey,
} from "./skip-rules";

describe("normalizeTableKey / hasCustomTables", () => {
  it("strips one trailing _CL (case-insensitive) and lowercases", () => {
    expect(normalizeTableKey("CloudFlare_CL")).toBe("cloudflare");
    expect(normalizeTableKey("SecurityEvent")).toBe("securityevent");
  });
  it("detects custom tables", () => {
    expect(hasCustomTables(["SecurityEvent", "CloudFlare_CL"])).toBe(true);
    expect(hasCustomTables(["SecurityEvent", "Syslog"])).toBe(false);
  });
});

describe("destinationExistsForTable - NORMALIZED-EXACT (no fuzzy cross-match)", () => {
  it("matches on the normalized key", () => {
    expect(destinationExistsForTable("CloudFlare_CL", ["cloudflare"])).toBe(true);
    expect(destinationExistsForTable("SecurityEvent", ["Syslog"])).toBe(false);
  });

  it("FIXES the legacy fuzzy substring cross-match (Cloudflare vs CloudflareAudit)", () => {
    // The legacy findDestinationForTable used includes() both directions, so
    // "Cloudflare" wrongly matched a "CloudflareAudit" destination. Exact keys
    // never do.
    expect(destinationExistsForTable("Cloudflare", ["CloudflareAudit"])).toBe(false);
    expect(destinationExistsForTable("CloudflareAudit", ["Cloudflare"])).toBe(false);
  });
});

describe("decideCustomTablesStep - skip when no _CL (or offline)", () => {
  it("skips when there are no custom tables", () => {
    expect(decideCustomTablesStep(["SecurityEvent"], { skipAzure: false })).toEqual({
      kind: "skip",
      detail: "No custom tables needed (native tables only)",
    });
  });
  it("runs when a custom table is present", () => {
    expect(decideCustomTablesStep(["CloudFlare_CL"], { skipAzure: false }).kind).toBe(
      "run",
    );
  });
  it("skips entirely when Azure is skipped (offline mode)", () => {
    expect(decideCustomTablesStep(["CloudFlare_CL"], { skipAzure: true }).kind).toBe(
      "skip",
    );
  });
});

describe("decideDcrsStep - skip when all destinations exist", () => {
  it("skips when every table already has a destination", () => {
    const decision = decideDcrsStep(
      ["SecurityEvent", "CloudFlare_CL"],
      ["securityevent", "cloudflare"],
      { skipAzure: false },
    );
    expect(decision).toEqual({ kind: "skip", detail: "DCRs already deployed" });
  });

  it("runs, reporting only the tables that still need a DCR", () => {
    const decision = decideDcrsStep(
      ["SecurityEvent", "CloudFlare_CL"],
      ["securityevent"],
      { skipAzure: false },
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.tablesToDeploy).toEqual(["CloudFlare_CL"]);
    }
  });

  it("skips when Azure is skipped (offline mode)", () => {
    expect(decideDcrsStep(["SecurityEvent"], [], { skipAzure: true }).kind).toBe(
      "skip",
    );
  });
});

describe("decideBuildPackStep - short-circuit when the pack exists", () => {
  it("reuses an existing pack", () => {
    expect(decideBuildPackStep(true).kind).toBe("reuse");
  });
  it("builds when no pack exists", () => {
    expect(decideBuildPackStep(false).kind).toBe("build");
  });
});

describe("decideEmbedStep - embed / skip / error semantics", () => {
  it("embeds when destinations matched and the pack exists", () => {
    expect(decideEmbedStep({ matchedCount: 2, packCreated: true })).toEqual({
      kind: "embed",
      detail: "2 destination(s) embedded",
    });
  });
  it("errors when no destinations matched", () => {
    expect(decideEmbedStep({ matchedCount: 0, packCreated: true }).kind).toBe("error");
  });
  it("skips when destinations matched but the pack is not yet created", () => {
    expect(decideEmbedStep({ matchedCount: 2, packCreated: false }).kind).toBe("skip");
  });
});
