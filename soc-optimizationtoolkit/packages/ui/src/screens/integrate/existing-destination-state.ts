/**
 * The existing-destination path's PURE decisions ([[GEN-21]]), kept beside
 * integrate-screen-state.ts and out of the component so each can be pinned
 * without mounting a screen whose build needs an approved gap analysis.
 *
 * THE PATH. An operator who does not connect Azure (offline) cannot let Deploy
 * create a DCR or the Cribl Sentinel destination that sends to it. What they
 * usually have instead is a Sentinel destination someone built by hand in the
 * worker group. Choosing it makes the run Cribl-only: the pack is built
 * ROUTABLE (it ships no destination and hands its events back to the group),
 * it is installed, and a group route sends the source through the pack to the
 * chosen destination. Nothing in Azure is read or written.
 *
 * DECIDED 2026-10-29 (board GEN-21): connecting the source is ROUTE ONLY, and
 * the app shows the route rather than writing it - the operator adds it by hand
 * while the app's own wiring writer still commits the whole group unscoped and
 * names the source by its bare id. A QuickConnected source is warned about,
 * never rewritten.
 *
 * INVENTORY HONESTY (claude-kit standards/inventory-honesty). The picker's
 * listing has four non-row answers - not read yet, failed, an unverified empty,
 * and a measured none - and each gets its own sentence. None of them is a bare
 * "none".
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import {
  checkRoutablePrerequisites,
  crblFileName,
  inputRouteFilter,
  normalizeInput,
  parseOutputListing,
  packIdFromCrblFileName,
  parseSentinelOutputs,
} from "@soc/core";
import type {
  CriblOptions,
  InputIdRef,
  SentinelBindableField,
  SentinelOutputRow,
} from "@soc/core";

/**
 * Where the pack's events go: a destination Deploy creates (`create`, the
 * native path that needs Azure), or one that already exists in the worker
 * group (`existing`, Cribl-only).
 */
export type DestinationMode = "create" | "existing";

/**
 * The mode the page opens in. Both are always offered (decision F2-c); an
 * offline operator - no Azure identity - starts on `existing`, because the
 * create path cannot finish for them and the existing one can.
 */
export function initialDestinationMode(offline: boolean): DestinationMode {
  return offline ? "existing" : "create";
}

/** The picker's read of the group's outputs, as the component holds it. */
export type ExistingOutputsRead =
  | { state: "idle" }
  | { state: "loading"; groupId: string }
  /** The request itself threw: no response at all. */
  | { state: "error"; groupId: string; error: string }
  | { state: "done"; groupId: string; response: { status: number; body: unknown } };

/** What the picker shows, derived from the read. */
export interface ExistingPickerView {
  kind: "idle" | "loading" | "failed" | "empty" | "none" | "rows";
  /** The sentence for the listing, whatever its kind. Never a bare "none". */
  text: string;
  /** The Sentinel destinations to pick from; empty unless kind is `rows`. */
  rows: readonly SentinelOutputRow[];
  /**
   * Every output id the read listed, Sentinel or not - the routable
   * prerequisite check's input. Empty unless the read succeeded.
   */
  outputIds: readonly string[];
}

/**
 * The picker's view of a read. `knownTables` only drives each row's
 * inferredTable (see core existing-outputs.ts); passing the detected tables
 * here, rather than at read time, means a new gap analysis re-infers without
 * reading Cribl again.
 *
 * `currentGroupId` is the group selected NOW. A read for any other group is
 * the previous group's answer, still held for the render between a group
 * change and the effect that re-reads: it is shown as reading the new group,
 * never as the new group's destinations (its rows would otherwise satisfy the
 * gate for one render with ids from the wrong group).
 */
