/**
 * Options read - the PURE decision behind the shell's appOptions entry: what
 * the boot read of the stored options means, whether an inline edit may be
 * saved over it, what that save writes, and what a failed save leaves behind
 * (DBT-158, DBT-172, DBT-173).
 *
 * The @soc/core option-forms module owns the codec (parseAppOptions /
 * serializeAppOptions / applyOptionsPatch). This module owns the one fact the
 * codec cannot know: whether the read ANSWERED. parseAppOptions is tolerant
 * on purpose - null, junk and a failed read all parse to the defaults - and
 * the shell used to feed it a failed read as null. The next inline save (the
 * Integrate page's DCE toggle) then serialized the WHOLE options document
 * from those defaults and PUT it over the operator's real options. A refused
 * or failed read is unknown, never none (the inventory-honesty rule), so it
 * gets its own state:
 *
 *   - "loading"    the boot read has not settled; saving is refused.
 *   - "absent"     the read answered "never written" (404, or a blank value);
 *                  the defaults ARE the operator's options, saving is fine.
 *   - "loaded"     the read answered with a record; saving PATCHES that
 *                  record, which is kept raw for the purpose (below).
 *   - "unreadable" the read was refused or failed (a non-encrypted 403 since
 *                  DBT-145, a 5xx, a timeout, a bridge error). The entry may
 *                  well exist, so saving is REFUSED until a later read
 *                  answers. The defaults it carries are for rendering only.
 *                  `failures` counts the failed reads in a row, so a failed
 *                  retry is visibly a NEW failure, not the old notice.
 *   - "retrying"   an operator retry of an unreadable read is in flight
 *                  (DBT-173). Saving is still refused, and a second retry is
 *                  not started ({@link beginOptionsRetry} returns null).
 *
 * The save is a PATCH, not a rewrite (DBT-172). serializeAppOptions writes
 * exactly the managed fields, so saving through it deleted every key the
 * codec does not manage - legacy `_comments`, a section a newer app version
 * wrote - on every toggle. The loaded read keeps the raw stored string and
 * {@link planOptionsSave} applies the edit to it through applyOptionsPatch,
 * narrowed to the fields that actually changed (the edit arrives as a whole
 * parsed section, whose untouched fields may be defaults the record never
 * held); an absent read patches the complete defaults.
 *
 * A save that FAILS changes nothing stored, so the read stays what it was
 * and the operator is told in plain words ({@link settleOptionsSave},
 * DBT-173); the screen's controlled toggle renders from the read, so it
 * shows the stored value again.
 *
 * Which answers reject is the adapter's half, not decided here:
 * PlatformSecretsStore.get resolves null for a 404 and the encrypted-value
 * 403, and rejects everything else (DBT-145).
 *
 * Pure: no IO, no fetch, no React.
 */

import { DEFAULT_APP_OPTIONS, applyOptionsPatch, parseAppOptions } from "@soc/core";
import type { AppOptions, AppOptionsPatch } from "@soc/core";

/** The shell's options, together with what the read that produced them said. */
export type OptionsRead =
  | { state: "loading"; options: AppOptions }
  | { state: "absent"; options: AppOptions }
  | { state: "loaded"; options: AppOptions; raw: string }
  | { state: "unreadable"; options: AppOptions; detail: string; failures: number }
  | { state: "retrying"; options: AppOptions; detail: string; failures: number };

/** The state before the boot read settles. */
export const OPTIONS_LOADING: OptionsRead = { state: "loading", options: DEFAULT_APP_OPTIONS };

/**
 * What the operator is told while the stored options cannot be read: what
 * failed, what is being withheld and why, and what to do. The shell renders
 * it beside a retry.
 */
export const OPTIONS_UNREADABLE_NOTICE =
  "Could not read your saved deployment options: the app key-value store refused or did not " +
  "answer. The values shown are the defaults, not your saved options, so changes are not " +
  "saved - saving now would overwrite your saved options with the defaults. Retry when the " +
  "leader is reachable.";

/**
 * What the operator is told when an inline save's PUT failed (DBT-173): the
 * change did not land, the toggle shows the stored value again, and what to
 * do. {@link settleOptionsSave} appends the failure's own detail.
 */
export const OPTIONS_SAVE_FAILED_NOTICE =
  "Could not save your deployment option: the app key-value store refused or did not answer, " +
  "so the change was NOT saved. The value shown is still your saved option. Try the change " +
  "again when the leader is reachable.";

const OPTIONS_LOADING_NOTICE =
  "Your saved deployment options are still loading; try again in a moment.";

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Turn the settled boot (or retry) read of the appOptions entry into an
 * {@link OptionsRead}. A fulfilled null or blank value is "absent"; any other
 * fulfilled value is "loaded" (parsed tolerantly, raw kept for the patch); a
 * REJECTED read is "unreadable", never absent (DBT-158). `previous` is the
 * read this one replaces: when it was a retry in flight, a rejection counts
 * as one more failure in a row (DBT-173).
 */
