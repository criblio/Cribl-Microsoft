/**
 * THE 4-format connector decoder, consolidated to ONE decode with THREE
 * projections (porting-plan Unit 14; ENG-23 full, ENG-24 VendorLogType seam,
 * ENG-26 fingerprint seam).
 *
 * The legacy scattered near-identical connector-parsing across three modules -
 * github.ts extractSchemasFromConnector (full schema), vendor-research.ts
 * parseSentinelConnector (VendorLogType), change-detection.ts extraction +
 * hashFields (fingerprint) - each re-implementing the same four-format cascade
 * with its own drift. This unifies to ONE `decodeConnector` producing a
 * canonical {@link DecodedConnector}, then three pure projections over it.
 *
 * The four connector formats (cascade order pinned from github.ts 140-224):
 *   1. tables[]  with columns[]              (name/type OR columnName/columnType)
 *   2. resources[].properties.streamDeclarations (stream name -> columns;
 *      tableName is the stream name with a leading "Custom-" stripped)
 *   3. dataTypes[]                            (name only; runs ONLY if 1+2 empty)
 *   4. properties.connectorUiConfig.dataTypes[] (name only; ONLY if still empty)
 *
 * All column types are normalized through normalizeDcrType at decode time, so
 * every projection speaks the DCR vocabulary.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { normalizeDcrType } from "./dcr-type";
import type {
  DataConnectorSchema,
  DecodedColumn,
  DecodedConnector,
  DecodedTable,
  SchemaColumn,
  SchemaFingerprint,
  VendorLogType,
} from "./models";

// ---------------------------------------------------------------------------
// Tiny JSON navigation helpers (the parsed connector is untyped)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Sanitize a name to an id: every non `[A-Za-z0-9_]` run -> "_" (legacy rule). */
export function sanitizeLogTypeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// The ONE decode
// ---------------------------------------------------------------------------

/**
 * Decode a parsed connector JSON object into the canonical
 * {@link DecodedConnector}. `sourceFile` is carried through for provenance.
 * Never throws for shape surprises - unrecognized inputs yield an empty
 * `tables` list.
 */
export function decodeConnector(
  json: unknown,
  sourceFile: string,
): DecodedConnector {
  const root = asRecord(json) ?? {};
  const connectorName =
    asString(root["title"]) || asString(root["name"]) || "Unknown";
  const tables: DecodedTable[] = [];

  // Format 1: tables[] with explicit columns (name/type OR columnName/columnType)
  if (Array.isArray(root["tables"])) {
    for (const table of root["tables"]) {
      const t = asRecord(table);
      if (!t) continue;
      const name = asString(t["name"]);
      if (!name || !Array.isArray(t["columns"])) continue;
      tables.push({
        tableName: name,
        description: typeof t["description"] === "string"
          ? (t["description"] as string)
          : undefined,
        columns: mapFormat1Columns(t["columns"]),
      });
    }
  }

  // Format 2: ARM resources[] with properties.streamDeclarations
  if (Array.isArray(root["resources"])) {
    for (const resource of root["resources"]) {
      const r = asRecord(resource);
      const props = r ? asRecord(r["properties"]) : null;
      const streams = props ? asRecord(props["streamDeclarations"]) : null;
      if (!streams) continue;
      for (const [streamName, streamDef] of Object.entries(streams)) {
        const def = asRecord(streamDef);
        if (!def || !Array.isArray(def["columns"])) continue;
        tables.push({
          // "Custom-" prefix stripped (github.ts line 173).
          tableName: streamName.replace(/^Custom-/, ""),
          columns: mapFormat2Columns(def["columns"]),
        });
      }
    }
  }

  // Format 3: dataTypes[] - name-only. ONLY when Formats 1+2 produced nothing.
  if (tables.length === 0 && Array.isArray(root["dataTypes"])) {
    for (const dt of root["dataTypes"]) {
      const name = asString(asRecord(dt)?.["name"]);
      if (name) tables.push({ tableName: name, columns: [] });
    }
  }

  // Format 4: properties.connectorUiConfig.dataTypes[] - name-only.
  // ONLY when nothing matched above.
  if (tables.length === 0) {
    const props = asRecord(root["properties"]);
    const uiConfig = props ? asRecord(props["connectorUiConfig"]) : null;
    if (uiConfig && Array.isArray(uiConfig["dataTypes"])) {
      for (const dt of uiConfig["dataTypes"]) {
        const name = asString(asRecord(dt)?.["name"]);
        if (name) tables.push({ tableName: name, columns: [] });
      }
    }
  }

  return { connectorName, sourceFile, tables };
}

