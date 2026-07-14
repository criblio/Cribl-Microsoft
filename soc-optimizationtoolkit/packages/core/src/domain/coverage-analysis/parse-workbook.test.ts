/**
 * Workbook serializedData mining pins (porting-plan Unit 23 task item 6, NET-
 * NEW). Pins the DEFENSIVE parse: nested group query steps are found, non-KQL
 * steps are skipped without counting, unreadable steps and a corrupt
 * serializedData string are COUNTED (surface, not silent under-report).
 *
 * FIXTURE (labeled SYNTHESIZED): modeled on the Azure Monitor workbook document
 * shape - serializedData is a JSON STRING of `{ items: [step,...] }`, a query
 * step is `{ type: 3, content: { query, queryType } }`, groups (type 12) nest
 * more steps under `content.items`.
 */

import { describe, expect, it } from "vitest";

import { extractWorkbookQueries, workbookToContentItem } from "./parse-workbook";

// SYNTHESIZED workbook (labeled): text step + KQL step + nested group KQL step
// + a metrics (non-KQL) step + a broken query step.
const WORKBOOK = {
  version: "Notebook/1.0",
  items: [
    { type: 1, content: { json: "## Overview" } },
    {
      type: 3,
      content: {
        version: "KqlItem/1.0",
        query: "SigninLogs | where ResultType == 0 | summarize by IPAddress",
        queryType: 0,
      },
    },
    {
      type: 12, // a group that nests more steps
      content: {
        version: "NotebookGroup/1.0",
        groupType: "editable",
        items: [
          {
            type: 3,
            content: {
              version: "KqlItem/1.0",
              query: "SecurityEvent | where EventID == 4625 | project Account",
              queryType: 0,
            },
          },
        ],
      },
    },
    {
      type: 3, // a metrics step - readable but NOT KQL, skipped without counting
      content: { version: "MetricsItem/1.0", queryType: 1 },
    },
    {
      type: 3, // a query step with NO query string - counted as unparseable
      content: { version: "KqlItem/1.0", queryType: 0 },
    },
  ],
};

describe("extractWorkbookQueries", () => {
  it("recovers top-level and nested-group KQL query steps", () => {
    const result = extractWorkbookQueries(JSON.stringify(WORKBOOK));
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]).toContain("SigninLogs");
    expect(result.queries[1]).toContain("SecurityEvent");
  });

  it("counts the broken query step as unparseable (surface, not drop)", () => {
    const result = extractWorkbookQueries(JSON.stringify(WORKBOOK));
    expect(result.unparseableCount).toBe(1);
  });

  it("skips a non-KQL (metrics) step WITHOUT counting it unparseable", () => {
    // The metrics step is queryType 1; it is readable, just not a table query.
    const single = {
      items: [{ type: 3, content: { queryType: 1 } }],
    };
    const result = extractWorkbookQueries(JSON.stringify(single));
    expect(result.queries).toHaveLength(0);
    expect(result.unparseableCount).toBe(0);
  });

  it("treats a query step with absent queryType as KQL", () => {
    const single = {
      items: [{ type: 3, content: { query: "Heartbeat | count" } }],
    };
    const result = extractWorkbookQueries(JSON.stringify(single));
    expect(result.queries).toEqual(["Heartbeat | count"]);
    expect(result.unparseableCount).toBe(0);
  });

  it("counts a corrupt serializedData string as one unparseable document", () => {
    const result = extractWorkbookQueries("{ not valid json ][");
    expect(result.queries).toEqual([]);
    expect(result.unparseableCount).toBe(1);
  });

  it("counts a whitespace-only query as unparseable", () => {
    const single = {
      items: [{ type: 3, content: { query: "   ", queryType: 0 } }],
    };
    const result = extractWorkbookQueries(JSON.stringify(single));
    expect(result.queries).toEqual([]);
    expect(result.unparseableCount).toBe(1);
  });

  it("never throws on an empty or itemless document", () => {
    expect(extractWorkbookQueries("{}").queries).toEqual([]);
    expect(extractWorkbookQueries('{"items":[]}').unparseableCount).toBe(0);
  });
});

describe("workbookToContentItem projection", () => {
  it("projects mined queries into the shared ContentItem", () => {
    const extraction = extractWorkbookQueries(JSON.stringify(WORKBOOK));
    const item = workbookToContentItem(
      "/subscriptions/s/.../workbooks/wb-1",
      "Sign-in Analysis",
      extraction,
    );
    expect(item.type).toBe("workbook");
    expect(item.id).toBe("/subscriptions/s/.../workbooks/wb-1");
    expect(item.name).toBe("Sign-in Analysis");
    expect(item.queries).toHaveLength(2);
    expect(item.unparseableQueryCount).toBe(1);
    expect(item.severity).toBeUndefined();
  });
});
