/**
 * The worker group's EXISTING Cribl Sentinel destinations, read for a picker
 * ([[GEN-21]]).
 *
 * WHY. An operator who does not connect Azure (offline) cannot let the app
 * create or reuse a DCR, so Deploy cannot make the group's Sentinel destination
 * for them. What they usually DO have is a Sentinel destination someone already
 * built by hand in Cribl - the UAT group had exactly one, PAN-CSL, Live, and the
 * app could not offer it because it only looks for the id its own naming
 * convention would create. This module turns the group's GET /system/outputs
 * body into rows a picker can show: id, endpoint configuration, DCR, ingestion
 * endpoint, stream, and what the secret IS (never what it holds).
 *
 * A SEPARATE FILE from sentinel-destination.ts on purpose: that file builds the
 * destination the app creates and is being edited by DBT-155; this one only
 * reads destinations other people created. parseOutputListing there answers
 * "which ids exist" for the routable prerequisite check; this answers "which of
 * them are Sentinel destinations, and what do they point at".
 *
 * INVENTORY HONESTY (claude-kit standards/inventory-honesty). Three different
 * answers come back, and none of them is a bare "none":
 *   - failed  - the read failed (non-2xx) or the body is not an outputs listing.
 *               Nothing is known about the group's destinations.
 *   - read, listing `empty` - the read worked but listed no legible outputs at
 *               all. Under RBAC that is indistinguishable from "filtered out",
 *               so it is an UNVERIFIED nothing.
 *   - read, listing `none`  - outputs were listed, EVERY item was legible,
 *               and none is of type sentinel. That is a measured zero
 *               (filterListing over rows). One item that could not be read
 *               (no id, not an object) might be the Sentinel destination, so
 *               zero beside it is `empty`, not `none`.
 *
 * THE TABLE IS NOT GUESSED. A destination says which DCR stream it writes, not
 * which table: the DCR's transform decides that, and offline the app cannot
 * read the DCR. {@link SentinelOutputRow.inferredTable} is therefore set only
 * when the stream is exactly the shape a known table's stream takes
 * (`Custom-<Table>`, `Custom-<Table without _CL>`, or `Microsoft-<Table>`), and
 * null otherwise - the UAT's `Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream`
 * is null, and the operator confirms the table.
 *
 * SECRETS. No secret value, secret reference name, or client id value is
 * copied into a row. The row carries what KIND of secret the destination uses
 * ({@link SentinelSecretKind}) and whether a client id is present, because
 * those are what the picker needs to say, and anything more would put a
 * credential into UI state, logs and test snapshots.
 *
 * Pure: no IO, no fetch, no React, no Date.
 */

import {
  filterListing,
  toListing,
  type Listing,
} from "../inventory-listing/inventory-listing";
import { SENTINEL_SECRET_PLACEHOLDER } from "./sentinel-destination";

/**
 * How the destination addresses the DCR (OutputSentinel
 * endpointURLConfiguration): "ID" carries dceEndpoint + dcrID + streamName as
 * separate fields, "url" carries one composed ingestion URL. "unknown" when the
 * field is absent or holds anything else.
 */
export type SentinelEndpointMode = "ID" | "url" | "unknown";

/**
 * What the destination's client secret is, never what it holds.
 *   reference   - a `!{name}` reference to a Cribl secret, or a secret named in
 *                 `textSecret` (the secret lives in the group's secret store).
 *   embedded    - a literal value stored in the destination config itself.
 *   placeholder - the legacy "<replace me>" placeholder: nothing usable yet.
 *   absent      - no secret at all.
 */
export type SentinelSecretKind =
  | "reference"
  | "embedded"
  | "placeholder"
  | "absent";

