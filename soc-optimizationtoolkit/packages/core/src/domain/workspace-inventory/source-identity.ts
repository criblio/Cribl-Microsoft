/**
 * source-identity - which columns say WHO sent a row, per table (MIG-27).
 *
 * There is no single "source" column across Log Analytics tables. The default
 * order (`_ResourceId`, then `Computer`, then `DeviceVendor DeviceProduct`) is
 * in workspace-inventory; this map overrides it for the tables where that
 * order names the wrong thing. Measured 2026-11-04 on a Sentinel workspace:
 * CommonSecurityLog rows are Cisco ASA, `_ResourceId` empty, `Computer` the
 * COLLECTOR ("localhost", ":" or a host name) - the default order would name
 * the collector and never say Cisco ASA.
 *
 * Data only: add a table by adding a rule. A mapped table's rows whose identity
 * columns are all empty fall through to the default order, so a rule can only
 * sharpen an answer, never lose one.
 */

/** The date this map was last checked against a live workspace. */
export const SOURCE_IDENTITY_AS_OF = "2026-11-04";

export interface SourceIdentityRule {
  table: string;
  /** What the identity is: a vendor/product, or a machine. */
  attribution: "product" | "computer";
  /** Identity columns, in order. */
  columns: readonly string[];
  /**
   * Whether the collector (`_ResourceId`'s last path segment, else `Computer`)
   * is kept as a separate dimension. True where identity is a product that a
   * collector forwarded; false where the identity IS the machine.
   */
  keepsCollector: boolean;
  /**
   * `join`: all columns, space-separated (vendor + product). `first`: the first
   * non-empty column (a fallback chain).
   */
  combine: "join" | "first";
}

export const SOURCE_IDENTITY_RULES: readonly SourceIdentityRule[] = [
  {
    table: "CommonSecurityLog",
    attribution: "product",
    columns: ["DeviceVendor", "DeviceProduct"],
    keepsCollector: true,
    combine: "join",
  },
  {
    table: "SecurityAlert",
    attribution: "product",
    columns: ["ProductName", "ProviderName"],
    keepsCollector: true,
    combine: "first",
  },
  {
    table: "Syslog",
    attribution: "computer",
    columns: ["Computer", "Facility"],
    keepsCollector: false,
    combine: "join",
  },
];

function col(name: string): string {
  return `tostring(column_ifexists('${name}', ''))`;
}

/** The KQL expression for one rule's identity value ('' when it has none). */
function identityExpression(rule: SourceIdentityRule): string {
  if (rule.combine === "first") {
    const arms = rule.columns.map((c) => `isnotempty(${col(c)}), ${col(c)}`);
    return `case(${arms.join(", ")}, '')`;
  }
  const parts = rule.columns.map(col).join(", ' ', ");
  return `trim(' ', strcat(${parts}))`;
}

/**
 * The KQL `extend` fragment that sets `Source`, `Attribution` and `Collector`
 * (one `| extend` per call, no trailing newline). A mapped table's row takes
 * its rule when the rule's identity is non-empty; every other row takes the
 * default order. `Collector` is '' unless the rule keeps one.
 */
export function identityKql(): string {
  const mapped = SOURCE_IDENTITY_RULES.map((rule, i) => ({
    rule,
    id: `_id${i}`,
    when: `SourceTable =~ '${rule.table}' and isnotempty(_id${i})`,
  }));
  const lines = [
    "| extend _rid = tostring(column_ifexists('_ResourceId', '')),",
    "    _comp = tostring(column_ifexists('Computer', '')),",
    "    _dev = trim(' ', strcat(tostring(column_ifexists('DeviceVendor', '')), ' ',",
    "        tostring(column_ifexists('DeviceProduct', ''))))",
    ...mapped.map(
      ({ rule, id }, i) =>
        `${i === 0 ? "| extend " : "    "}${id} = ${identityExpression(rule)}${
          i === mapped.length - 1 ? "" : ","
        }`,
    ),
    "| extend _collector = iff(isnotempty(_rid), tostring(split(_rid, '/')[-1]), _comp)",
    "| extend Source = case(",
    ...mapped.map(({ id, when }) => `        ${when}, ${id},`),
    "        isnotempty(_rid), _rid, isnotempty(_comp), _comp, isnotempty(_dev), _dev, ''),",
    "    Attribution = case(",
    ...mapped.map(({ rule, when }) => `        ${when}, '${rule.attribution}',`),
    "        isnotempty(_rid), 'resource', isnotempty(_comp), 'computer',",
    "        isnotempty(_dev), 'device', 'none'),",
    "    Collector = case(",
    ...mapped
      .filter(({ rule }) => rule.keepsCollector)
      .map(({ when }) => `        ${when}, _collector,`),
    "        '')",
  ];
  return lines.join("\n");
}
