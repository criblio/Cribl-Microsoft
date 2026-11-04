/**
 * Tenant logging gap - the cells of the multi-tenant gap dashboard (ADR 0009
 * decision 6): tenants down, the Azure native logging sources across, and two
 * indicators per cell.
 *
 *   configured in Azure   the Validate verdicts of that source's checks, read
 *                         through the tenant's own connection
 *   onboarded to Cribl    the Cribl source record this app keeps for the
 *                         tenant, confirmed against Cribl's input listing of
 *                         the record's worker group
 *
 * Each indicator is green, red or UNKNOWN, and carries the sentence its (i)
 * shows. The words live here, beside the rule that picks the colour, so the
 * two cannot drift (claude-kit standards/info-affordances.md).
 *
 * HONESTY (claude-kit standards/inventory-honesty.md):
 * - red is reserved for a MEASURED gap: a check Validate found absent or
 *   different from the plan, a recorded input a non-empty listing lacks or
 *   that is disabled, or no record at all (the claim is scoped to what this
 *   app created, and the sentence says so);
 * - a refused, failed, truncated or never-sent read is unknown with its
 *   reason, never red; an EMPTY Cribl input listing is unknown, because a
 *   permission-filtered list answers the same `200 []`;
 * - a row whose tenant could not be proven is unknown in every cell
 *   ({@link rowUnknown}).
 *
 * Pure: no IO, no Date, no randomness.
 */

import {
  CHECK_SUBJECT,
  type CheckKind,
  type StepVerdict,
  type VerdictDiff,
} from "../onboarding-howto/check-kinds";
import type { CriblSourceRecord } from "../onboarding-howto/progress-document";
import { ONBOARDING_SOURCES, type OnboardingSource, type OnboardingSourceId } from "../onboarding-howto/sources";
import type { ExistingRead } from "../cribl-onboarding-source/classify-existing";
import { UNKNOWN_REASON_LABEL } from "../onboarding-dataflow/lanes";
import type { TenantGroupResolution } from "../tenant-cribl-mapping";
import { normalizeTenantId, tenantNamedIn } from "../tenancy";

/** The columns: every Azure native logging source the onboarding catalog knows, in its order. */
export const GAP_SOURCES: readonly OnboardingSource[] = ONBOARDING_SOURCES;

export type GapState = "green" | "red" | "unknown";

/** One indicator and the sentence its (i) shows. */
export interface GapIndicator {
  readonly state: GapState;
  readonly reason: string;
}

/** One tenant's cell for one source. */
export interface GapCell {
  readonly sourceId: OnboardingSourceId;
  readonly azure: GapIndicator;
  readonly cribl: GapIndicator;
}

/** One Validate check of a source, as the indicator needs it. */
export interface GapCheck {
  readonly kind: CheckKind;
  readonly verdict: StepVerdict;
}

/** The (i) of a cell no read has reached yet. */
export const NOT_READ_REASON = "Not read yet. Choose Read for this tenant, or Read all tenants.";

function unknown(reason: string): GapIndicator {
  return { state: "unknown", reason };
}