/** One existing Sentinel destination, as a picker shows it. */
export interface SentinelOutputRow {
  /** The output id, verbatim. */
  id: string;
  mode: SentinelEndpointMode;
  /**
   * The DCR immutable id, from dcrID (ID mode) or the URL (URL mode); null when
   * the mode's own field is missing or variable-bound. Only an unknown mode
   * falls back from one to the other.
   */
  dcrID: string | null;
  /**
   * The ingestion endpoint: dceEndpoint, or (URL mode) the URL's origin; null
   * when neither is present.
   */
  dceEndpoint: string | null;
  /** The DCR stream, from streamName or (URL mode) the URL; null when neither. */
  streamName: string | null;
  /**
   * The Sentinel table, ONLY when the stream is exactly a known table's stream
   * shape (see the module comment). Null means "the operator must confirm".
   */
  inferredTable: string | null;
  /** A non-blank client_id is configured (the value is never copied). */
  clientIdPresent: boolean;
  secretKind: SentinelSecretKind;
  /**
   * A status string when the listing carried one (a string `status`, or a
   * `status.health` string); null otherwise. The vendored OutputSentinel schema
   * declares no status field, so null is the expected case.
   */
  status: string | null;
  /**
   * The fields bound to a Cribl variable (`__template_<field>`), in a fixed
   * order. A bound field's literal is overridden at runtime, so it is NOT read
   * as the destination's value: a bound dcrID / dceEndpoint / streamName / url
   * reads as null (and no table is inferred from a bound stream), a bound
   * client_id counts as present, and a bound secret is a `reference`. The
   * picker names these instead of showing a literal the destination never
   * sends with. The variable's id is not copied.
   */
  variableBound: readonly SentinelBindableField[];
}

/** The OutputSentinel fields a `__template_<field>` binding can override that a row reads. */
export type SentinelBindableField =
  | "url"
  | "dcrID"
  | "dceEndpoint"
  | "streamName"
  | "client_id"
  | "secret";

const BINDABLE_FIELDS: readonly SentinelBindableField[] = [
  "url",
  "dcrID",
  "dceEndpoint",
  "streamName",
  "client_id",
  "secret",
];

/** The result of reading the group's outputs for Sentinel destinations. */
export type SentinelOutputsResult =
  | { status: "failed"; reason: string }
  | { status: "read"; sentinel: Listing<SentinelOutputRow> };

