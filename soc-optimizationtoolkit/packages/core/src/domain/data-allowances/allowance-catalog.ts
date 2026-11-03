/**
 * Data allowance catalog (MIG-11): which Log Analytics / Sentinel tables a
 * Microsoft data grant covers, so the Data Volume Inventory can separate the
 * volume that is billed from the volume an allowance already pays for.
 *
 * The mapping is DATA, dated, with each row's source URL. A Microsoft revision
 * is a one-file change with a visible date. A table missing from the mapping
 * is billable, never a guess. Pure: no IO, no React.
 */

import { bundledCatalogTableNames } from "../field-matcher/bundled-schema-catalog";

export type GrantId = "e5" | "servers-p2";

export type AllowanceTag =
  | { kind: "free" }
  | { kind: "grant"; grant: GrantId; condition: string | null }
  | { kind: "billable" };

/** Microsoft documentation as read on this date. */
export const ALLOWANCE_CATALOG_AS_OF = "2026-11-03";
/**
 * The qualifying-SKU GUIDs below come from Microsoft's "Product names and
 * service plan identifiers for licensing" CSV, which stated it was last
 * updated 2026-08-19 (page read 2026-11-03).
 */
export const LICENSING_CSV_AS_OF = "2026-08-19";

export const E5_MB_PER_SEAT_PER_DAY = 5;
export const SERVERS_MB_PER_MACHINE_PER_DAY = 500;

export const ALLOWANCE_SOURCES: Record<
  "free" | GrantId,
  { url: string; title: string }
> = {
  free: {
    url: "https://learn.microsoft.com/en-us/azure/sentinel/billing",
    title: "Sentinel billing - Free data sources",
  },
  e5: {
    url: "https://azure.microsoft.com/en-us/pricing/offers/sentinel-microsoft-365-offer",
    title: "Sentinel benefit for M365 E7/E5/A5/F5/G5",
  },
  "servers-p2": {
    url: "https://learn.microsoft.com/en-us/azure/defender-for-cloud/data-ingestion-benefit",
    title: "Defender for Cloud data ingestion benefit",
  },
};

const FREE_TABLES: readonly string[] = [
  "AzureActivity",
  "SentinelHealth",
  "OfficeActivity",
  "SecurityIncident",
  "SecurityAlert",
];

const E5_TABLES: readonly string[] = [
  "SigninLogs",
  "AuditLogs",
  "AADNonInteractiveUserSignInLogs",
  "AADServicePrincipalSignInLogs",
  "AADManagedIdentitySignInLogs",
  "AADProvisioningLogs",
  "ADFSSignInLogs",
  "McasShadowItReporting",
  "InformationProtectionLogs_CL",
  "DeviceEvents",
  "DeviceFileEvents",
  "DeviceImageLoadEvents",
  "DeviceInfo",
  "DeviceLogonEvents",
  "DeviceNetworkEvents",
  "DeviceNetworkInfo",
  "DeviceProcessEvents",
  "DeviceRegistryEvents",
  "DeviceFileCertificateInfo",
  "DynamicEventCollection",
  "CloudAppEvents",
  "EmailAttachmentInfo",
  "EmailEvents",
  "EmailPostDeliveryEvents",
  "EmailUrlInfo",
  "IdentityLogonEvents",
  "IdentityQueryEvents",
  "IdentityDirectoryEvents",
  "AlertEvidence",
];

/** Includes SecurityAlert, which allowanceFor still tags Free (Free wins). */
const SERVERS_P2_TABLES: readonly string[] = [
  "SecurityAlert",
  "SecurityBaseline",
  "SecurityBaselineSummary",
  "SecurityDetection",
  "SecurityEvent",
  "WindowsFirewall",
  "ProtectionStatus",
  "Update",
  "UpdateSummary",
  "MDCFileIntegrityMonitoringEvents",
  "WindowsEvent",
  "DeviceCustomFileEvents",
  "DeviceCustomRegistryEvents",
];

const UPDATE_CONDITION =
  "Only when Update Management is not running or solution targeting is on";

const SERVERS_P2_CONDITIONS: Readonly<Record<string, string>> = {
  update: UPDATE_CONDITION,
  updatesummary: UPDATE_CONDITION,
  windowsevent: "Only the Microsoft-SecurityEvent stream",
};