/** Every cell of a row unknown, both indicators, with one reason. */
export function rowUnknown(reason: string): GapCell[] {
  const i = unknown(reason);
  return GAP_SOURCES.map((s) => ({ sourceId: s.id, azure: i, cribl: i }));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listed(parts: readonly string[], max = 3): string {
  const shown = parts.slice(0, max).join("; ");
  return parts.length > max ? `${shown}; and ${parts.length - max} more` : shown;
}

function diffText(diffs: readonly VerdictDiff[]): string {
  return diffs.map((d) => `${d.field}: expected ${d.expected}, found ${d.actual}`).join(", ");
}

/**
 * Configured in Azure, from one source's Validate checks.
 *
 *   red      any check found its object absent, or present but different
 *            from the plan - a measured gap, whatever else could not be read
 *   unknown  otherwise, any check could not be read (or had no plan value
 *            to read with); also when there are no checks at all
 *   green    every check matched the plan (another name with nothing
 *            different counts as configured, and is named)
 */
export function azureGapIndicator(checks: readonly GapCheck[]): GapIndicator {
  if (checks.length === 0) return unknown("No check covers this source, so nothing was read.");
  const gaps: string[] = [];
  const unread: string[] = [];
  const otherNames: string[] = [];
  let missingValue = false;
  for (const { kind, verdict } of checks) {
    const subject = CHECK_SUBJECT[kind];
    switch (verdict.kind) {
      case "as-expected":
        break;
      case "absent":
        gaps.push(`${subject} was not found`);
        break;
      case "present-differs":
        gaps.push(`${subject} differs from the plan (${diffText(verdict.diffs)})`);
        break;
      case "present-other-name":
        if (verdict.diffs.length > 0) {
          gaps.push(`${subject} exists as ${verdict.name} but differs from the plan (${diffText(verdict.diffs)})`);
        } else {
          otherNames.push(`${subject} exists as ${verdict.name}`);
        }
        break;
      case "unknown":
        if (verdict.reason === "missing-value") missingValue = true;
        unread.push(
          `${subject}: ${UNKNOWN_REASON_LABEL[verdict.reason]}${verdict.detail === "" ? "" : ` (${verdict.detail})`}`,
        );
        break;
    }
  }
  if (gaps.length > 0) {
    const also = unread.length > 0 ? ` ${plural(unread.length, "other check", "other checks")} could not be read.` : "";
    return { state: "red", reason: `Not configured as planned: ${listed(gaps)}.${also}` };
  }
  if (unread.length > 0) {
    const next = missingValue
      ? " Set this tenant's plan values on Azure Native Source Onboarding while its connection is active."
      : "";
    return unknown(`Could not tell: ${listed(unread)}.${next}`);
  }
  const named = otherNames.length > 0 ? ` ${listed(otherNames)}.` : "";
  return {
    state: "green",
    reason: `Configured: all ${plural(checks.length, "check", "checks")} matched the plan.${named}`,
  };
}

/** What the Cribl indicator is read from. */
export interface CriblGapInput {
  /** The source's title, as the column shows it. */
  readonly title: string;
  readonly tenantId: string;
  /** The Cribl source record this app keeps for the tenant and source, or null when it holds none. */
  readonly record: CriblSourceRecord | null;
  /** Where the tenant to Cribl mapping sends this tenant's sources. */
  readonly group: TenantGroupResolution;
  /** Cribl's input listing of the record's group; null when it was not read. */
  readonly inputs: ExistingRead | null;
}

function groupSentence(group: TenantGroupResolution): string {
  switch (group.kind) {
    case "mapped":
      return `This tenant's sources go to worker group ${group.groupId}.`;
    case "unset":
      return "No worker group is mapped to this tenant yet; choose one on Setup.";
    case "unknown":
      return `The tenant to Cribl mapping could not be read (${group.reason}).`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Onboarded to Cribl, from the app's record for the source and Cribl's input
 * listing of the record's group.
 */
export function criblGapIndicator(input: CriblGapInput): GapIndicator {
  const { record, inputs, group } = input;
  if (record === null) {
    return {
      state: "red",
      reason:
        `This app has not created a Cribl source for ${input.title} for this tenant. ${groupSentence(group)} ` +
        "A source created in Cribl by hand is not counted.",
    };
  }
  const where = `input ${record.inputId} in worker group ${record.groupId}`;
  if (inputs === null) return unknown(`This app recorded ${where}, but Cribl was not read.`);
  if (inputs.state === "refused") {
    return unknown(`This app recorded ${where}, but Cribl's input list could not be read (${inputs.detail}).`);
  }
  if (inputs.items.length === 0) {
    return unknown(
      `This app recorded ${where}, but Cribl listed no inputs at all in that group. A list filtered by ` +
        "permissions answers the same way, so whether the input exists is unknown.",
    );
  }
  let found: Record<string, unknown> | null = null;
  for (const item of inputs.items) {
    if (!isRecord(item)) {
      return unknown(`Cribl's input list for worker group ${record.groupId} held a row this app cannot read.`);
    }
    if (item["id"] === record.inputId) found = item;
  }
  if (found === null) {
    return { state: "red", reason: `This app recorded ${where}, which Cribl no longer has.` };
  }
  if (found["type"] !== record.inputType) {
    return {
      state: "red",
      reason: `${where} is now a ${String(found["type"])} input, not the ${record.inputType} input this app created.`,
    };
  }
  const description = typeof found["description"] === "string" ? found["description"] : "";
  const named = tenantNamedIn(description);
  if (named !== null && named !== normalizeTenantId(input.tenantId)) {
    return unknown(`${where} names tenant ${named} in its description, not this tenant.`);
  }
  if (found["disabled"] === true) {
    return { state: "red", reason: `${where} exists but is disabled, so it collects nothing.` };
  }
  const moved =
    group.kind === "mapped" && group.groupId !== record.groupId
      ? ` The mapping now names worker group ${group.groupId} for this tenant, so a new source would go there instead.`
      : "";
  return { state: "green", reason: `Onboarded: ${where}.${moved}` };
}
