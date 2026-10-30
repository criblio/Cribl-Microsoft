/**
 * What already exists in Cribl, and which hubs a lane reads (AZR-34, ADR 0007
 * D9, D10).
 *
 * CREATE-ONLY. The onboarding source never PATCHes or DELETEs an input or a
 * secret (config-plane-writes.md). So before a write the plan classifies what
 * is there:
 *
 *   absent         nothing with that id: create it
 *   ours-matching  ours (all three ownership signals) and the identity fields
 *                  match: already applied, write nothing
 *   differs        ours, but an identity field differs: refuse, naming the fields
 *   foreign        an id this app did not provably create: refuse
 *   unknown        the read was refused or malformed: refuse - never "absent"
 *
 * Ownership is the kit's proveOwnership: id in this feature's manifest, the
 * description stamp, AND this app's KV record of the write
 * (kit/config-writes/ownership.ts). Any one alone has been wrong. The
 * manifest is the feature's id grammar (isOnboardingInputId,
 * isOnboardingSecretId), never a set built from the id being checked - that
 * would make the signal unable to fail.
 *
 * COMMIT_MARKERS are paths under the group's config directory, in the kit's
 * grammar (`local/cribl/inputs.yml`, commitDeploy.ts:86-89, matched exactly
 * at :82-84). Which files an input create and a secret create dirty is
 * UNDEFINED until measured live (ADR 0007 live-verification list); a pending
 * path the kit cannot place makes commitScope unknown and the plan refuses.
 *
 * Pure: no IO, no Date, no randomness, no crypto.
 */

import { proveOwnership } from "../../kit/config-writes/ownership";
import { findSecretRecord } from "../cribl-secrets/secret-record";
import type { CriblInputType, OnboardingSource } from "../onboarding-howto/sources";
import type { PlanValues } from "../onboarding-howto/plan-values";
import type { CriblSourceRecord } from "../onboarding-howto/progress-document";
import { APP_ID, IDENTITY_FIELDS, isOnboardingInputId, isOnboardingSecretId } from "./input-bodies";

/**
 * The files an onboarding create commits, relative to `groups/<g>/`.
 * Provenance: Undefined (inferred from the kit's examples and Cribl's
 * on-disk layout; to be measured from GET /version/status after a create).
 * The plan's draft named them without `local/`; the kit matches the full
 * relative path, so that form would never place as this group's file.
 */
export const COMMIT_MARKERS: readonly string[] = [
  "local/cribl/inputs.yml",
  "local/cribl/secrets.yml",
  "local/cribl/auth/cribl.secret",
];

/** A Cribl read of existing objects: its items, or why there are none to give. */
export type ExistingRead =
  | { readonly state: "read"; readonly items: readonly unknown[] }
  | { readonly state: "refused"; readonly detail: string };

export type ExistingInputVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "ours-matching" }
  | { readonly kind: "differs"; readonly fields: readonly string[] }
  | { readonly kind: "foreign"; readonly missing: readonly string[] }
  | { readonly kind: "unknown"; readonly detail: string };

