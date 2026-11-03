/**
 * Benefit used (Microsoft's own record, the workspace `Operation` table),
 * eligible volume per grant, and the per-grant per-day fold.
 *
 * Pure: queries are strings, rows come in already parsed. Units are decimal
 * (Operation "GB" = 1000 MB until MIG-17 measures otherwise).
 */
import {
  INVENTORY_WINDOW_DAYS,
  kqlTableRef,
  WINDOW_FILTER,
} from "../workspace-inventory/workspace-inventory";
import type { GrantId } from "./allowance-catalog";

const MB_PER_GB = 1000;
const BENEFIT_TYPE_PREFIX = "Benefit type used: ";
/** A day is capped when eligible volume exceeds what was applied by more than 1%. */
const CAP_TOLERANCE = 1.01;

/**
 * The spec's Operation query: one row per day and benefit type. The amount
 * pattern allows an exponent: a small benefit can be written '1E-05 GB', and
 * stopping at the 'E' would read it as 1 GB.
 */
export const BENEFIT_QUERY = [
  "Operation",
  `| where ${WINDOW_FILTER}`,
  '| where Detail startswith "Benefit amount used"',
  "| extend BenefitType = replace_string(OperationKey, 'Benefit type used: ', ''),",
  "    BenefitUsedGB = todouble(extract(@'Benefit amount used: ([0-9.]+(?:[eE][-+]?[0-9]+)?)', 1, Detail))",
  "| summarize BenefitUsedGB = sum(BenefitUsedGB)",
  "    by Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd'), BenefitType",
  "| order by Day asc",
].join("\n");

/** Billable eligible volume per day and table. */
export function eligibleDailyQuery(tables: readonly string[]): string {
  if (tables.length === 0) {
    throw new Error("eligibleDailyQuery: no tables");
  }
  // DataType is a string value, not an entity reference: unwrap kqlTableRef's
  // ['...'] quoting (which escapes backslash and quote) into a string literal.
  const literals = tables.map((t) => `'${kqlTableRef(t).slice(2, -2)}'`);
  return [
    "Usage",
    `| where ${WINDOW_FILTER} and DataType in (${literals.join(", ")})`,
    "    and IsBillable == true",
    "| summarize EligibleMB = sum(Quantity)",
    "    by Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd'), DataType",
  ].join("\n");
}

export interface BenefitDay {
  day: string;
  grant: GrantId | "pooled";
  usedMB: number;
}

/**
 * Tried IN ORDER, first match wins (e5 first). Initial guesses; MIG-17
 * replaces them with the literal strings it records.
 */
export const BENEFIT_TYPE_PATTERNS: ReadonlyArray<{ pattern: RegExp; grant: GrantId }> = [
  { pattern: /M365|Microsoft 365|Defender XDR/i, grant: "e5" },
  { pattern: /Defender for Servers|per Node|Security/i, grant: "servers-p2" },
];

function grantForType(type: string): GrantId | null {
  const bare = type.startsWith(BENEFIT_TYPE_PREFIX) ? type.slice(BENEFIT_TYPE_PREFIX.length) : type;
  for (const { pattern, grant } of BENEFIT_TYPE_PATTERNS) {
    if (pattern.test(bare)) return grant;
  }
  return null;
}

/**
 * Operation rows to per-day usage. If ANY benefit type is unrecognised the
 * whole result is pooled: attributing the recognised rows alone would present
 * a partial split as the whole.
 */
export function parseBenefitRows(rows: ReadonlyArray<Record<string, unknown>>): {
  days: BenefitDay[];
  attribution: "per-grant" | "pooled";
  unmatchedTypes: string[];
} {
  const parsed: Array<{ day: string; grant: GrantId | null; usedMB: number }> = [];
  const unmatched = new Set<string>();
  for (const row of rows) {
    const day = typeof row.Day === "string" ? row.Day : "";
    const gb = Number(row.BenefitUsedGB);
    if (!day || !Number.isFinite(gb)) continue;
    const type = String(row.BenefitType ?? "");
    const grant = grantForType(type);
    if (grant === null) unmatched.add(type);
    parsed.push({ day, grant, usedMB: gb * MB_PER_GB });
  }
  const pooled = unmatched.size > 0;
  return {
    days: parsed.map((p) => ({
      day: p.day,
      grant: pooled || p.grant === null ? "pooled" : p.grant,
      usedMB: p.usedMB,
    })),
    attribution: pooled ? "pooled" : "per-grant",
    unmatchedTypes: [...unmatched],
  };
}

export interface GrantUsage {
  eligibleDailyMB: number;
  usedDailyMB: number;
  overDailyMB: number;
  maxUsedDayMB: number;
  cappedDays: Array<{ day: string; usedMB: number }>;
  eligibleByDay: Map<string, number>;
  usedByDay: Map<string, number>;
}

/** Fold per-day eligible and used into window averages. Divides by the window, not days with data. */
export function foldGrantUsage(
  eligibleByDay: ReadonlyMap<string, number>,
  usedByDay: ReadonlyMap<string, number>,
): GrantUsage {
  const days = [...new Set([...eligibleByDay.keys(), ...usedByDay.keys()])].sort();
  let eligible = 0;
  let used = 0;
  let over = 0;
  let maxUsed = 0;
  const cappedDays: Array<{ day: string; usedMB: number }> = [];
  for (const day of days) {
    const e = eligibleByDay.get(day) ?? 0;
    const u = usedByDay.get(day) ?? 0;
    eligible += e;
    used += u;
    over += Math.max(0, e - u);
    maxUsed = Math.max(maxUsed, u);
    if (u > 0 && e > u * CAP_TOLERANCE) cappedDays.push({ day, usedMB: u });
  }
  return {
    eligibleDailyMB: eligible / INVENTORY_WINDOW_DAYS,
    usedDailyMB: used / INVENTORY_WINDOW_DAYS,
    overDailyMB: over / INVENTORY_WINDOW_DAYS,
    maxUsedDayMB: maxUsed,
    cappedDays,
    eligibleByDay: new Map(eligibleByDay),
    usedByDay: new Map(usedByDay),
  };
}