export function optionsReadFromSettled(
  read: PromiseSettledResult<string | null>,
  previous?: OptionsRead,
): OptionsRead {
  if (read.status === "rejected") {
    const before = previous?.state === "retrying" ? previous.failures : 0;
    return {
      state: "unreadable",
      options: DEFAULT_APP_OPTIONS,
      detail: reasonText(read.reason),
      failures: before + 1,
    };
  }
  if (read.value === null || read.value.trim() === "") {
    return { state: "absent", options: DEFAULT_APP_OPTIONS };
  }
  return { state: "loaded", options: parseAppOptions(read.value), raw: read.value };
}

/**
 * The read after a successful save: what was just written is now the known
 * stored record.
 */
export function optionsReadFromSave(serialized: string): OptionsRead {
  return { state: "loaded", options: parseAppOptions(serialized), raw: serialized };
}

/**
 * Start an operator retry of an unreadable read: the "retrying" state to
 * hold while the read is in flight, or null when no retry should start - one
 * is already in flight (a double click), or the read already answered.
 */
export function beginOptionsRetry(read: OptionsRead): OptionsRead | null {
  if (read.state !== "unreadable") {
    return null;
  }
  return { state: "retrying", options: read.options, detail: read.detail, failures: read.failures };
}

/**
 * The line that makes a failed RETRY visibly new (DBT-173): null on the
 * first failure (the unreadable notice says it all) and for a read that is
 * not failing; after that, how many reads failed in a row and the latest
 * reason. Kept up while that failure is itself being retried.
 */
export function optionsReadFailureLine(read: OptionsRead): string | null {
  if ((read.state !== "unreadable" && read.state !== "retrying") || read.failures < 2) {
    return null;
  }
  return `The retry failed too (${read.failures} failed reads in a row): ${read.detail}`;
}

/** Whether an inline save may run: the serialized document to PUT, or why not. */
export type OptionsSavePlan =
  | { kind: "write"; serialized: string }
  | { kind: "refused"; reason: string };

function isJsonObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Decide an inline options save. Only a read that ANSWERED ("absent" or
 * "loaded") may be saved over. The patch is applied to the STORED document
 * (DBT-172): a loaded read's raw record, so every key the codec does not
 * manage survives, or the complete defaults when the entry was never
 * written (or holds something that is not a JSON object, which parsed to the
 * defaults the screen shows). While "loading", "unreadable" or "retrying"
 * the save is refused and there is nothing to write - the caller must not
 * PUT.
 */
export function planOptionsSave(read: OptionsRead, patch: AppOptionsPatch): OptionsSavePlan {
  if (read.state === "unreadable" || read.state === "retrying") {
    return { kind: "refused", reason: OPTIONS_UNREADABLE_NOTICE };
  }
  if (read.state === "loading") {
    return { kind: "refused", reason: OPTIONS_LOADING_NOTICE };
  }
  if (read.state === "loaded" && isJsonObject(read.raw)) {
    const changed = changedFields(read.options, patch);
    return { kind: "write", serialized: JSON.stringify(applyOptionsPatch(read.raw, changed)) };
  }
  return { kind: "write", serialized: JSON.stringify(applyOptionsPatch(read.options, patch)) };
}

/**
 * Narrow a patch to the fields whose value differs from what the screen
 * showed. The inline edit hands over a whole PARSED section, so a field the
 * record never held (an older version wrote it) or held as junk arrives as
 * its default; patching those into the raw record would freeze today's
 * defaults into it and overwrite values the operator never touched.
 */
function changedFields(shown: AppOptions, patch: AppOptionsPatch): AppOptionsPatch {
  const narrowed: AppOptionsPatch = {};
  if (patch.operation !== undefined) {
    const operation = Object.fromEntries(
      Object.entries(patch.operation).filter(
        ([key, value]) => shown.operation[key as keyof AppOptions["operation"]] !== value,
      ),
    );
    narrowed.operation = operation;
  }
  if (patch.cribl !== undefined) {
    const cribl = Object.fromEntries(
      Object.entries(patch.cribl).filter(
        ([key, value]) => shown.cribl[key as keyof AppOptions["cribl"]] !== value,
      ),
    );
    narrowed.cribl = cribl;
  }
  return narrowed;
}

/** What a settled inline save leaves: the read to hold, and what to tell the operator. */
export interface OptionsSaveOutcome {
  read: OptionsRead;
  notice: string | null;
}

/**
 * Settle an inline save's PUT (DBT-173). Fulfilled: what was written is the
 * loaded read. Rejected: nothing stored changed, so the read is returned
 * EXACTLY as it was - never "loaded" with the unsaved edit - and the notice
 * says the change was not saved, with the failure's own detail.
 */
export function settleOptionsSave(
  current: OptionsRead,
  serialized: string,
  result: PromiseSettledResult<unknown>,
): OptionsSaveOutcome {
  if (result.status === "fulfilled") {
    return { read: optionsReadFromSave(serialized), notice: null };
  }
  return { read: current, notice: `${OPTIONS_SAVE_FAILED_NOTICE} (${reasonText(result.reason)})` };
}
