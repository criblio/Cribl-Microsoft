/**
 * AnalyticRule YAML parsing pins (porting-plan Unit 23 task items 3 & 5).
 *
 * The regex extraction is PINNED here BEFORE any real-YAML-parser adoption,
 * including the JS-literal `\Z` query-terminator quirk and the entity-field
 * builtins filter. The dedupe-by-name FIX (allow re-upload) and the
 * zero-schema-field SURFACE decision (parser never drops) are pinned too.
 *
 * FIXTURES: no real AnalyticRule YAML exists anywhere in this repo tree (the
 * lazy-fetch redesign means solutions are pulled on demand, never vendored), so
 * the documents below are SYNTHESIZED and LABELED, modeled field-for-field on
 * the Microsoft Azure-Sentinel repo's Analytic Rules YAML schema (id / name /
 * severity / tactics / query / requiredDataConnectors.dataTypes /
 * entityMappings.fieldMappings.columnName).
 */

import { describe, expect, it } from "vitest";

import {
  analyticRuleToContentItem,
  mergeCustomContentItems,
  parseAnalyticRuleYaml,
  parseCustomAnalyticRuleYaml,
} from "./parse-analytic-rule";
import type { ContentItem } from "./models";

// SYNTHESIZED fixture (labeled): a well-formed Sentinel analytic rule.
const RULE_YAML = `id: 8b8b1234-0000-4a4a-9c9c-abcdef012345
name: "Suspicious sign-in from new location"
severity: High
requiredDataConnectors:
  - connectorId: AzureActiveDirectory
    dataTypes:
      - SigninLogs
      - AuditLogs
tactics:
  - InitialAccess
  - CredentialAccess
query: |
  SigninLogs
  | where ResultType == "0"
  | where isnotempty(IPAddress)
  | summarize Count = count() by UserPrincipalName, IPAddress
entityMappings:
  - entityType: Account
    fieldMappings:
      - identifier: FullName
        columnName: UserPrincipalName
  - entityType: IP
    fieldMappings:
      - identifier: Address
        columnName: IPAddress
`;

describe("parseAnalyticRuleYaml - field extraction", () => {
  const rule = parseAnalyticRuleYaml(RULE_YAML, "rule.yaml");

  it("reads id, name (quotes stripped), and severity", () => {
    expect(rule.id).toBe("8b8b1234-0000-4a4a-9c9c-abcdef012345");
    expect(rule.name).toBe("Suspicious sign-in from new location");
    expect(rule.severity).toBe("High");
  });

  it("reads the tactics list", () => {
    expect(rule.tactics).toEqual(["InitialAccess", "CredentialAccess"]);
  });

  it("reads the dataTypes list", () => {
    expect(rule.dataTypes).toEqual(["SigninLogs", "AuditLogs"]);
  });

  it("captures the multi-line query body", () => {
    expect(rule.query).toContain("SigninLogs");
    expect(rule.query).toContain("summarize Count = count()");
  });

  it("extracts entity columnName fields", () => {
    expect(rule.entityFields).toContain("UserPrincipalName");
    expect(rule.entityFields).toContain("IPAddress");
  });

  it("falls back to the file name when name is absent", () => {
    const r = parseAnalyticRuleYaml("severity: Low\n", "no-name.yaml");
    expect(r.name).toBe("no-name.yaml");
    expect(r.severity).toBe("Low");
  });

  it("defaults severity to Unknown when absent", () => {
    const r = parseAnalyticRuleYaml("name: X\n", "x.yaml");
    expect(r.severity).toBe("Unknown");
  });
});

describe("entity columnName builtins filter (verbatim legacy behavior)", () => {
  it("drops a columnName that is a KQL builtin (e.g. Type)", () => {
    const yaml = `name: R
severity: Low
query: |
  T | where A == "x"
entityMappings:
  - entityType: Host
    fieldMappings:
      - identifier: FullName
        columnName: Type
      - identifier: HostName
        columnName: DeviceName
`;
    const rule = parseAnalyticRuleYaml(yaml, "r.yaml");
    expect(rule.entityFields).not.toContain("Type");
    expect(rule.entityFields).toContain("DeviceName");
  });
});

