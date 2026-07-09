/**
 * Pins for the vendor-identity module (user request 2026-07-08: determine
 * DeviceVendor/DeviceProduct per vendor where possible, and FORCE the user to
 * input them where not). The resolution ladder order (sample > enrichment >
 * missing) is load-bearing: an enrichment constant over a sample-provided
 * column would overwrite real per-event values.
 */

import { describe, expect, it } from "vitest";
import {
  detectVendorIdentity,
  identityGateMessage,
  missingIdentityFields,
  requiredIdentityFields,
  resolveIdentityFields,
  suggestedIdentityValue,
} from "./vendor-identity";

describe("requiredIdentityFields", () => {
  it("requires DeviceVendor/DeviceProduct for CommonSecurityLog", () => {
    expect(requiredIdentityFields("CommonSecurityLog")).toEqual([
      "DeviceVendor",
      "DeviceProduct",
    ]);
  });

  it("requires EventVendor/EventProduct for ASim tables", () => {
    expect(requiredIdentityFields("ASimNetworkSessionLogs")).toEqual([
      "EventVendor",
      "EventProduct",
    ]);
  });

  it("requires nothing for other tables", () => {
    expect(requiredIdentityFields("SecurityEvent")).toEqual([]);
    expect(requiredIdentityFields("Syslog")).toEqual([]);
    expect(requiredIdentityFields("MyApp_CL")).toEqual([]);
  });
});

describe("detectVendorIdentity", () => {
  it("detects Palo Alto from typical solution names", () => {
    expect(detectVendorIdentity("PaloAlto-PAN-OS")).toEqual({
      vendor: "Palo Alto Networks",
      product: "PAN-OS",
    });
    expect(detectVendorIdentity("Palo Alto Networks NGFW")).toEqual({
      vendor: "Palo Alto Networks",
      product: "PAN-OS",
    });
  });

  it("detects Fortinet FortiGate", () => {
    expect(detectVendorIdentity("Fortinet FortiGate Next-Generation Firewall"))
      .toEqual({ vendor: "Fortinet", product: "Fortigate" });
  });

  it("suggests vendor only where the product varies by log type", () => {
    expect(detectVendorIdentity("Zscaler Internet Access")).toEqual({
      vendor: "Zscaler",
    });
  });

  it("prefers the more specific entry (ClearPass over bare Aruba)", () => {
    expect(detectVendorIdentity("Aruba ClearPass")).toEqual({
      vendor: "Aruba Networks",
      product: "ClearPass",
    });
    expect(detectVendorIdentity("Aruba Networks Switches")).toEqual({
      vendor: "Aruba Networks",
    });
  });

  it("returns null for uncurated solutions and empty names", () => {
    expect(detectVendorIdentity("Cloudflare")).toBeNull();
    expect(detectVendorIdentity("")).toBeNull();
  });
});

describe("suggestedIdentityValue", () => {
  const identity = { vendor: "Palo Alto Networks", product: "PAN-OS" };

  it("maps *Vendor fields to the vendor and *Product to the product", () => {
    expect(suggestedIdentityValue("DeviceVendor", identity)).toBe(
      "Palo Alto Networks",
    );
    expect(suggestedIdentityValue("EventProduct", identity)).toBe("PAN-OS");
  });

  it("returns null for a product field when the entry has no product", () => {
    expect(
      suggestedIdentityValue("DeviceProduct", { vendor: "Zscaler" }),
    ).toBeNull();
  });

  it("returns null for a non-identity field name", () => {
    expect(suggestedIdentityValue("DeviceVersion", identity)).toBeNull();
  });
});

describe("resolveIdentityFields", () => {
  it("resolves from the sample first (CEF headers map the columns)", () => {
    const statuses = resolveIdentityFields(
      "CommonSecurityLog",
      [
        {
          dest: "DeviceVendor",
          action: "keep",
          sampleValue: "Palo Alto Networks",
        },
      ],
      [{ field: "DeviceVendor", value: "Wrong Constant" }],
    );
    expect(statuses[0]).toEqual({
      field: "DeviceVendor",
      status: "sample",
      value: "Palo Alto Networks",
    });
  });

  it("does not count overflow or drop rows as sample-provided", () => {
    const statuses = resolveIdentityFields(
      "CommonSecurityLog",
      [{ dest: "DeviceVendor", action: "overflow" }],
      [],
    );
    expect(statuses[0].status).toBe("missing");
  });

  it("falls back to the enrichment constant, then missing", () => {
    const statuses = resolveIdentityFields(
      "CommonSecurityLog",
      [],
      [{ field: "DeviceVendor", value: "Fortinet" }],
    );
    expect(statuses[0]).toEqual({
      field: "DeviceVendor",
      status: "enrichment",
      value: "Fortinet",
    });
    expect(statuses[1]).toEqual({ field: "DeviceProduct", status: "missing" });
  });

  it("resolves to an empty list for tables with no required fields", () => {
    expect(resolveIdentityFields("Syslog", [], [])).toEqual([]);
  });
});

describe("missingIdentityFields / identityGateMessage", () => {
  it("lists only the unresolved fields", () => {
    expect(
      missingIdentityFields(
        "CommonSecurityLog",
        [],
        [{ field: "DeviceVendor", value: "Fortinet" }],
      ),
    ).toEqual(["DeviceProduct"]);
  });

  it("builds one gate message, merging same-table entries", () => {
    const message = identityGateMessage([
      { tableName: "CommonSecurityLog", missing: ["DeviceVendor"] },
      {
        tableName: "CommonSecurityLog",
        missing: ["DeviceVendor", "DeviceProduct"],
      },
    ]);
    expect(message).toBe(
      "Add the required vendor identity fields in the Gap Analysis section: " +
        "CommonSecurityLog needs DeviceVendor, DeviceProduct.",
    );
  });

  it("returns null when nothing is missing", () => {
    expect(identityGateMessage([])).toBeNull();
    expect(
      identityGateMessage([{ tableName: "CommonSecurityLog", missing: [] }]),
    ).toBeNull();
  });
});