export function existingPickerView(
  read: ExistingOutputsRead,
  knownTables: readonly string[],
  currentGroupId: string,
): ExistingPickerView {
  const blank = { rows: [], outputIds: [] };
  const idle: ExistingPickerView = {
    kind: "idle",
    text: "Not read yet - select a worker group in this section to read its destinations.",
    ...blank,
  };
  if (read.state === "idle") return idle;
  if (read.groupId !== currentGroupId) {
    return currentGroupId === ""
      ? idle
      : { kind: "loading", text: `Reading ${currentGroupId}'s destinations...`, ...blank };
  }
  const group = read.groupId;
  if (read.state === "loading") {
    return { kind: "loading", text: `Reading ${group}'s destinations...`, ...blank };
  }
  const failed = (reason: string): ExistingPickerView => ({
    kind: "failed",
    text:
      `Could not read ${group}'s destinations: ${reason} Nothing is known about ` +
      "which Sentinel destinations it has - read again before deciding there are none.",
    ...blank,
  });
  if (read.state === "error") return failed(read.error);
  const parsed = parseSentinelOutputs(read.response, knownTables);
  if (parsed.status === "failed") return failed(parsed.reason);
  const outputIds = parseOutputListing(read.response.body).map((o) => o.id);
  const listing = parsed.sentinel;
  if (listing.kind === "empty") {
    return {
      kind: "empty",
      text:
        `${group} listed no destinations this app could read. A Cribl role that ` +
        "cannot see a group's destinations receives exactly this, so it is not " +
        `confirmation that ${group} has none.`,
      rows: [],
      outputIds,
    };
  }
  if (listing.kind === "none") {
    // EARNED: every listed output was read, and none is a Sentinel one.
    const n = outputIds.length;
    return {
      kind: "none",
      text:
        `${group} has ${String(n)} destination${n === 1 ? "" : "s"}, and none is ` +
        "a Microsoft Sentinel destination. Create one in Cribl and read again, or " +
        "let Deploy create one.",
      rows: [],
      outputIds,
    };
  }
  const n = listing.rows.length;
  return {
    kind: "rows",
    text: `${String(n)} Microsoft Sentinel destination${n === 1 ? "" : "s"} in ${group}.`,
    rows: listing.rows,
    outputIds,
  };
}

/** A row field's value, or what stands in its place - never a blank. */
function fieldText(
  row: SentinelOutputRow,
  value: string | null,
  field: SentinelBindableField,
): string {
  if (value !== null) return value;
  return row.variableBound.includes(field)
    ? "(set by a Cribl variable)"
    : "(not readable)";
}

/** One picker row: id, stream and DCR - never a secret or a client id. */
export function describeOutputRow(row: SentinelOutputRow): string {
  return (
    `${row.id} - stream ${fieldText(row, row.streamName, "streamName")}, ` +
    `DCR ${fieldText(row, row.dcrID, "dcrID")}`
  );
}

/** One table's pick, resolved against the current listing. */
export interface TablePick {
  table: string;
  /** The picked destination, or null when none is picked or it is not listed. */
  row: SentinelOutputRow | null;
  /**
   * The operator must confirm the pick feeds this table: its stream does not
   * name this table (a custom stream infers nothing; another table's stream
   * names the wrong one).
   */
  needsConfirm: boolean;
  /** No confirmation is needed, or the operator gave one for THIS pick. */
  confirmed: boolean;
  /** The confirmation's sentence, naming the stream; null when none is needed. */
  prompt: string | null;
}

/**
 * Resolve one table's pick. A confirmation is recorded against the destination
 * id it was given for, so picking a different destination asks again.
 */
export function tablePick(
  table: string,
  chosenId: string,
  confirmedId: string,
  rows: readonly SentinelOutputRow[],
): TablePick {
  const row = chosenId === "" ? null : (rows.find((r) => r.id === chosenId) ?? null);
  if (row === null) {
    return { table, row: null, needsConfirm: false, confirmed: false, prompt: null };
  }
  const needsConfirm = row.inferredTable !== table;
  const stream = fieldText(row, row.streamName, "streamName");
  const prompt = !needsConfirm
    ? null
    : row.inferredTable === null
      ? `${row.id} sends to stream ${stream}, which does not name a table, so the ` +
        `app cannot tell which table it feeds. Confirm that its Data Collection ` +
        `Rule writes ${table}.`
      : `${row.id} sends to stream ${stream}, which is ${row.inferredTable}'s ` +
        `stream, not ${table}'s. Confirm only if its Data Collection Rule turns ` +
        `it into ${table}.`;
  return {
    table,
    row,
    needsConfirm,
    confirmed: !needsConfirm || confirmedId === row.id,
    prompt,
  };
}