/**
 * Format 1 columns: accept BOTH the name/type and columnName/columnType key
 * variants, keep descriptions, drop nameless columns (github.ts 152-158).
 */
function mapFormat1Columns(raw: readonly unknown[]): DecodedColumn[] {
  const out: DecodedColumn[] = [];
  for (const col of raw) {
    const c = asRecord(col);
    if (!c) continue;
    const name = asString(c["name"]) || asString(c["columnName"]);
    if (!name) continue;
    out.push({
      name,
      type: normalizeDcrType(asString(c["type"]) || asString(c["columnType"])),
      description: asString(c["description"]),
    });
  }
  return out;
}

/** Format 2 stream columns: name/type only, drop nameless (github.ts 177-181). */
function mapFormat2Columns(raw: readonly unknown[]): DecodedColumn[] {
  const out: DecodedColumn[] = [];
  for (const col of raw) {
    const c = asRecord(col);
    if (!c) continue;
    const name = asString(c["name"]);
    if (!name) continue;
    out.push({ name, type: normalizeDcrType(asString(c["type"])), description: "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projection 1: full schema (ENG-23) - github.ts DataConnectorSchema[]
// ---------------------------------------------------------------------------

/** Project a decoded connector to the full schema list (one per table). */
export function toFullSchemas(decoded: DecodedConnector): DataConnectorSchema[] {
  return decoded.tables.map((table) => ({
    connectorName: decoded.connectorName,
    tableName: table.tableName,
    columns: table.columns.map(
      (c): SchemaColumn => ({ name: c.name, type: c.type, description: c.description }),
    ),
    sourceFile: decoded.sourceFile,
  }));
}

// ---------------------------------------------------------------------------
// Projection 2: VendorLogType (ENG-24 seam) - vendor-research.ts shape
// ---------------------------------------------------------------------------

/** Project a decoded connector to VendorLogType[] (the Unit 15 seam). */
export function toVendorLogTypes(decoded: DecodedConnector): VendorLogType[] {
  return decoded.tables.map((table) => ({
    id: sanitizeLogTypeId(table.tableName),
    name: table.tableName,
    description: table.description || `${table.tableName} table`,
    fields: table.columns.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      required: false,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Projection 3: fingerprint (ENG-26 seam) - change-detection.ts shape
// ---------------------------------------------------------------------------

/**
 * The canonical PRE-HASH string for a column set: fields sorted by name
 * (localeCompare), each rendered `name:type`, joined by "|" - byte-identical to
 * the input the legacy `hashFields` fed to sha256. Core stays crypto-free; the
 * shell / Unit 25 hashes this deterministic string.
 */
export function canonicalFieldString(
  columns: readonly { name: string; type: string }[],
): string {
  return [...columns]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${c.name}:${c.type}`)
    .join("|");
}

/** Project a decoded connector to per-table fingerprints (the Unit 25 seam). */
export function toFingerprints(decoded: DecodedConnector): SchemaFingerprint[] {
  return decoded.tables.map((table) => ({
    logTypeId: sanitizeLogTypeId(table.tableName),
    logTypeName: table.tableName,
    fieldCount: table.columns.length,
    canonical: canonicalFieldString(table.columns),
  }));
}
