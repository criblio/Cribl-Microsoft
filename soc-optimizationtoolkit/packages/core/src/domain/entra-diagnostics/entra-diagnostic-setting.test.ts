// Pins for the path-form Entra diagnostic-settings list (AZR-32 Validate).
//
// Validate reads through the AzureManagement port, which takes a PATH and an
// api-version, not a full URL. The path form must name the same resource and
// api-version as the URL form its existing callers use, and must be a GET.

import { describe, expect, it } from "vitest";

import {
  AADIAM_API_VERSION,
  ENTRA_DIAGNOSTIC_SETTINGS_PATH,
  listSettingsRequest,
  listSettingsUrl,
} from "./index";

describe("entra-diagnostic-setting: listSettingsRequest (path form)", () => {
  it("is a GET of the tenant-level aadiam path at api-version 2017-04-01", () => {
    expect(listSettingsRequest()).toEqual({
      method: "GET",
      path: "/providers/microsoft.aadiam/diagnosticSettings",
      apiVersion: "2017-04-01",
    });
  });

  it("names the same resource and api-version as the URL form", () => {
    const req = listSettingsRequest();
    expect(listSettingsUrl()).toBe(
      `https://management.azure.com${req.path}?api-version=${req.apiVersion}`,
    );
    expect(req.apiVersion).toBe(AADIAM_API_VERSION);
    expect(req.path).toBe(ENTRA_DIAGNOSTIC_SETTINGS_PATH);
  });

  it("carries no host, no query and no body", () => {
    const req = listSettingsRequest();
    expect(req.path.startsWith("/")).toBe(true);
    expect(req.path).not.toContain("api-version");
    expect(req.query).toBeUndefined();
    expect(req.body).toBeUndefined();
  });
});
