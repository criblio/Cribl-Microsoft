/**
 * DEPRECATED GUID COLUMN SUCCESSORS - the per-table CONTENT decided by D-11
 * (reasoning in docs/backlog.md 18g).
 *
 * ADR-0004 declares guid-typed columns as `string` and promotes them with
 * `toguid()` in the DCR transform, which is right for a well-formed UUID and
 * SILENTLY yields null for anything else. AWS CloudTrail's `requestID` is
 * frequently not a UUID (an S3 request id is 16 hex characters), so for that
 * one column the cast re-creates the quiet data loss ADR-0004 was written to
 * end, one layer down. Sentinel's own answer is a string successor column
 * standing beside the deprecated guid one: `AwsRequestId_`.
 *
 * THIS IS CONTENT, NOT A RULE, and that half is as load-bearing as the choice.
 * ADR-0004 ("What is NOT decided here", 0004-cast-guid-columns.md:82-86)
 * refuses it as a schema-mapping RULE 2b clause, because a general
 * `<Col> -> <Col>_` rewrite would rename columns in the many tables that carry
 * no successor at all - and schema-mapping's RULE 4 says casts never rename.
 * The bundled catalog agrees that this is a one-table fact rather than a
 * pattern: sweeping every table in dcr-template-schemas.json for a column
 * whose `<name>_` sibling also exists returns exactly one hit, AWSCloudTrail's
 * AwsRequestId.
 *
 * So each entry names ONE table, ONE deprecated column, its successor, and the
 * vendor field that carries the value. The entries are handed to analyzeSamples
 * as ordinary Phase-0 mappings, which means they pass through the SAME
 * per-sample guard the vendor packs go through - an entry whose destination is
 * absent from the resolved schema is dropped there. The constraint is enforced
 * by that guard, in code, rather than by remembering to honour it.
 *
 * Pure data + pure lookup: no IO, no fetch, no React, no Date/crypto.
 */

import type { VendorMapping } from "../../domain/field-matcher/index";

/** One table's deprecated guid column and the string column that replaced it. */
export interface DeprecatedGuidSuccessor {
  /** The guid column ADR-0004 promotes with `toguid()`. */
  deprecatedColumn: string;
  /** The string column Sentinel added beside it to keep non-UUID values. */
  successorColumn: string;
  /**
   * The vendor's own field names carrying the value. Matched
   * case-insensitively by the matcher's Phase 0, so `requestID` also covers
   * feeds that emit `requestId`.
   */
  sourceNames: readonly string[];
  /** Why this table has a successor - cited to the operator on the match row. */
  doc: string;
}

/**
 * The content, keyed by LOWERCASED table name. Adding a table here is a
 * per-table claim that its schema really does carry both columns; the
 * analyzeSamples guard still checks the resolved schema before applying it.
 */
const SUCCESSORS_BY_TABLE: Readonly<
  Record<string, readonly DeprecatedGuidSuccessor[]>
> = {
  awscloudtrail: [
    {
      deprecatedColumn: "AwsRequestId",
      successorColumn: "AwsRequestId_",
      sourceNames: ["requestID"],
      doc: "AwsRequestId is a guid column and a CloudTrail request id is frequently not a UUID, so toguid() would return null; AwsRequestId_ is the string successor",
    },
  ],
};

/** The successors declared for one table (empty for every other table). */
export function deprecatedGuidSuccessorsForTable(
  tableName: string,
): readonly DeprecatedGuidSuccessor[] {
  return SUCCESSORS_BY_TABLE[tableName.toLowerCase()] ?? [];
}

/**
 * The Phase-0 mappings one table's successors ask for: one entry per declared
 * vendor field, routed to the SUCCESSOR column. Types are left empty so
 * Phase 0 prefers the live sample/schema types, matching
 * vendorMappingsForSolution.
 */
export function guidSuccessorMappings(tableName: string): VendorMapping[] {
  return deprecatedGuidSuccessorsForTable(tableName).flatMap((successor) =>
    successor.sourceNames.map((sourceName) => ({
      sourceName,
      destName: successor.successorColumn,
      sourceType: "",
      destType: "",
      action: "map",
      description: successor.doc,
    })),
  );
}