/** The URL-mode path: /dataCollectionRules/{dcrId}/streams/{stream}. */
const DCR_URL_PATH = /\/dataCollectionRules\/([^/?#]+)\/streams\/([^/?#]+)/;

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function endpointMode(value: unknown): SentinelEndpointMode {
  if (value === "ID") return "ID";
  if (value === "url") return "url";
  return "unknown";
}

/** The scheme + host of a URL, or null when it is not one. */
function urlOrigin(url: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/.exec(url);
  return match === null ? null : (match[1] ?? null);
}

/**
 * Whether client_id names an id. Cribl documents client_id as a JavaScript
 * EXPRESSION, so the app writes it single-quoted; `''` is an empty constant.
 */
function clientIdPresent(value: unknown): boolean {
  const raw = nonBlank(value);
  if (raw === null) return false;
  return raw.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1").trim() !== "";
}

/**
 * The secret's kind. `textSecret` is how Cribl's other OAuth outputs name a
 * stored text secret; it is not in the vendored OutputSentinel schema, and
 * whether the live Sentinel destination uses it or a `!{name}` reference in
 * `secret` is not yet measured (live check L1), so both count as a reference.
 */
function secretKind(record: Record<string, unknown>): SentinelSecretKind {
  if (nonBlank(record["textSecret"]) !== null) return "reference";
  const secret = nonBlank(record["secret"]);
  if (secret === null) return "absent";
  if (secret === SENTINEL_SECRET_PLACEHOLDER) return "placeholder";
  if (/^!\{[^}]+\}$/.test(secret)) return "reference";
  return "embedded";
}

function statusOf(value: unknown): string | null {
  if (typeof value === "string") return nonBlank(value);
  if (typeof value === "object" && value !== null) {
    return nonBlank((value as Record<string, unknown>)["health"]);
  }
  return null;
}

/**
 * The table a stream names, when it is exactly a known table's stream shape:
 * `Custom-<Table>`, `Custom-<Table without _CL>` (pipeline-generation's
 * streamName rule, which this cannot import without a module cycle), or
 * `Microsoft-<Table>`. Exact and case-sensitive. When two known tables claim
 * the same stream (Foo and Foo_CL both answer Custom-Foo) the answer is null:
 * a guess between two is still a guess.
 */
function inferTableFromStream(
  stream: string | null,
  knownTables: readonly string[],
): string | null {
  if (stream === null) return null;
  const matches = new Set<string>();
  for (const table of knownTables) {
    if (
      stream === `Custom-${table}` ||
      stream === `Custom-${table.replace(/_CL$/i, "")}` ||
      stream === `Microsoft-${table}`
    ) {
      matches.add(table);
    }
  }
  if (matches.size !== 1) return null;
  const [only] = matches;
  return only ?? null;
}

function toRow(
  record: Record<string, unknown>,
  id: string,
  knownTables: readonly string[],
): SentinelOutputRow {
  const variableBound = BINDABLE_FIELDS.filter(
    (field) => nonBlank(record[`__template_${field}`]) !== null,
  );
  const bound = (field: SentinelBindableField) => variableBound.includes(field);
  // A bound field's literal is not what the destination sends with.
  const literal = (field: SentinelBindableField) =>
    bound(field) ? null : nonBlank(record[field]);

  const mode = endpointMode(record["endpointURLConfiguration"]);
  const url = literal("url");
  const fromUrl = url === null ? null : DCR_URL_PATH.exec(url);
  const urlParts = {
    dcrID: fromUrl?.[1] ?? null,
    streamName: fromUrl?.[2] ?? null,
    dceEndpoint: url === null ? null : urlOrigin(url),
  };
  const fieldParts = {
    dcrID: literal("dcrID"),
    streamName: literal("streamName"),
    dceEndpoint: literal("dceEndpoint"),
  };
  // The endpoint configuration decides which half Cribl sends with. The other
  // half can hold values left over from before the mode was switched, so a
  // known mode reads ONLY its own half: a URL-mode destination with a stale
  // streamName shows the URL's stream, and a bound or missing value in the
  // mode's own half is null rather than a leftover. Only an unknown mode falls
  // back from the fields to the URL.
  const parts =
    mode === "url"
      ? urlParts
      : mode === "ID"
        ? fieldParts
        : {
            dcrID: fieldParts.dcrID ?? urlParts.dcrID,
            streamName: fieldParts.streamName ?? urlParts.streamName,
            dceEndpoint: fieldParts.dceEndpoint ?? urlParts.dceEndpoint,
          };
  return {
    id,
    mode,
    dcrID: parts.dcrID,
    dceEndpoint: parts.dceEndpoint,
    streamName: parts.streamName,
    inferredTable: inferTableFromStream(parts.streamName, knownTables),
    clientIdPresent: bound("client_id") || clientIdPresent(record["client_id"]),
    secretKind: bound("secret") ? "reference" : secretKind(record),
    status: statusOf(record["status"]),
    variableBound,
  };
}

/**
 * Read a GET /system/outputs response (worker group context) into the group's
 * Sentinel destinations.
 *
 * `knownTables` are the table names the app can name (the schema catalog's
 * native tables plus any custom tables in play); they only drive
 * {@link SentinelOutputRow.inferredTable}.
 */
export function parseSentinelOutputs(
  response: { status: number; body: unknown },
  knownTables: readonly string[],
): SentinelOutputsResult {
  if (response.status < 200 || response.status >= 300) {
    return {
      status: "failed",
      reason: `The outputs listing returned HTTP ${response.status}.`,
    };
  }
  const body = response.body;
  const items =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)["items"]
      : undefined;
  if (!Array.isArray(items)) {
    return {
      status: "failed",
      reason: "The outputs listing was not an {items: [...]} response.",
    };
  }

  // Every legible output first, so the Sentinel filter below runs over a REAL
  // read: zero Sentinel rows out of some outputs is a measured `none`; zero out
  // of nothing stays an unverified `empty`.
  const legible: Array<{ record: Record<string, unknown>; id: string }> = [];
  let illegible = 0;
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      illegible += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    // Verbatim, not trimmed: a route or a pick must name the exact id.
    const id = nonBlank(record["id"]) === null ? null : (record["id"] as string);
    if (id === null) illegible += 1;
    else legible.push({ record, id });
  }

  const sentinelRows = legible
    .filter(({ record }) => record["type"] === "sentinel")
    .map(({ record, id }) => toRow(record, id, knownTables));

  // A measured zero needs EVERY item read: an item this could not read may be
  // the Sentinel destination, so zero Sentinel rows beside one is unverified,
  // never `none`. (Rows that were read are still offered.)
  if (sentinelRows.length === 0 && illegible > 0) {
    return { status: "read", sentinel: { kind: "empty" } };
  }
  return {
    status: "read",
    sentinel: filterListing(toListing(legible), sentinelRows),
  };
}