/** Inputs to {@link existingDestinationGateReason}. */
export interface ExistingGateInput {
  groupId: string;
  /** The Sentinel tables the pack routes (the gap analysis' detected tables). */
  tables: readonly string[];
  view: ExistingPickerView;
  chosen: Readonly<Record<string, string>>;
  confirmed: Readonly<Record<string, string>>;
  /** Deploy's destination naming, for the routable prerequisite check. */
  naming?: CriblOptions;
}

/**
 * The single unlock condition on the existing path, in dependency order, or
 * null when the pick is complete. Never mentions a client id, a scope or a
 * directory: none of them is needed here.
 */
export function existingDestinationGateReason(input: ExistingGateInput): string | null {
  const { groupId, tables, view, chosen, confirmed } = input;
  if (groupId === "") {
    return "Select a worker group in Configure Cribl - the existing destination is read from it.";
  }
  if (tables.length === 0) {
    return "Run the DCR Gap Analysis (section 3) - its tables decide what the existing destination must feed.";
  }
  if (view.kind !== "rows") {
    return view.kind === "loading"
      ? `Reading ${groupId}'s destinations...`
      : `No Sentinel destination to pick in ${groupId} yet: ${view.text}`;
  }
  const picks = tables.map((t) =>
    tablePick(t, chosen[t] ?? "", confirmed[t] ?? "", view.rows),
  );
  // A pick the latest read no longer lists is reported by the core check the
  // native path uses, counting the chosen id instead of the convention one.
  const report = checkRoutablePrerequisites(tables, view.outputIds, input.naming, chosen);
  const vanished = report.missing.find((m) => m.chosen);
  if (vanished !== undefined) {
    return (
      `${vanished.expectedId}, chosen for ${vanished.sentinelTable}, is not in ` +
      `${groupId}'s latest listing - pick again in Configure Cribl.`
    );
  }
  const unpicked = picks.find((p) => p.row === null);
  if (unpicked !== undefined) {
    return `Pick an existing Sentinel destination for ${unpicked.table} in Configure Cribl.`;
  }
  const unconfirmed = picks.find((p) => !p.confirmed);
  if (unconfirmed !== undefined && unconfirmed.row !== null) {
    return `Confirm in Configure Cribl that ${unconfirmed.row.id} feeds ${unconfirmed.table}.`;
  }
  if (new Set(picks.map((p) => p.row?.id)).size > 1) {
    return (
      "Pick the same destination for every table: the routable pack hands all " +
      "its events back to one group route, and one route sends to one destination."
    );
  }
  return null;
}

/**
 * The picked destination for the integrate arc's `existingDestination`, or
 * undefined until every table has one. One id - the gate refuses two.
 */
export function existingDestinationForArc(
  mode: DestinationMode,
  tables: readonly string[],
  chosen: Readonly<Record<string, string>>,
): string | undefined {
  if (mode !== "existing" || tables.length === 0) return undefined;
  const ids = tables.map((t) => (chosen[t] ?? "").trim());
  if (ids.some((id) => id === "")) return undefined;
  return [...new Set(ids)].join(", ");
}

/** A Cribl group route, as the operator adds it on the Data Routes page. */
export interface GroupRoute {
  id: string;
  name: string;
  filter: string;
  pipeline: string;
  output: string;
  final: boolean;
  description: string;
}

/**
 * The group route that sends one source through the pack to the chosen
 * destination: `<source predicate> -> pack:<pack id> -> <destination>`. Final,
 * because the routable pack hands every event back and nothing after it should
 * receive them a second time.
 */
