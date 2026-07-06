import { describe, expect, it } from "vitest";

import {
  deployedGroups,
  interpretInstallResponse,
  isPackDeployed,
  packDeleteRequest,
  packIdFromCrblFileName,
  packInstallRequest,
  packListRequest,
  packUploadRequest,
  parsePackListResponse,
  parseUploadResponse,
} from "./install";

const BASE = "https://main-abc.cribl.cloud";

describe("two-step upload request shaping", () => {
  it("PUT ?filename= carries the octet-stream content type and encoded name", () => {
    const req = packUploadRequest(BASE, "default", "paloalto sentinel.crbl");
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(
      "https://main-abc.cribl.cloud/api/v1/m/default/packs?filename=paloalto%20sentinel.crbl",
    );
    expect(req.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("POST install uses the RETURNED randomized source, not the uploaded name", () => {
    const upload = parseUploadResponse(200, JSON.stringify({ source: "paloalto-sentinel.h1i8P1M.crbl" }));
    expect(upload).toEqual({ ok: true, source: "paloalto-sentinel.h1i8P1M.crbl" });
    const req = packInstallRequest(BASE, "wg1", (upload as { source: string }).source);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://main-abc.cribl.cloud/api/v1/m/wg1/packs");
    expect(JSON.parse(req.body!)).toEqual({ source: "paloalto-sentinel.h1i8P1M.crbl" });
  });

  it("flags upload failures and missing/unparseable sources", () => {
    expect(parseUploadResponse(500, "boom").ok).toBe(false);
    expect(parseUploadResponse(200, "{}").ok).toBe(false);
    expect(parseUploadResponse(200, "not json").ok).toBe(false);
  });
});

describe("install response interpretation", () => {
  it("reads the installed pack summary from items[0]", () => {
    const out = interpretInstallResponse(
      200,
      JSON.stringify({ items: [{ id: "p", displayName: "Palo", version: "1.0.0" }] }),
    );
    expect(out).toEqual({ kind: "installed", pack: { id: "p", displayName: "Palo", version: "1.0.0" } });
  });

  it("detects the duplicate-conflict signal (500 + message)", () => {
    expect(interpretInstallResponse(500, "pack conflicts with existing Pack foo")).toEqual({ kind: "conflict" });
  });

  it("returns error for other non-2xx responses", () => {
    expect(interpretInstallResponse(403, "denied").kind).toBe("error");
  });
});

describe("duplicate-conflict delete-and-retry helpers", () => {
  it("derives the pack id from the original .crbl filename", () => {
    expect(packIdFromCrblFileName("crowdstrike-fdr-sentinel_1.0.0.crbl")).toBe("crowdstrike-fdr-sentinel");
    expect(packIdFromCrblFileName("paloalto-sentinel.h1i8P1M.crbl")).toBe("paloalto-sentinel");
  });

  it("shapes the delete request for the existing pack", () => {
    const req = packDeleteRequest(BASE, "default", "paloalto-sentinel");
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("https://main-abc.cribl.cloud/api/v1/m/default/packs/paloalto-sentinel");
  });
});

describe("deployed status is TRUTH FROM THE PACKS API", () => {
  it("parses items/data/array response shapes", () => {
    expect(parsePackListResponse(200, JSON.stringify({ items: [{ id: "a", version: "1" }] }))).toEqual({
      ok: true,
      packs: [{ id: "a", displayName: "a", version: "1" }],
    });
    expect(parsePackListResponse(200, JSON.stringify([{ id: "b" }]))).toEqual({
      ok: true,
      packs: [{ id: "b", displayName: "b", version: "" }],
    });
    expect(parsePackListResponse(500, "x").ok).toBe(false);
  });

  it("packListRequest targets the group packs endpoint", () => {
    expect(packListRequest(BASE, "wg2").url).toBe("https://main-abc.cribl.cloud/api/v1/m/wg2/packs");
  });

  it("resolves deployed status per worker group from the API listing", () => {
    const list = [{ id: "paloalto-sentinel", displayName: "Palo", version: "1.0.0" }];
    expect(isPackDeployed(list, "paloalto-sentinel")).toBe(true);
    expect(isPackDeployed(list, "other")).toBe(false);
    const groups = deployedGroups("paloalto-sentinel", [
      { group: "wg1", packs: list },
      { group: "wg2", packs: [] },
    ]);
    expect(groups).toEqual(["wg1"]);
  });
});
