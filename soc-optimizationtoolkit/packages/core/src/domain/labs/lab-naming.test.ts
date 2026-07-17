import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_EVENT_HUBS,
  DEFAULT_LAB_NAMING,
  DEFAULT_LAB_SUBNETS,
  allLabResourceNames,
  applyLabLocationSuffixes,
  labAdxClusterName,
  labResourceGroupName,
  labResourceName,
  labStorageAccountName,
  labSubscriptionHash,
} from "./lab-naming";

describe("applyLabLocationSuffixes", () => {
  it("fills empty suffixes with -{location} for location-suffixed types", () => {
    const applied = applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus");
    expect(applied.vnet.suffix).toBe("-eastus");
    expect(applied.nsg.suffix).toBe("-eastus");
    expect(applied.logAnalyticsWorkspace.suffix).toBe("-eastus");
    expect(applied.eventHubNamespace.suffix).toBe("-eastus");
  });

  it("gives the ADX cluster the location WITHOUT a hyphen", () => {
    const applied = applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "westus2");
    expect(applied.adxCluster.suffix).toBe("westus2");
  });

  it("replaces a location-derived suffix when the location changes", () => {
    const first = applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus");
    const second = applyLabLocationSuffixes(first, "uksouth");
    expect(second.vnet.suffix).toBe("-uksouth");
    expect(second.adxCluster.suffix).toBe("uksouth");
  });

  it("preserves custom suffixes (legacy rule)", () => {
    const custom = {
      ...DEFAULT_LAB_NAMING,
      vnet: { prefix: "vnet-", suffix: "-prod" },
      adxCluster: { prefix: "adx", suffix: "dev" },
    };
    const applied = applyLabLocationSuffixes(custom, "eastus");
    expect(applied.vnet.suffix).toBe("-prod");
    expect(applied.adxCluster.suffix).toBe("dev");
  });

  it("never auto-updates the storage account suffix", () => {
    const applied = applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus");
    expect(applied.storageAccount.suffix).toBe("cribl");
  });

  it("does not mutate its input", () => {
    const input = { ...DEFAULT_LAB_NAMING, vnet: { prefix: "vnet-", suffix: "" } };
    applyLabLocationSuffixes(input, "eastus");
    expect(input.vnet.suffix).toBe("");
  });
});

describe("labResourceName", () => {
  const naming = applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus");

  it("composes prefix + base + suffix", () => {
    expect(labResourceName(naming, "vnet", "cribllab")).toBe("vnet-cribllab-eastus");
  });

  it("inserts the mid suffix with a hyphen (legacy Get-ResourceName)", () => {
    expect(labResourceName(naming, "nsg", "cribllab", "SecuritySubnet")).toBe(
      "nsg-cribllab-SecuritySubnet-eastus",
    );
    expect(labResourceName(naming, "publicIp", "cribllab", "vpn")).toBe(
      "pip-cribllab-vpn-eastus",
    );
  });
});

describe("labStorageAccountName", () => {
  it("lowercases, strips non-alphanumerics, keeps prefix and custom suffix", () => {
    expect(labStorageAccountName(DEFAULT_LAB_NAMING, "Crib-Lab")).toBe(
      "sacriblabcribl",
    );
  });

  it("truncates to 24 characters", () => {
    const name = labStorageAccountName(
      DEFAULT_LAB_NAMING,
      "averyverylongbaseobjectname",
    );
    expect(name).toHaveLength(24);
    expect(name.startsWith("sa")).toBe(true);
  });
});

describe("labAdxClusterName", () => {
  const naming = applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus");
  const sub = "11111111-2222-3333-4444-555555555555";

  it("is deterministic for the same subscription", () => {
    expect(labSubscriptionHash(sub)).toBe(labSubscriptionHash(sub));
    expect(labAdxClusterName(naming, "lab", sub)).toBe(
      labAdxClusterName(naming, "lab", sub),
    );
  });

  it("differs across subscriptions (global-uniqueness hash)", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    expect(labSubscriptionHash(sub)).not.toBe(labSubscriptionHash(other));
  });

  it("is lowercase alphanumeric, 4-22 chars", () => {
    const name = labAdxClusterName(naming, "My-Long-Base-Object-Name", sub);
    expect(name).toMatch(/^[a-z0-9]+$/);
    expect(name.length).toBeLessThanOrEqual(22);
    expect(name.length).toBeGreaterThanOrEqual(4);
  });

  it("never yields fewer than 4 characters (the hash contributes 4; the legacy 'cluster' pad backstops)", () => {
    const bare = { ...naming, adxCluster: { prefix: "", suffix: "" } };
    const name = labAdxClusterName(bare, "", "");
    expect(name.length).toBeGreaterThanOrEqual(4);
    expect(name).toMatch(/^[a-z0-9]+$/);
  });
});

describe("allLabResourceNames", () => {
  const names = allLabResourceNames({
    naming: applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus"),
    baseObjectName: "cribllab",
    subscriptionId: "11111111-2222-3333-4444-555555555555",
    subnets: DEFAULT_LAB_SUBNETS,
    eventHubs: DEFAULT_LAB_EVENT_HUBS,
  });

  it("names the core resources through the single engine", () => {
    expect(names.vnet).toBe("vnet-cribllab-eastus");
    expect(names.vpnGateway).toBe("vpngw-cribllab-eastus");
    expect(names.vpnPublicIp).toBe("pip-cribllab-vpn-eastus");
    expect(names.logAnalytics).toBe("law-cribllab-eastus");
    expect(names.networkWatcher).toBe("nw-cribllab-eastus");
    expect(names.eventHubNamespace).toBe("evhns-cribllab-eastus");
    expect(names.storageAccount).toBe("sacribllabcribl");
  });

  it("skips the GatewaySubnet NSG (legacy rule) and names the rest", () => {
    expect(names.nsgBySubnet["gateway"]).toBeUndefined();
    expect(names.nsgBySubnet["security"]).toBe("nsg-cribllab-SecuritySubnet-eastus");
    expect(names.nsgBySubnet["o11y"]).toBe("nsg-cribllab-O11ySubnet-eastus");
    expect(names.nsgBySubnet["privatelink"]).toBe(
      "nsg-cribllab-PrivateLinkSubnet-eastus",
    );
  });

  it("carries Event Hub names verbatim from the definitions", () => {
    expect(names.eventHubs).toEqual(["logs-hub", "metrics-hub", "events-hub"]);
  });
});

describe("labResourceGroupName", () => {
  it("joins prefix and suffix with a hyphen", () => {
    expect(labResourceGroupName("rg-lab", "SentinelLab")).toBe("rg-lab-SentinelLab");
  });

  it("returns the prefix alone for a blank suffix (legacy rule)", () => {
    expect(labResourceGroupName("rg-lab", "")).toBe("rg-lab");
    expect(labResourceGroupName("rg-lab", "  ")).toBe("rg-lab");
  });
});
