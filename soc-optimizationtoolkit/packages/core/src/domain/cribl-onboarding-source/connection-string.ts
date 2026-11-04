/**
 * A pasted Event Hub connection string, reduced to a NON-SECRET descriptor
 * (AZR-34, ADR 0007 D7).
 *
 * The descriptor - host, key name, entity path - is what reaches the plan,
 * React state and the confirm text. The SharedAccessKey never leaves the
 * caller's closure: {@link parseEventHubConnectionString} reads it only to
 * check it is present and does not return it, not even on an invalid string.
 *
 * {@link checkPastedCredential} refuses BEFORE any write when the paste cannot
 * be the credential the lane needs: another namespace, a rule the namespace
 * does not list, a rule without Listen, a Manage-capable rule (AZR-58) (a Cribl SOURCE reads, so the
 * Defender export's Send rule is not enough), or an EntityPath for a hub the
 * lane does not read. When the rules list itself could not be read the rights
 * are UNKNOWN, never assumed; only an explicit operator attestation passes it,
 * and the confirm then names that attestation.
 *
 * Pure: no IO, no Date, no randomness, no crypto.
 */

import {
  ROOT_MANAGE_RULE_NAME,
  ruleCanListen,
  ruleCanManage,
  type NamespaceAuthRule,
} from "../eventhub-arm";
import type { ListRead } from "../logging-map/list-read";

/** What a connection string says, minus its key. */
export interface ConnectionDescriptor {
  /** Lower-cased, e.g. `ns1.servicebus.windows.net`. */
  readonly host: string;
  /** SharedAccessKeyName, as written. */
  readonly keyName: string;
  /** EntityPath, when the string is scoped to one hub. */
  readonly entityPath?: string;
}

export type InvalidConnectionReason =
  | "empty"
  | "malformed"
  | "no-endpoint"
  | "no-key-name"
  | "no-key";

export type ParsedConnection = ConnectionDescriptor | { readonly invalid: InvalidConnectionReason };

export function isInvalidConnection(
  p: ParsedConnection,
): p is { readonly invalid: InvalidConnectionReason } {
  return "invalid" in p;
}

/**
 * Parse `Endpoint=sb://{host}/;SharedAccessKeyName=...;SharedAccessKey=...[;EntityPath=...]`.
 * Keys are matched case-insensitively; a value may contain `=` (base64
 * padding), so each segment splits on its FIRST `=` only.
 */
export function parseEventHubConnectionString(s: string): ParsedConnection {
  const text = s.trim();
  if (text === "") return { invalid: "empty" };
  const fields = new Map<string, string>();
  for (const segment of text.split(";")) {
    if (segment.trim() === "") continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) return { invalid: "malformed" };
    fields.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim());
  }
  const endpoint = fields.get("endpoint") ?? "";
  const match = /^sb:\/\/([^/\s]+)\/?$/i.exec(endpoint);
  if (match === null) return { invalid: "no-endpoint" };
  const keyName = fields.get("sharedaccesskeyname") ?? "";
  if (keyName === "") return { invalid: "no-key-name" };
  if ((fields.get("sharedaccesskey") ?? "") === "") return { invalid: "no-key" };
  const entityPath = fields.get("entitypath") ?? "";
  const host = match[1]!.toLowerCase();
  return entityPath === "" ? { host, keyName } : { host, keyName, entityPath };
}

/**
 * Whether a value pasted as a CLIENT SECRET (Entra ID or Blob) is really a
 * key-bearing connection string: an Event Hub or Service Bus string (the
 * RootManageSharedAccessKey one included), a storage account string, or a
 * SAS. Such a value is never stored as a client secret (AZR-59 review): the
 * source could not sign in with it, and the key would sit in the worker
 * group's secrets. Never returns or echoes any part of the value.
 */
export function looksLikeConnectionString(value: string): boolean {
  const text = value.trim();
  if (text === "") return false;
  if (!isInvalidConnection(parseEventHubConnectionString(text))) return true;
  return /(?:^|;)\s*(?:sharedaccesskey|accountkey|sharedaccesssignature)\s*=|endpoint\s*=\s*sb:\/\//i.test(text);
}

