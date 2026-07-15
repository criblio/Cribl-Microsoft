/**
 * Ingestion classification (2026-07-15): decide, per Sentinel solution, how
 * well it fits Cribl delivery through the Azure Logs Ingestion API (DCR-based
 * ingest). Drives a Recommended / Supported / Legacy tag on the solution
 * browser so a user can pick a solution Cribl can feed cleanly.
 *
 * The tiers (from the CCF/Logs-Ingestion research, docs cited in
 * reference_ccf_cribl_ingestion):
 *   - recommended: a CCF **Push** connector - the Logs Ingestion API is its
 *     NATIVE ingress (it provisions the DCE/DCR/stream/Entra app for exactly
 *     this). Cribl is a drop-in shipper.
 *   - supported:   a CCF **pull** connector (RestApiPoller/WebSocket/GCP/AWS
 *     S3/Blob) OR any connector that declares a custom table / DCR stream.
 *     Sentinel normally pulls, but the destination is an ordinary table, so
 *     Cribl can push into it via a DCR and the solution's content (parsers,
 *     rules, workbooks - all KQL over the table) works.
 *   - legacy:      agent-, Azure-Functions-, or name-only connectors with no
 *     DCR/table declaration - not a native Logs Ingestion target.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. Operates on parsed
 * connector JSON (the same files the decoder reads).
 */

/** How well a solution fits Cribl delivery via the Logs Ingestion API. */
export type IngestionTier = "recommended" | "supported" | "legacy";

/** A single connector's (or a solution's) ingestion classification. */
export interface IngestionClass {
  tier: IngestionTier;
  /** The detected CCF connector kind (e.g. "Push", "RestApiPoller"); "" if none. */
  kind: string;
  /** One-line rationale for the tier (shown in a tooltip). */
  reason: string;
}

/** CCF kinds whose ingress IS the Azure Logs Ingestion API (push-based). */
export const CCF_PUSH_KINDS: readonly string[] = ["Push"];

/**
 * CCF PULL kinds - Sentinel-initiated, but each declares a DCR + table Cribl
 * can feed via the Logs Ingestion API instead of the native poll.
 */
export const CCF_PULL_KINDS: readonly string[] = [
  "RestApiPoller",
  "WebSocket",
  "GCP",
  "AmazonWebServicesS3",
  "StorageAccountBlobContainer",
];

const TIER_RANK: Record<IngestionTier, number> = {
  recommended: 3,
  supported: 2,
  legacy: 1,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function eqKind(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Walk every object node in a parsed connector JSON (arrays AND objects, at
 * any nesting; depth-capped). Connector files come in several root shapes -
 * a bare object (Push), an ARRAY of ARM resources (PollingConfig), or a
 * template with `resources[]` - so a generic tree walk is the only robust way
 * to find the signals wherever they sit.
 */
function walkRecords(value: unknown, visit: (rec: Record<string, unknown>) => void): void {
  const go = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(v)) {
      for (const item of v) go(item, depth + 1);
      return;
    }
    const rec = asRecord(v);
    if (rec === null) return;
    visit(rec);
    for (const child of Object.values(rec)) go(child, depth + 1);
  };
  go(value, 0);
}

/**
 * Every connector `kind` found in a parsed connector JSON: the `kind` on any
 * Microsoft.SecurityInsights/dataConnectors(Definitions) resource, plus a
 * top-level or `properties` kind. CCF connectors put the kind on the ARM
 * dataConnectors resource (the file may be that resource, or an array of them).
 */
export function detectConnectorKinds(json: unknown): string[] {
  const kinds: string[] = [];
  const add = (k: string) => {
    if (k !== "" && !kinds.some((existing) => eqKind(existing, k))) kinds.push(k);
  };
  walkRecords(json, (rec) => {
    const kind = asString(rec["kind"]);
    if (kind === "") return;
    const type = asString(rec["type"]).toLowerCase();
    // Authoritative: a kind on a dataConnector(Definition) resource. Also
    // accept a kind that sits beside `properties` (bare connector objects).
    if (type.includes("dataconnector") || rec["properties"] !== undefined) add(kind);
  });
  return kinds;
}

/** True when the connector declares a DCR input stream (streamDeclarations). */
function hasStreamDeclarations(json: unknown): boolean {
  let found = false;
  walkRecords(json, (rec) => {
    const props = asRecord(rec["properties"]);
    if (props !== null && asRecord(props["streamDeclarations"]) !== null) found = true;
  });
  return found;
}

/** True when a CCF dcrConfig (streamName + DCR immutable id) is present. */
function hasDcrConfig(json: unknown): boolean {
  let found = false;
  walkRecords(json, (rec) => {
    const dcr = asRecord(rec["dcrConfig"]);
    if (dcr !== null && asString(dcr["streamName"]) !== "") found = true;
  });
  return found;
}

/** True when the connector declares a table WITH a column schema (Format 1). */
function hasTableSchema(json: unknown): boolean {
  let found = false;
  walkRecords(json, (rec) => {
    if (!Array.isArray(rec["tables"])) return;
    for (const t of rec["tables"]) {
      const cols = asRecord(t)?.["columns"];
      if (Array.isArray(cols) && cols.length > 0) found = true;
    }
  });
  return found;
}

/**
 * Classify ONE parsed connector JSON. Push wins outright; then a known CCF
 * pull kind; then any custom-table/DCR declaration; otherwise legacy.
 */
export function classifyConnectorIngestion(json: unknown): IngestionClass {
  const kinds = detectConnectorKinds(json);
  const push = kinds.find((k) => CCF_PUSH_KINDS.some((p) => eqKind(k, p)));
  if (push !== undefined) {
    return {
      tier: "recommended",
      kind: push,
      reason:
        "CCF Push connector - the Azure Logs Ingestion API is its native " +
        "ingress; Cribl is a drop-in shipper.",
    };
  }
  const pull = kinds.find((k) => CCF_PULL_KINDS.some((p) => eqKind(k, p)));
  if (pull !== undefined) {
    return {
      tier: "supported",
      kind: pull,
      reason:
        `CCF ${pull} connector - Cribl can deliver into its table via the ` +
        "Logs Ingestion API (leave the native poller off to avoid duplicates).",
    };
  }
  if (hasStreamDeclarations(json) || hasDcrConfig(json) || hasTableSchema(json)) {
    return {
      tier: "supported",
      kind: kinds[0] ?? "",
      reason:
        "Declares a custom table / DCR stream - Cribl can push into it via " +
        "the Logs Ingestion API.",
    };
  }
  return {
    tier: "legacy",
    kind: kinds[0] ?? "",
    reason:
      "Agent, Azure Functions, or name-only connector - not a native Logs " +
      "Ingestion API target.",
  };
}

/**
 * Aggregate a solution's per-connector classifications to ONE tier: the best
 * fit any of its connectors offers (recommended > supported > legacy). An
 * empty list (a content-only solution with no connector) is legacy - there is
 * no table to feed.
 */
export function classifySolutionIngestion(
  classes: readonly IngestionClass[],
): IngestionClass {
  if (classes.length === 0) {
    return {
      tier: "legacy",
      kind: "",
      reason: "No data connector declares a Logs Ingestion API target.",
    };
  }
  return [...classes].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
}

/** The short badge label for a tier (UI). */
export function ingestionTierLabel(tier: IngestionTier): string {
  switch (tier) {
    case "recommended":
      return "Recommended";
    case "supported":
      return "Supported";
    case "legacy":
      return "Legacy";
  }
}