describe("PINNED quirk: JS-literal \\Z query terminator", () => {
  it("captures the full query when no literal 'Z' precedes the next key", () => {
    const yaml = `name: R
severity: High
query: |
  SecurityEvent
  | where Account == "admin"
severity_note: ignore
`;
    const rule = parseAnalyticRuleYaml(yaml, "r.yaml");
    expect(rule.query).toContain("SecurityEvent");
    expect(rule.query).toContain('Account == "admin"');
  });

  it("TRUNCATES the query at a literal capital Z (the \\Z bug, preserved)", () => {
    // The query references "Zone"; the `(?=...|\\Z)` lookahead treats the
    // capital Z as an end-anchor and cuts the body off right before it.
    const yaml = `name: R
severity: High
query: |
  SecurityEvent
  | where Zone == "dmz"
tactics:
  - Discovery
`;
    const rule = parseAnalyticRuleYaml(yaml, "r.yaml");
    expect(rule.query).toContain("SecurityEvent");
    // The quirk: everything from the capital Z onward is lost.
    expect(rule.query).not.toContain("Zone");
    expect(rule.query).not.toContain("dmz");
  });
});

describe("SURFACE (not drop) at parse time - Unit 13/18 precedent", () => {
  it("returns a rule even when it has no query and no entity fields", () => {
    // The legacy listAnalyticRules did `if (requiredFields.length > 0) push` and
    // SILENTLY DROPPED such a rule. The parser here never drops; the three-way
    // analyzer surfaces its (absent/unknown) fields instead of vanishing it.
    const rule = parseAnalyticRuleYaml("name: Empty\nseverity: Low\n", "e.yaml");
    expect(rule.name).toBe("Empty");
    expect(rule.query).toBe("");
    expect(rule.entityFields).toEqual([]);
  });
});

describe("analyticRuleToContentItem projection", () => {
  it("projects a repo rule to the shared ContentItem", () => {
    const rule = parseAnalyticRuleYaml(RULE_YAML, "rule.yaml");
    const item = analyticRuleToContentItem(rule, false);
    expect(item.type).toBe("alert-rule");
    expect(item.id).toBe(rule.id);
    expect(item.name).toBe(rule.name);
    expect(item.queries).toHaveLength(1);
    expect(item.extraFields).toEqual(rule.entityFields);
    expect(item.custom).toBe(false);
  });

  it("falls back id to name when the rule has no id", () => {
    const rule = parseAnalyticRuleYaml("name: NoId\nseverity: Low\n", "n.yaml");
    const item = analyticRuleToContentItem(rule);
    expect(item.id).toBe("NoId");
    expect(item.queries).toEqual([]); // no query -> empty queries array
  });
});

describe("parseCustomAnalyticRuleYaml PRESERVES the query (redesign)", () => {
  it("keeps the KQL so a custom upload flows through the same engine", () => {
    const rule = parseCustomAnalyticRuleYaml(RULE_YAML, "custom.yaml");
    const item = analyticRuleToContentItem(rule, true);
    expect(item.custom).toBe(true);
    // Legacy set custom rules' query to '' in coverage; here it is preserved.
    expect(item.queries[0]).toContain("SigninLogs");
  });
});

describe("mergeCustomContentItems - dedupe-by-name FIX (allow re-upload)", () => {
  const ruleA: ContentItem = {
    type: "alert-rule",
    id: "Foo",
    name: "Foo",
    queries: ["T | where Old == 1"],
    custom: true,
  };
  const ruleAUpdated: ContentItem = {
    type: "alert-rule",
    id: "Foo",
    name: "Foo",
    queries: ["T | where New == 2"],
    custom: true,
  };
  const ruleB: ContentItem = {
    type: "alert-rule",
    id: "Bar",
    name: "Bar",
    queries: ["T | where B == 3"],
    custom: true,
  };

  it("REPLACES a same-name rule so an edited re-upload takes effect", () => {
    // Legacy: `if (!merged.some((r) => r.name === rule.name)) push` -> the
    // re-upload was IGNORED and the stale rule stayed. Fixed to last-write-wins.
    const merged = mergeCustomContentItems([ruleA], [ruleAUpdated]);
    expect(merged).toHaveLength(1);
    expect(merged[0].queries[0]).toBe("T | where New == 2");
  });

  it("keeps the replaced rule in its original slot and appends new names", () => {
    const merged = mergeCustomContentItems([ruleA, ruleB], [ruleAUpdated]);
    expect(merged.map((r) => r.name)).toEqual(["Foo", "Bar"]);
    expect(merged[0].queries[0]).toBe("T | where New == 2");
  });

  it("appends a genuinely new rule", () => {
    const merged = mergeCustomContentItems([ruleA], [ruleB]);
    expect(merged.map((r) => r.name)).toEqual(["Foo", "Bar"]);
  });

  it("does not mutate the input arrays", () => {
    const existing = [ruleA];
    mergeCustomContentItems(existing, [ruleAUpdated]);
    expect(existing[0].queries[0]).toBe("T | where Old == 1");
  });
});