const FREE_SET = new Set(FREE_TABLES.map((t) => t.toLowerCase()));
const E5_SET = new Set(E5_TABLES.map((t) => t.toLowerCase()));
const SERVERS_SET = new Set(SERVERS_P2_TABLES.map((t) => t.toLowerCase()));

export function allowanceFor(table: string): AllowanceTag {
  const key = table.toLowerCase();
  if (FREE_SET.has(key)) return { kind: "free" };
  if (E5_SET.has(key)) return { kind: "grant", grant: "e5", condition: null };
  if (SERVERS_SET.has(key)) {
    return {
      kind: "grant",
      grant: "servers-p2",
      condition: SERVERS_P2_CONDITIONS[key] ?? null,
    };
  }
  return { kind: "billable" };
}

export function eligibleTables(grant: GrantId): readonly string[] {
  return grant === "e5" ? E5_TABLES : SERVERS_P2_TABLES;
}

export interface QualifyingSku {
  skuId: string;
  skuPartNumber: string;
  family: "E7" | "E5" | "E5 Security" | "A5" | "F5" | "G5";
}

/**
 * Subscribed SKUs that earn the E5 grant: every SKU the offer FAQ names whose
 * display name appears VERBATIM in the licensing CSV (LICENSING_CSV_AS_OF).
 * skuId and skuPartNumber are copied from that CSV, never typed. FAQ names
 * with no CSV row (mostly Teams-less / HUB / Gov variants) are absent here.
 */