export function existingDestinationRoute(input: {
  source: InputIdRef;
  packId: string;
  destinationId: string;
}): GroupRoute {
  const { source, packId, destinationId } = input;
  return {
    id: `${packId}_${source.id}`,
    name: `${source.id} to ${destinationId} via ${packId}`,
    filter: inputRouteFilter(source),
    pipeline: `pack:${packId}`,
    output: destinationId,
    final: true,
    description: `Sends ${source.id} through pack ${packId} to the existing Sentinel destination ${destinationId}.`,
  };
}

/**
 * The id Cribl installs a pack under, for a pack name: the name as the build
 * writes it into the .crbl file name (characters outside [A-Za-z0-9_.-]
 * become "-") with the version stripped, exactly as the install pins it. The
 * route names `pack:<this>`, so before the pack is installed this - not the
 * typed name - is what the route has to say ("Palo Alto" installs as
 * "Palo-Alto"). The version is a stand-in: it is stripped again.
 */
export function expectedPackId(packName: string): string {
  return packIdFromCrblFileName(crblFileName(packName.trim(), "0.0.0"));
}

/** How the source sends its events, read from GET /system/inputs/:id. */
export type SourceRouting =
  | { kind: "routes" }
  | { kind: "quickconnect"; outputs: readonly string[] }
  | { kind: "unknown"; reason: string };

/**
 * Whether the source sends to routes or is QuickConnected. A QuickConnected
 * source (`sendToRoutes: false`) never reaches a group route, so the route this
 * path shows would not fire - the operator has to be told before adding it.
 */
export function sourceRouting(response: { status: number; body: unknown }): SourceRouting {
  if (response.status < 200 || response.status >= 300) {
    return { kind: "unknown", reason: `Cribl returned HTTP ${String(response.status)} reading the source.` };
  }
  const body = response.body;
  const items =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)["items"]
      : undefined;
  const first: unknown = Array.isArray(items) ? items[0] : body;
  const input = normalizeInput(first, false);
  if (input === null) {
    return { kind: "unknown", reason: "The source read did not hold a source." };
  }
  return input.sendToRoutes
    ? { kind: "routes" }
    : { kind: "quickconnect", outputs: input.connections.map((c) => c.output) };
}

/**
 * The sentence for a source's routing, or null when it sends to routes (the
 * route will fire; nothing to warn about).
 */
export function sourceRoutingNotice(sourceId: string, routing: SourceRouting): string | null {
  if (routing.kind === "routes") return null;
  if (routing.kind === "unknown") {
    return (
      `Could not tell whether ${sourceId} sends to routes (${routing.reason}) - ` +
      "check that it is not QuickConnected before relying on this route."
    );
  }
  const to =
    routing.outputs.length === 0 ? "" : ` (to ${routing.outputs.join(", ")})`;
  return (
    `${sourceId} is QuickConnected${to}, so it does not send to routes: this ` +
    "route will not fire until the source is switched to send to routes. The " +
    "app does not change the source's QuickConnect flow."
  );
}

/**
 * The Deploy client-id field's hint (DBT-200). The default exists only when
 * the connection carries an identity - offline there is nothing to default to,
 * and saying otherwise sent the operator looking for a value that is not there.
 */
export function ingestionClientIdHint(identityPresent: boolean): string {
  return identityPresent
    ? "Defaults to the active connection."
    : "No Azure identity is connected, so there is no default - enter the app registration's client id.";
}

/**
 * The worker group the pack should default to once the samples' capture group
 * is known (DBT-201): that group, when it is in the live list and the operator
 * has not picked one; otherwise null (leave the selection alone).
 */
export function captureGroupDefault(input: {
  liveGroupIds: readonly string[];
  captureGroup: string | undefined;
  current: string;
  touched: boolean;
}): string | null {
  const { liveGroupIds, captureGroup, current, touched } = input;
  if (touched || captureGroup === undefined || captureGroup === "") return null;
  if (captureGroup === current || !liveGroupIds.includes(captureGroup)) return null;
  return captureGroup;
}