export type ExistingSecretVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "ours" }
  | { readonly kind: "foreign"; readonly missing: readonly string[] }
  | { readonly kind: "unknown"; readonly detail: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The input with `id` in a GET /system/inputs read. Secret reads use findSecretRecord. */
function findById(read: ExistingRead & { state: "read" }, id: string): Record<string, unknown> | null | "malformed" {
  for (const item of read.items) {
    if (!isRecord(item)) return "malformed";
    if (item["id"] === id) return item;
  }
  return null;
}

function fieldAt(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** JSON with object keys sorted, so key order never reads as a difference. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** The identity fields of `type` whose values differ between `found` and `expected`. */
export function identityDiffs(
  type: CriblInputType,
  found: Record<string, unknown>,
  expected: Record<string, unknown>,
): string[] {
  return IDENTITY_FIELDS[type].filter(
    (f) => canonical(fieldAt(found, f)) !== canonical(fieldAt(expected, f)),
  );
}

/**
 * Classify the input `expected.id` against a GET /system/inputs read.
 * `recorded` is this app's KV record for the lane (null when none).
 */
export function classifyExistingInput(args: {
  readonly read: ExistingRead;
  readonly expected: Record<string, unknown>;
  readonly recorded: CriblSourceRecord | null;
}): ExistingInputVerdict {
  const { read, expected, recorded } = args;
  if (read.state === "refused") return { kind: "unknown", detail: read.detail };
  const id = String(expected["id"]);
  const found = findById(read, id);
  if (found === "malformed") return { kind: "unknown", detail: "the inputs list has an entry that is not an object" };
  if (found === null) return { kind: "absent" };
  const type = expected["type"] as CriblInputType;
  const ownership = proveOwnership(APP_ID, {
    manifestIds: isOnboardingInputId(id) ? new Set([id]) : new Set<string>(),
    object: { id, description: found["description"] },
    recordedWrite: recorded !== null && recorded.inputId === id && recorded.inputType === type,
  });
  if (!ownership.mine) return { kind: "foreign", missing: ownership.missing };
  const fields = identityDiffs(type, found, expected);
  return fields.length === 0 ? { kind: "ours-matching" } : { kind: "differs", fields };
}

/**
 * Classify the secret `secretId` against a GET /system/secrets/:id read (a 404
 * is a `read` with no items). `recorded` is this app's KV record for the lane.
 * The record is picked out by findSecretRecord, the same strict reader
 * decideSecretConflict uses (DBT-187): a non-object entry anywhere, or two
 * entries with the id, is `unknown`, never the first match.
 */
export function classifyExistingSecret(args: {
  readonly read: ExistingRead;
  readonly secretId: string;
  readonly recorded: CriblSourceRecord | null;
}): ExistingSecretVerdict {
  const { read, secretId, recorded } = args;
  if (read.state === "refused") return { kind: "unknown", detail: read.detail };
  const lookup = findSecretRecord(read.items, secretId);
  if (lookup.kind === "malformed") return { kind: "unknown", detail: `the secret read ${lookup.detail}` };
  if (lookup.kind === "missing") return { kind: "absent" };
  const ownership = proveOwnership(APP_ID, {
    manifestIds: isOnboardingSecretId(secretId) ? new Set([secretId]) : new Set<string>(),
    object: { id: secretId, description: lookup.record["description"] },
    recordedWrite: recorded !== null && recorded.secretId === secretId,
  });
  return ownership.mine ? { kind: "ours" } : { kind: "foreign", missing: ownership.missing };
}

export type LaneTopicsRefusal =
  /** A blob source has no hub. */
  | "blob-source"
  /** A source that must name its hub has none in the plan. */
  | "no-hub-named"
  /** No complete hub list has been read (Validate not run, or its read refused). */
  | "hubs-not-measured"
  /** The hub list was read and none of the expected hubs is in it yet. */
  | "no-hub-measured"
  /**
   * Another chosen lane reads the same hub. Two inputs in one consumer group
   * on one hub split its partitions, so each would see only part of the data.
   */
  | "hub-claimed";

/** Another lane chosen in the same plan, whose hubs this lane must not also read. */
export interface OtherLane {
  readonly source: OnboardingSource;
  readonly subSelection: readonly string[];
}

export type LaneTopics =
  | { readonly kind: "ok"; readonly topics: readonly string[] }
  | { readonly kind: "refused"; readonly reason: LaneTopicsRefusal; readonly detail: string };

/**
 * The hubs one lane's input reads (D9).
 *
 *   named         the emitter names its hub (Defender): that one hub
 *   auto-created  Azure creates the hubs: the expected names (or, for a policy
 *                 initiative, every hub with the insights prefix) that the last
 *                 Validate MEASURED in a fully read hub list
 *   portal        XDR: the plan's hub, and only once measured
 *
 * `measuredHubs` is null when no complete hub list has been read. An empty
 * result refuses: an input with no topics would read nothing, and one with a
 * guessed topic would read a hub that may never exist.
 *
 * NO HUB IN TWO LANES. Every input uses the plan's one consumer group, so two
 * inputs on one hub would split its partitions between them. `otherLanes` are
 * the other chosen lanes (same plan values). A hub another lane names or
 * expects is left out of a prefix-claimed lane: the initiative defers to the
 * source that names its hubs, so Entra keeps insights-logs-signinlogs. Two
 * prefix-claimed lanes with overlapping prefixes, or two lanes that name the
 * same hub, refuse `hub-claimed`, naming the other source.
 */
export function laneTopics(args: {
  readonly source: OnboardingSource;
  readonly values: PlanValues;
  readonly subSelection: readonly string[];
  readonly measuredHubs: readonly string[] | null;
  readonly otherLanes: readonly OtherLane[];
}): LaneTopics {
  const { source, values, subSelection, measuredHubs } = args;
  if (source.transport === "blob" || source.hubNaming === null) {
    return { kind: "refused", reason: "blob-source", detail: `${source.title} is read from Blob storage, not an Event Hub.` };
  }
  const others = args.otherLanes.filter(
    (o) => o.source.id !== source.id && o.source.transport === "eventhub" && o.source.hubNaming !== null,
  );
  const expected = source.expectedHubNames(values, subSelection);
  const prefix = source.autoCreatedHubPrefix?.toLowerCase() ?? null;
  const claimsPrefix = prefix !== null && expected.length === 0;
  /** Hub (lowercase) to the title of the other lane that names or expects it. */
  const namedByOthers = new Map<string, string>();
  for (const o of others) {
    const oExpected = o.source.expectedHubNames(values, o.subSelection);
    const oPrefix = o.source.autoCreatedHubPrefix?.toLowerCase() ?? null;
    if (
      claimsPrefix &&
      prefix !== null &&
      oPrefix !== null &&
      oExpected.length === 0 &&
      (oPrefix.startsWith(prefix) || prefix.startsWith(oPrefix))
    ) {
      return {
        kind: "refused",
        reason: "hub-claimed",
        detail: `${o.source.title} also reads every ${oPrefix}* hub; choose one of the two, or the hubs would be split between them.`,
      };
    }
    for (const h of oExpected) {
      if (!namedByOthers.has(h.toLowerCase())) namedByOthers.set(h.toLowerCase(), o.source.title);
    }
  }
  const clash = (topics: readonly string[]): LaneTopics | null => {
    for (const t of topics) {
      const owner = namedByOthers.get(t.toLowerCase());
      if (owner !== undefined) {
        return {
          kind: "refused",
          reason: "hub-claimed",
          detail: `${owner} also reads the hub ${t}; two inputs on one hub would split its data.`,
        };
      }
    }
    return null;
  };
  if (source.hubNaming === "named") {
    if (expected.length === 0) {
      return { kind: "refused", reason: "no-hub-named", detail: "Enter the hub name the exporter writes to." };
    }
    return clash(expected) ?? { kind: "ok", topics: [...expected] };
  }
  if (source.hubNaming === "portal" && expected.length === 0) {
    return { kind: "refused", reason: "no-hub-named", detail: "Enter the hub name chosen in the portal, then Validate." };
  }
  if (measuredHubs === null) {
    return {
      kind: "refused",
      reason: "hubs-not-measured",
      detail: "Azure creates these hubs itself; run Validate so the hubs that exist can be read.",
    };
  }
  const measured = new Map(measuredHubs.map((h) => [h.toLowerCase(), h]));
  const topics =
    claimsPrefix && prefix !== null
      ? measuredHubs.filter((h) => h.toLowerCase().startsWith(prefix) && !namedByOthers.has(h.toLowerCase()))
      : expected.flatMap((h) => {
          const hit = measured.get(h.toLowerCase());
          return hit === undefined ? [] : [hit];
        });
  if (topics.length === 0) {
    return {
      kind: "refused",
      reason: "no-hub-measured",
      detail: "No hub this source writes to has appeared in the namespace yet.",
    };
  }
  return clash(topics) ?? { kind: "ok", topics };
}