export const E5_QUALIFYING_SKUS: readonly QualifyingSku[] = [
  { skuId: "e97c048c-37a4-45fb-ab50-922fbf07a370", skuPartNumber: "M365EDU_A5_FACULTY", family: "A5" }, // Microsoft 365 A5 for faculty
  { skuId: "46c119d4-0379-4a9d-85e4-97c66d3f909e", skuPartNumber: "M365EDU_A5_STUDENT", family: "A5" }, // Microsoft 365 A5 for Students
  { skuId: "9b8fe788-6174-4c4e-983b-3330c93ec278", skuPartNumber: "M365_A5_SUITE_COMPONENTS_FACULTY", family: "A5" }, // Microsoft 365 A5 Suite features for faculty
  { skuId: "06ebc4ee-1bb5-47dd-8120-11324bc54e06", skuPartNumber: "SPE_E5", family: "E5" }, // Microsoft 365 E5
  { skuId: "26124093-3d78-432b-b5dc-48bf992543d5", skuPartNumber: "IDENTITY_THREAT_PROTECTION", family: "E5 Security" }, // Microsoft 365 E5 Security
  { skuId: "18a4bd3f-0b5b-4887-b04f-61dd0ee15f5e", skuPartNumber: "Microsoft_365_E5_(no_Teams)", family: "E5" }, // Microsoft 365 E5 (no Teams)
  { skuId: "3271cf8e-2be5-4a09-a549-70fd05baaa17", skuPartNumber: "O365_w/o_Teams_Bundle_M5", family: "E5" }, // Microsoft 365 E5 EEA (no Teams)
  { skuId: "44ac31e7-2999-4304-ad94-c948886741d4", skuPartNumber: "IDENTITY_THREAT_PROTECTION_FOR_EMS_E5", family: "E5 Security" }, // Microsoft 365 E5 Security for EMS E5
  { skuId: "4eb45c5b-0d19-4e33-b87c-adfc25268f20", skuPartNumber: "SPE_E5_USGOV_GCCHIGH", family: "E5" }, // Microsoft 365 E5_USGOV_GCCHIGH
  { skuId: "99cc8282-2f74-4954-83b7-c6a9a1999067", skuPartNumber: "M365_E5_SUITE_COMPONENTS", family: "E5" }, // Microsoft 365 E5 Suite features
  { skuId: "a91fc4e0-65e5-4266-aa76-4037509c1626", skuPartNumber: "SPE_E5_CALLINGMINUTES", family: "E5" }, // Microsoft 365 E5 with Calling Minutes
  { skuId: "cd2925a3-5076-4233-8931-638a8c94f773", skuPartNumber: "SPE_E5_NOPSTNCONF", family: "E5" }, // Microsoft 365 E5 without Audio Conferencing
  { skuId: "c42b9cae-ea4f-4ab7-9717-81576235ccac", skuPartNumber: "DEVELOPERPACK_E5", family: "E5" }, // Microsoft 365 E5 Developer (without Windows and Audio Conferencing)
  { skuId: "db684ac5-c0e7-4f92-8284-ef9ebde75d33", skuPartNumber: "Microsoft_365_E5", family: "E5" }, // Microsoft 365 E5 (500 seats min)_HUB
  { skuId: "6ee4114a-9b2d-4577-9e7a-49fa43d222d3", skuPartNumber: "Microsoft_365_E5_EEA_(no_Teams)_with_Calling_Minutes", family: "E5" }, // Microsoft 365 E5 EEA (no Teams) with Calling Minutes
  { skuId: "90277bc7-a6fe-4181-99d8-712b08b8d32b", skuPartNumber: "Microsoft_365_E5_EEA_(no_Teams)_without_Audio_Conferencing", family: "E5" }, // Microsoft 365 E5 EEA (no Teams) without Audio Conferencing
  { skuId: "a640eead-25f6-4bec-97e3-23cfd382d7c2", skuPartNumber: "Microsoft_365_E5_EEA_(no_Teams)_without_Audio_Conferencing_(500_seats_min)_HUB", family: "E5" }, // Microsoft 365 E5 EEA (no Teams) without Audio Conferencing (500 seats min)_HUB
  { skuId: "2113661c-6509-4034-98bb-9c47bd28d63c", skuPartNumber: "Microsoft_365_E5_without_Audio_Conferencing", family: "E5" }, // Microsoft 365 E5 without Audio Conferencing (500 seats min)_HUB
  { skuId: "1e988bf3-8b7c-4731-bec0-4e2a2946600c", skuPartNumber: "O365_w/o_Teams_Bundle_M5_(500_seats_min)_HUB", family: "E5" }, // Microsoft 365 E5 EEA (no Teams) (500 seats min)_HUB
  { skuId: "9a18296a-025f-4e37-9ffa-30bf8d1ce775", skuPartNumber: "MICROSOFT_365_E7", family: "E7" }, // Microsoft 365 E7
  { skuId: "32b47245-eb31-44fc-b945-a8b1576c439f", skuPartNumber: "SPE_F5_SECCOMP", family: "F5" }, // Microsoft 365 F5 Security + Compliance Add-on
  { skuId: "67ffe999-d9ca-49e1-9d2c-03fb28aa7a48", skuPartNumber: "SPE_F5_SEC", family: "F5" }, // Microsoft 365 F5 Security Add-on
  { skuId: "e2be619b-b125-455f-8660-fb503e431a5d", skuPartNumber: "M365_G5_GCC", family: "G5" }, // Microsoft 365 GCC G5
  { skuId: "b0f809d5-a662-4391-a5aa-136e9c565b9d", skuPartNumber: "M365_G5_GOV", family: "G5" }, // Microsoft 365 GCC G5 w/o WDATP/CAS Unified
];

/**
 * Tables fed only by Microsoft's own connectors (Entra, Defender XDR, MDCA):
 * Cribl cannot write into them. Same set as the E5 list minus the one custom
 * table (InformationProtectionLogs_CL).
 */
const NOT_CRIBL_WRITABLE: ReadonlySet<string> = new Set(
  E5_TABLES.filter((t) => t !== "InformationProtectionLogs_CL").map((t) =>
    t.toLowerCase(),
  ),
);

let writableNative: ReadonlySet<string> | null = null;

/**
 * Can Cribl write this table? "no" for the Microsoft-connector-only tables;
 * "yes" when the table is in the bundled native-table catalog that a DCR /
 * Logs Ingestion API can target; otherwise "unknown".
 */
export function criblWritable(table: string): "yes" | "no" | "unknown" {
  const key = table.toLowerCase();
  if (NOT_CRIBL_WRITABLE.has(key)) return "no";
  writableNative ??= new Set(
    bundledCatalogTableNames().map((t) => t.toLowerCase()),
  );
  return writableNative.has(key) ? "yes" : "unknown";
}
