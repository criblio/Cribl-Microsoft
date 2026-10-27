/**
 * Options read - the PURE decision behind the shell's appOptions entry: what
 * the boot read of the stored options means, and whether an inline edit may
 * be saved over it (DBT-158).
 *
 * The @soc/core option-forms module owns the codec (parseAppOptions /
 * serializeAppOptions). This module owns the one fact the codec cannot know:
 * whether the read ANSWERED. parseAppOptions is tolerant on purpose - null,
 * junk and a failed read all parse to the defaults - and the shell used to
 * feed it a failed read as null. The next inline save (the Integrate page's
 * DCE toggle) then serialized the WHOLE options document from those defaults
 * and PUT it over the operator's real options. A refused or failed read is
 * unknown, never none (the inventory-honesty rule), so it gets its own state:
 *
 *   - "loading"    the read has not settled; saving is refused.
 *   - "absent"     the read answered "never written" (404, or a blank value);
 *                  the defaults ARE the operator's options, saving is fine.
 *   - "loaded"     the read answered with a record; saving edits that record.
 *   - "unreadable" the read was refused or failed (a non-encrypted 403 since
 *                  DBT-145, a 5xx, a timeout, a bridge error). The entry may
 *                  well exist, so saving is REFUSED until a later read
 *                  answers. The defaults it carries are for rendering only.
 *
 * Which answers reject is the adapter's half, not decided here:
 * PlatformSecretsStore.get resolves null for a 404 and the encrypted-value
 * 403, and rejects everything else (DBT-145).
 *
 * Pure: no IO, no fetch, no React.
 */

import { DEFAULT_APP_OPTIONS, parseAppOptions, serializeAppOptions } from "@soc/core";
import type { AppOptions } from "@soc/core";

/** The shell's options, together with what the read that produced them said. */
export type OptionsRead =
  | { state: "loading"; options: AppOptions }
  | { state: "absent"; options: AppOptions }
  | { state: "loaded"; options: AppOptions }
  | { state: "unreadable"; options: AppOptions; detail: string };

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

const OPTIONS_LOADING_NOTICE =
  "Your saved deployment options are still loading; try again in a moment.";

/**
 * Turn the settled boot (or retry) read of the appOptions entry into an
 * {@link OptionsRead}. A fulfilled null or blank value is "absent"; any other
 * fulfilled value is "loaded" (parsed tolerantly); a REJECTED read is
 * "unreadable", never absent (DBT-158).
 */
export function optionsReadFromSettled(read: PromiseSettledResult<string | null>): OptionsRead {
  if (read.status === "rejected") {
    const reason: unknown = read.reason;
    return {
      state: "unreadable",
      options: DEFAULT_APP_OPTIONS,
      detail: reason instanceof Error ? reason.message : String(reason),
    };
  }
  if (read.value === null || read.value.trim() === "") {
    return { state: "absent", options: DEFAULT_APP_OPTIONS };
  }
  return { state: "loaded", options: parseAppOptions(read.value) };
}

/**
 * The read after a successful save: what was just written is now the known
 * stored record.
 */
export function optionsReadFromSave(serialized: string): OptionsRead {
  return { state: "loaded", options: parseAppOptions(serialized) };
}

/** Whether an inline save may run: the serialized document to PUT, or why not. */
export type OptionsSavePlan =
  | { kind: "write"; serialized: string }
  | { kind: "refused"; reason: string };

/**
 * Decide an inline options save. Only a read that ANSWERED ("absent" or
 * "loaded") may be saved over: the edit applies to the options that read
 * returned. While "loading" or "unreadable" the save is refused and there is
 * nothing to write - the caller must not PUT.
 */
export function planOptionsSave(
  read: OptionsRead,
  edit: (options: AppOptions) => AppOptions,
): OptionsSavePlan {
  if (read.state === "unreadable") {
    return { kind: "refused", reason: OPTIONS_UNREADABLE_NOTICE };
  }
  if (read.state === "loading") {
    return { kind: "refused", reason: OPTIONS_LOADING_NOTICE };
  }
  return { kind: "write", serialized: serializeAppOptions(edit(read.options)) };
}
