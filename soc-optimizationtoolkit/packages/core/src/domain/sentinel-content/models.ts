/**
 * Shared domain models for the sentinel-content module (porting-plan Unit 14).
 * Pure data shapes only - no IO, no fetch, no React, no Date/crypto.
 */

// ---------------------------------------------------------------------------
// Canonical decoded connector (the ONE parse behind all three projections)
// ---------------------------------------------------------------------------

/** A single decoded column: name + DCR-vocabulary type + optional description. */
export interface DecodedColumn {
  name: string;
  /** Already run through normalizeDcrType at decode time. */
  type: string;
  description: string;
}

/** One table/stream decoded out of a connector. */
export interface DecodedTable {
  /** Table name (stream `Custom-` prefix already stripped for Format 2). */
  tableName: string;
  /**
   * Table-level description, carried only from Format 1's `tables[].description`
   * (undefined for streams and name-only dataTypes). The VendorLogType
   * projection uses it, falling back to "<name> table".
   */
  description?: string;
  /** Columns; EMPTY for the name-only Formats 3 and 4 (dataTypes). */
  columns: DecodedColumn[];
}

/**
 * The canonical intermediate a connector decodes to, ONCE. The three
 * projections (full / VendorLogType / fingerprint) are pure functions over
 * this - the legacy scattered the decode logic across github.ts, vendor-
 * research.ts and change-detection.ts; here it is unified.
 */
export interface DecodedConnector {
  /** From `title` || `name` || "Unknown" (legacy connectorName rule). */
  connectorName: string;
  /** The source file name the connector was read from. */
  sourceFile: string;
  /** The decoded tables, in decode order. */
  tables: DecodedTable[];
}

// ---------------------------------------------------------------------------
// Projection 1: full schema (ENG-23) - github.ts DataConnectorSchema
// ---------------------------------------------------------------------------

/** A destination column in the full projection. */
export interface SchemaColumn {
  name: string;
  type: string;
  description?: string;
}

/** The full projection: one entry per decoded table (github.ts shape). */
export interface DataConnectorSchema {
  connectorName: string;
  tableName: string;
  columns: SchemaColumn[];
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Projection 2: VendorLogType (ENG-24 seam) - vendor-research.ts shape
// ---------------------------------------------------------------------------

/** A field in the VendorLogType projection (Unit 15 consumes this seam). */
export interface VendorLogTypeField {
  name: string;
  type: string;
  description: string;
  /** Always false out of the connector decoder (legacy set required:false). */
  required: boolean;
}

/** The VendorLogType projection: one entry per decoded table. */
export interface VendorLogType {
  /** `name` sanitized to an id: every non [A-Za-z0-9_] run becomes "_". */
  id: string;
  name: string;
  description: string;
  fields: VendorLogTypeField[];
}

// ---------------------------------------------------------------------------
// Projection 3: fingerprint (ENG-26 seam) - change-detection.ts shape
// ---------------------------------------------------------------------------

/**
 * The fingerprint projection: one entry per decoded table. `canonical` is the
 * PRE-HASH canonical string the legacy `hashFields` built - fields sorted by
 * name, each rendered `name:type`, joined by "|". Core is crypto-free by
 * construction, so it emits the canonical string and the shell / Unit 25
 * applies sha256 (a pure function of this string, so the fingerprint is stable
 * and comparable without core ever hashing).
 */
export interface SchemaFingerprint {
  logTypeId: string;
  logTypeName: string;
  fieldCount: number;
  /** Sorted `name:type` pairs joined by "|"; "" for a columnless table. */
  canonical: string;
}
