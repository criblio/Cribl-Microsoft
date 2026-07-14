/**
 * Bundled vendor custom-table schema library - porting-plan Unit 5 (ENG-34).
 *
 * The JSON files are VERBATIM copies of the legacy PS engine's schema files
 * in Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/
 * (the bare {columns: [...]} shape with 30/90 retention). They ship inside
 * the core package (resolveJsonModule, like dcr-naming's legacy-vectors) so
 * the air-gap-capable custom-table path needs no fetch; GitHub-sourced
 * auto-generation is a post-Unit-14 delta.
 *
 * Each registry entry carries the RAW JSON text so consumers exercise the
 * exact same parse path (parseTableSchemaFile) as a user-uploaded file.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import cloudflare from "./CloudFlare_CL.json";
import cloudflareV2 from "./CloudflareV2_CL.json";
import crowdstrikeAdditionalEvents from "./CrowdStrike_Additional_Events_CL.json";
import crowdstrikeAuditEvents from "./CrowdStrike_Audit_Events_CL.json";
import crowdstrikeAuthEvents from "./CrowdStrike_Auth_Events_CL.json";
import crowdstrikeDnsEvents from "./CrowdStrike_DNS_Events_CL.json";
import crowdstrikeFileEvents from "./CrowdStrike_File_Events_CL.json";
import crowdstrikeNetworkEvents from "./CrowdStrike_Network_Events_CL.json";
import crowdstrikeProcessEvents from "./CrowdStrike_Process_Events_CL.json";
import crowdstrikeRegistryEvents from "./CrowdStrike_Registry_Events_CL.json";
import crowdstrikeSecondaryData from "./CrowdStrike_Secondary_Data_CL.json";
import crowdstrikeUserEvents from "./CrowdStrike_User_Events_CL.json";

/** One bundled vendor schema, addressable by a stable id. */
export interface VendorSchemaEntry {
  /** Stable registry id (lowercase kebab), e.g. "crowdstrike-dns-events". */
  id: string;
  /** Human-readable picker label. */
  label: string;
  /** The _CL table the schema creates, e.g. "CrowdStrike_DNS_Events_CL". */
  table: string;
  /** Raw JSON text, byte-equivalent to JSON.stringify of the bundled file. */
  raw: string;
}

function entry(
  id: string,
  label: string,
  table: string,
  parsed: unknown,
): VendorSchemaEntry {
  return { id, label, table, raw: JSON.stringify(parsed) };
}

/** The bundled vendor schema library, in picker order. */
export const VENDOR_SCHEMAS: readonly VendorSchemaEntry[] = Object.freeze([
  entry("cloudflare", "Cloudflare (CDN logs)", "CloudFlare_CL", cloudflare),
  entry(
    "cloudflare-v2",
    "Cloudflare v2 (Logpush)",
    "CloudflareV2_CL",
    cloudflareV2,
  ),
  entry(
    "crowdstrike-additional-events",
    "CrowdStrike Additional Events",
    "CrowdStrike_Additional_Events_CL",
    crowdstrikeAdditionalEvents,
  ),
  entry(
    "crowdstrike-audit-events",
    "CrowdStrike Audit Events",
    "CrowdStrike_Audit_Events_CL",
    crowdstrikeAuditEvents,
  ),
  entry(
    "crowdstrike-auth-events",
    "CrowdStrike Auth Events",
    "CrowdStrike_Auth_Events_CL",
    crowdstrikeAuthEvents,
  ),
  entry(
    "crowdstrike-dns-events",
    "CrowdStrike DNS Events",
    "CrowdStrike_DNS_Events_CL",
    crowdstrikeDnsEvents,
  ),
  entry(
    "crowdstrike-file-events",
    "CrowdStrike File Events",
    "CrowdStrike_File_Events_CL",
    crowdstrikeFileEvents,
  ),
  entry(
    "crowdstrike-network-events",
    "CrowdStrike Network Events",
    "CrowdStrike_Network_Events_CL",
    crowdstrikeNetworkEvents,
  ),
  entry(
    "crowdstrike-process-events",
    "CrowdStrike Process Events",
    "CrowdStrike_Process_Events_CL",
    crowdstrikeProcessEvents,
  ),
  entry(
    "crowdstrike-registry-events",
    "CrowdStrike Registry Events",
    "CrowdStrike_Registry_Events_CL",
    crowdstrikeRegistryEvents,
  ),
  entry(
    "crowdstrike-secondary-data",
    "CrowdStrike Secondary Data",
    "CrowdStrike_Secondary_Data_CL",
    crowdstrikeSecondaryData,
  ),
  entry(
    "crowdstrike-user-events",
    "CrowdStrike User Events",
    "CrowdStrike_User_Events_CL",
    crowdstrikeUserEvents,
  ),
]);

/** Look a bundled vendor schema up by registry id. */
export function findVendorSchema(id: string): VendorSchemaEntry | undefined {
  return VENDOR_SCHEMAS.find((candidate) => candidate.id === id);
}
