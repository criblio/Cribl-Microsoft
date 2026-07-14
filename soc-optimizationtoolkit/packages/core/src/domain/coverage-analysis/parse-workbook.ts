/**
 * Workbook KQL extraction (porting-plan Unit 23 task item 6) - NET-NEW, no
 * legacy source (the old app never analyzed workbooks). This is the second
 * source into the ONE shared analyzer: a workbook is many KQL query steps in a
 * single ARM document, buried inside `properties.serializedData` as a JSON
 * STRING (a document-within-a-document). The native-onboarding plan flags this
 * buried-KQL as a known analyzer risk, so the parse is DEFENSIVE and COUNTS
 * what it could not read rather than silently under-reporting coverage.
 *
 * Azure Monitor workbook shape (defensively assumed, not required):
 *   serializedData (JSON string) -> { items: [ step, ... ] }
 *   a query step is `{ type: 3, content: { query: "<KQL>", queryType?: n } }`.
 *   Groups nest more steps under `content.items` / `items`. queryType 0 (or
 *   absent) is a Logs/KQL query; a non-zero queryType is a non-KQL data source
 *   (metrics, ARG, ...) and is NOT mined for table fields.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { ContentItem, WorkbookQueryExtraction } from "./models";

/** The workbook item `type` value that denotes a query step. */
const QUERY_STEP_TYPE = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defensively mine every KQL query string out of a workbook's serializedData.
 *
 * Error handling is TOTAL: an unparseable serializedData string (not JSON)
 * yields `{ queries: [], unparseableCount: 1 }` - the whole document counted as
 * one unreadable unit. A query step whose `content.query` is missing, empty, or
 * not a string increments `unparseableCount`. A non-KQL query step (non-zero
 * queryType) is SKIPPED without counting - it is readable, just not a table
 * query. Never throws.
 */
export function extractWorkbookQueries(
  serializedData: string,
): WorkbookQueryExtraction {
  let root: unknown;
  try {
    root = JSON.parse(serializedData);
  } catch {
    // The buried document itself is corrupt/unreadable - surface it as one miss.
    return { queries: [], unparseableCount: 1 };
  }

  const queries: string[] = [];
  let unparseableCount = 0;

  // Recursively visit every node; a query step is any object with type === 3.
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;

    if (node["type"] === QUERY_STEP_TYPE) {
      const content = node["content"];
      const contentRecord = isRecord(content) ? content : undefined;
      const queryType = contentRecord ? contentRecord["queryType"] : undefined;
      // queryType 0 or absent == Logs/KQL. Non-zero == a different data source.
      const isKqlStep = queryType === undefined || queryType === 0;
      if (isKqlStep) {
        const query = contentRecord ? contentRecord["query"] : undefined;
        if (typeof query === "string" && query.trim() !== "") {
          queries.push(query);
        } else {
          // A KQL step we could not read a query out of - surface the miss.
          unparseableCount++;
        }
      }
    }

    // Descend into every child so nested group steps are found too.
    for (const key of Object.keys(node)) visit(node[key]);
  };

  visit(root);
  return { queries, unparseableCount };
}

/**
 * Project a workbook (its ARM resource id, display name, and mined queries)
 * into the shared {@link ContentItem}. Workbooks never carry entity fields or
 * severity - they are pure query bags into the same engine as alert rules.
 */
export function workbookToContentItem(
  id: string,
  name: string,
  extraction: WorkbookQueryExtraction,
): ContentItem {
  return {
    type: "workbook",
    id,
    name,
    queries: extraction.queries,
    unparseableQueryCount: extraction.unparseableCount,
  };
}