/** Whether two descriptors name the same credential target. */
export function sameDescriptor(a: ConnectionDescriptor, b: ConnectionDescriptor): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.keyName === b.keyName &&
    (a.entityPath ?? "").toLowerCase() === (b.entityPath ?? "").toLowerCase()
  );
}

export type PastedCredentialRefusal =
  | "wrong-namespace"
  | "unknown-rule"
  | "rule-cannot-listen"
  | "rule-can-manage"
  | "entity-mismatch"
  | "rule-rights-unknown";

export type PastedCredentialCheck =
  | { readonly ok: true; readonly attested: boolean }
  | { readonly ok: false; readonly reason: PastedCredentialRefusal; readonly detail: string };

export interface PastedCredentialContext {
  /** The plan's namespace name (not the host). */
  readonly namespace: string;
  /** The hubs the lane's input will read. */
  readonly topics: readonly string[];
  /** The namespace's authorization rules, as read - or why they could not be. */
  readonly rules: ListRead<NamespaceAuthRule>;
  /** The operator ticked "This key has Listen rights". Honoured only when `rules` was refused. */
  readonly attested: boolean;
}

/** Decide whether a pasted credential can serve this lane, before any write. */
export function checkPastedCredential(
  descriptor: ConnectionDescriptor,
  ctx: PastedCredentialContext,
): PastedCredentialCheck {
  const expectedHost = `${ctx.namespace.trim().toLowerCase()}.servicebus.windows.net`;
  if (descriptor.host.toLowerCase() !== expectedHost) {
    return {
      ok: false,
      reason: "wrong-namespace",
      detail: `The connection string is for ${descriptor.host}, not ${expectedHost}.`,
    };
  }
  if (descriptor.entityPath !== undefined) {
    const entity = descriptor.entityPath.toLowerCase();
    const onlyTopic = ctx.topics.length === 1 ? ctx.topics[0]!.toLowerCase() : null;
    if (onlyTopic !== entity) {
      return {
        ok: false,
        reason: "entity-mismatch",
        detail:
          `The connection string is scoped to hub ${descriptor.entityPath}, but this source reads ` +
          (ctx.topics.length === 0 ? "no hub yet." : `${ctx.topics.join(", ")}.`),
      };
    }
  }
  // AZR-58: Azure's own Manage rule is refused by NAME, so an attestation made
  // while the rules could not be read never lets it through.
  if (descriptor.keyName.toLowerCase() === ROOT_MANAGE_RULE_NAME.toLowerCase()) {
    return { ok: false, reason: "rule-can-manage", detail: manageRefusalDetail(descriptor.keyName) };
  }
  if (ctx.rules.state === "refused") {
    if (ctx.attested) return { ok: true, attested: true };
    return {
      ok: false,
      reason: "rule-rights-unknown",
      detail: `The namespace's access rules could not be read (${ctx.rules.refusal.reason}), so whether ${descriptor.keyName} can listen is unknown.`,
    };
  }
  const rule = ctx.rules.rows.find((r) => r.name.toLowerCase() === descriptor.keyName.toLowerCase());
  if (rule === undefined) {
    return {
      ok: false,
      reason: "unknown-rule",
      detail: `The namespace has no access rule named ${descriptor.keyName}. Hub-level rules are not read.`,
    };
  }
  if (!ruleCanListen(rule.rights)) {
    return {
      ok: false,
      reason: "rule-cannot-listen",
      detail: `Rule ${rule.name} has ${rule.rights.join(", ") || "no"} rights; a Cribl source needs Listen.`,
    };
  }
  if (ruleCanManage(rule.rights)) {
    return { ok: false, reason: "rule-can-manage", detail: manageRefusalDetail(rule.name) };
  }
  return { ok: true, attested: false };
}

/**
 * Why a Manage-capable key is refused for a Cribl source (AZR-58), naming the
 * rule and the safer one to create. Shared by the paste check and the listKeys
 * plan so both say the same thing.
 */
export function manageRefusalDetail(ruleName: string): string {
  return (
    `Rule ${ruleName} can Manage the namespace. Its key in a Cribl secret would let anyone who can read ` +
    "the worker group's secrets reconfigure or delete the namespace. Create a rule with Listen only " +
    "(on the hub or the namespace) and use that one."
  );
}
