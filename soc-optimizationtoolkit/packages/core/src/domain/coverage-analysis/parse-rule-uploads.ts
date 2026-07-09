/**
 * Custom-rule UPLOAD parsing beyond the repo's YAML detections (user question
 * 2026-07-08: "Sentinel Analytics Rules are KQL not yaml"). A Sentinel rule's
 * CONTENT is KQL, but the FILE wrapping that KQL depends on where the rule
 * came from:
 *
 *  - The Azure-Sentinel repo / Content Hub solutions store rules as YAML
 *    detection files (`query: |` blocks) - parseAnalyticRuleYaml.
 *  - The portal's Analytics blade EXPORTS rules as ARM JSON templates
 *    (alertRules resources with properties.query) - parseAnalyticRuleArmJson
 *    here. This is what an operator actually has for their own custom rules.
 *  - A hand-copied query is just raw KQL text - parseRawKqlRule here.
 *
 * {@link parseRuleUploadFile} dispatches on the file extension so ONE upload
 * button accepts all three.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { KQL_BUILTINS } from "./kql-builtins";
import { parseAnalyticRuleYaml } from "./parse-analytic-rule";
import type { ParsedAnalyticRule } from "./models";

/** The extensions the custom-rule upload accepts (drives the input accept). */
export const RULE_UPLOAD_EXTENSIONS: readonly string[] = [
  ".yaml",
  ".yml",
  ".json",
  ".kql",
  ".txt",
];

/** Whether a file name is accepted by the custom-rule upload. */
export function isRuleUploadFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return RULE_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Entity-mapping column names from an ARM rule, KQL builtins filtered out. */
function entityFieldsFromArm(properties: Record<string, unknown>): string[] {
  const fields: string[] = [];
  for (const mapping of Array.isArray(properties.entityMappings)
    ? properties.entityMappings
    : []) {
    const m = asRecord(mapping);
    if (m === null) continue;
    for (const fm of Array.isArray(m.fieldMappings) ? m.fieldMappings : []) {
      const f = asRecord(fm);
      const column = f?.columnName;
      if (
        typeof column === "string" &&
        column !== "" &&
        !KQL_BUILTINS.has(column.toLowerCase())
      ) {
        fields.push(column);
      }
    }
  }
  return fields;
}

function ruleFromArmResource(
  resource: Record<string, unknown>,
  properties: Record<string, unknown>,
  fileName: string,
): ParsedAnalyticRule {
  const displayName = properties.displayName;
  const resourceName = resource.name;
  return {
    id: typeof resourceName === "string" ? resourceName : "",
    name:
      typeof displayName === "string" && displayName !== ""
        ? displayName
        : typeof resourceName === "string" && resourceName !== ""
          ? resourceName
          : fileName,
    severity:
      typeof properties.severity === "string" && properties.severity !== ""
        ? properties.severity
        : "Unknown",
    tactics: stringArray(properties.tactics),
    dataTypes: [],
    query: typeof properties.query === "string" ? properties.query.trim() : "",
    entityFields: entityFieldsFromArm(properties),
    fileName,
  };
}

/**
 * Parse a portal ARM JSON export into rules. Accepts the full export template
 * (a `resources` array of alertRules), a bare array of resources, or a single
 * resource object - anything carrying `properties.query`. Non-rule resources
 * and unparseable JSON yield no rules (the caller surfaces a zero-count note;
 * nothing throws).
 */
export function parseAnalyticRuleArmJson(
  content: string,
  fileName: string,
): ParsedAnalyticRule[] {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return [];
  }
  const rules: ParsedAnalyticRule[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = asRecord(node);
    if (obj === null) return;
    const properties = asRecord(obj.properties);
    if (properties !== null && typeof properties.query === "string") {
      rules.push(ruleFromArmResource(obj, properties, fileName));
      return;
    }
    // Descend only through `resources` (ARM template nesting) - never a
    // full-tree walk over arbitrary JSON.
    if (Array.isArray(obj.resources)) visit(obj.resources);
  };
  visit(root);
  return rules;
}

/**
 * Wrap a raw KQL file as one rule: the whole file is the query, the file name
 * (extension stripped) is the rule name. Severity is honest "Unknown" - raw
 * KQL carries none.
 */
export function parseRawKqlRule(
  content: string,
  fileName: string,
): ParsedAnalyticRule {
  return {
    id: "",
    name: fileName.replace(/\.(kql|txt)$/i, ""),
    severity: "Unknown",
    tactics: [],
    dataTypes: [],
    query: content.trim(),
    entityFields: [],
    fileName,
  };
}

/**
 * Dispatch ONE uploaded file to its parser by extension: .json is a portal
 * ARM export (may carry several rules), .kql/.txt is raw KQL (one rule; an
 * empty file yields none), anything else parses as a repo-style YAML
 * detection.
 */
export function parseRuleUploadFile(
  fileName: string,
  content: string,
): ParsedAnalyticRule[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) {
    return parseAnalyticRuleArmJson(content, fileName);
  }
  if (lower.endsWith(".kql") || lower.endsWith(".txt")) {
    const rule = parseRawKqlRule(content, fileName);
    return rule.query === "" ? [] : [rule];
  }
  return [parseAnalyticRuleYaml(content, fileName)];
}
