/**
 * Saved tenant gap reads (AZR-147, ADR 0009 decision 6 amendment 2026-11-19) -
 * each tenant's LATEST gap read, with the time it was read, surviving a reload.
 *
 * ONE KV DOCUMENT, KEYED BY TENANT. `tenant-gap-reads` holds a map from the
 * normalized tenant id to that tenant's last complete row and its `readAt`
 * (epoch ms, the shell's clock). One document rather than one per tenant,
 * because the grid seeds every row from it in ONE load and the only time it is
 * written is after a read the operator asked for.
 *
 * THE GATE MIRRORS readProgressDocument (claude-kit standards/cribl-kv-store.md):
 * is it ours (`kind`), can this release read it (`version` exactly 1), and the
 * port's third answer, a refused read. A write is allowed only after `absent`
 * or `ok`; anything else may be hiding saved reads.
 *
 * HONESTY (claude-kit standards/inventory-honesty.md):
 * - nothing here ever decodes to green that was not stored green by this app:
 *   a missing, refused, foreign, newer or undecodable document seeds NOTHING,
 *   so every cell reads "not read yet" (unknown);
 * - decode is tolerant and REPORTS what it dropped (an unknown source id, a
 *   cell with no readable state, a tenant whose key does not match its row);
 *   a dropped cell renders as not read, never as a colour;
 * - a cancelled row is never saved ({@link withGapRead}), so a partial answer
 *   cannot outlive the session that made it.
 *
 * A saved row seeds a connection only while that connection still names the
 * tenant AND is the connection it was read through ({@link savedGapReadFor}):
 * another app registration in the same tenant may hold different permissions,
 * so its answer is not this one's.
 *
 * Pure: no IO, no Date, no randomness.
 */

import type { KvDocumentLoad } from "../../ports/kv-document-store";
import { isOnboardingSourceId, type OnboardingSourceId } from "../onboarding-howto/sources";
import { normalizeTenantId } from "../tenancy";
import type { GapCell, GapIndicator, GapState, TenantGapRow } from "./tenant-gap";

/** The KV key. */
export const TENANT_GAP_READS_KEY = "tenant-gap-reads";
/** The document's `kind`: whose it is. */
export const TENANT_GAP_READS_KIND = "tenant-gap-reads";
/** The only version this release reads or writes. */
export const TENANT_GAP_READS_VERSION = 1;

/** One tenant's saved answer: the row, and when it was read (epoch ms). */
export interface SavedGapRead {
  readonly row: TenantGapRow;
  readonly readAt: number;
}

/** Every saved answer, by normalized tenant id. */
export interface TenantGapReads {
  readonly tenants: Readonly<Record<string, SavedGapRead>>;
}

/** No saved answers. */
export function emptyGapReads(): TenantGapReads {
  return { tenants: {} };
}

/**
 * Keep `entry` as its tenant's latest answer. A cancelled row, or one with no
 * tenant id, is not kept (the reads come back unchanged): a partial answer
 * must not be what a reload shows.
 */
export function withGapRead(reads: TenantGapReads, entry: SavedGapRead): TenantGapReads {
  const tenant = normalizeTenantId(entry.row.tenantId);
  if (entry.row.cancelled || tenant === "") return reads;
  return { tenants: { ...reads.tenants, [tenant]: { row: { ...entry.row, tenantId: tenant }, readAt: entry.readAt } } };
}

/**
 * The saved answer for a connection: only while the connection still names
 * the tenant it was read for AND is the connection it was read through.
 */
export function savedGapReadFor(
  reads: TenantGapReads,
  profile: { readonly id: string; readonly config: { readonly tenantId: string } },
): SavedGapRead | null {
  const tenant = normalizeTenantId(profile.config.tenantId);
  if (tenant === "") return null;
  const saved = reads.tenants[tenant];
  if (saved === undefined || saved.row.profileId !== profile.id) return null;
  return saved;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function indicatorOut(i: GapIndicator): GapIndicator {
  return { state: i.state, reason: i.reason };
}

/** Serialize for the KV store. Deterministic: same reads, same text. */
export function encodeGapReads(reads: TenantGapReads): string {
  const tenants: Record<string, unknown> = {};
  for (const tenant of Object.keys(reads.tenants).sort()) {
    const saved = reads.tenants[tenant]!;
    if (saved.row.cancelled) continue;
    tenants[tenant] = {
      readAt: saved.readAt,
      profileId: saved.row.profileId,
      status: indicatorOut(saved.row.status),
      warnings: [...saved.row.warnings],
      plannedReads: saved.row.plannedReads,
      cells: saved.row.cells.map((c) => ({
        sourceId: c.sourceId,
        azure: indicatorOut(c.azure),
        cribl: indicatorOut(c.cribl),
      })),
    };
  }
  return JSON.stringify({ kind: TENANT_GAP_READS_KIND, version: TENANT_GAP_READS_VERSION, tenants });
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STATES: readonly GapState[] = ["green", "red", "unknown"];

function indicatorIn(v: unknown): GapIndicator | null {
  if (!isRecord(v)) return null;
  const state = v["state"];
  const reason = v["reason"];
  if (typeof state !== "string" || !(STATES as readonly string[]).includes(state)) return null;
  if (typeof reason !== "string") return null;
  return { state: state as GapState, reason };
}

/** What a decode produced and what it dropped (reported, never silent). */
export interface DecodedGapReads {
  readonly reads: TenantGapReads;
  readonly dropped: readonly string[];
}

const ENTRY_KEYS = ["readAt", "profileId", "status", "warnings", "plannedReads", "cells"];

function decodeEntry(tenant: string, raw: unknown, dropped: string[]): SavedGapRead | null {
  const at = `tenants.${tenant}`;
  if (!isRecord(raw)) {
    dropped.push(at);
    return null;
  }
  const readAt = raw["readAt"];
  const profileId = raw["profileId"];
  const status = indicatorIn(raw["status"]);
  // Without a time the answer's age cannot be shown, without a connection it
  // cannot be matched to one, and the status is never red (the scan's
  // contract), so any of those makes the whole entry unusable.
  if (
    typeof readAt !== "number" ||
    !Number.isFinite(readAt) ||
    readAt <= 0 ||
    typeof profileId !== "string" ||
    profileId === "" ||
    status === null ||
    status.state === "red"
  ) {
    dropped.push(at);
    return null;
  }
  const cells: GapCell[] = [];
  const seen = new Set<OnboardingSourceId>();
  const rawCells = raw["cells"];
  if (Array.isArray(rawCells)) {
    rawCells.forEach((c, i) => {
      if (!isRecord(c)) {
        dropped.push(`${at}.cells[${i}]`);
        return;
      }
      const sourceId = c["sourceId"];
      const azure = indicatorIn(c["azure"]);
      const cribl = indicatorIn(c["cribl"]);
      if (typeof sourceId !== "string" || !isOnboardingSourceId(sourceId) || seen.has(sourceId) || azure === null || cribl === null) {
        dropped.push(`${at}.cells[${i}]`);
        return;
      }
      seen.add(sourceId);
      cells.push({ sourceId, azure, cribl });
    });
  } else if (rawCells !== undefined) {
    dropped.push(`${at}.cells`);
  }
  const warnings: string[] = [];
  const rawWarnings = raw["warnings"];
  if (Array.isArray(rawWarnings)) {
    rawWarnings.forEach((w, i) => {
      if (typeof w === "string") warnings.push(w);
      else dropped.push(`${at}.warnings[${i}]`);
    });
  } else if (rawWarnings !== undefined) {
    dropped.push(`${at}.warnings`);
  }
  const rawPlanned = raw["plannedReads"];
  let plannedReads = 0;
  if (typeof rawPlanned === "number" && Number.isInteger(rawPlanned) && rawPlanned >= 0) plannedReads = rawPlanned;
  else if (rawPlanned !== undefined) dropped.push(`${at}.plannedReads`);
  for (const k of Object.keys(raw)) if (!ENTRY_KEYS.includes(k)) dropped.push(`${at}.${k}`);
  return {
    readAt,
    row: { profileId, tenantId: tenant, cells, status, warnings, plannedReads, cancelled: false },
  };
}

/**
 * Decode an object of ours. Tolerant: keeps every entry and cell that still
 * resolves, drops the rest and reports each. A tenant key that is not already
 * a normalized tenant id is dropped: it could not have been written by this
 * release, so whose answer it is cannot be told. Never throws.
 */
export function decodeGapReads(raw: unknown): DecodedGapReads {
  const dropped: string[] = [];
  const tenants: Record<string, SavedGapRead> = {};
  if (!isRecord(raw)) return { reads: emptyGapReads(), dropped };
  const rawTenants = raw["tenants"];
  if (isRecord(rawTenants)) {
    for (const [tenant, entry] of Object.entries(rawTenants)) {
      if (tenant === "" || normalizeTenantId(tenant) !== tenant) {
        dropped.push(`tenants.${tenant}`);
        continue;
      }
      const decoded = decodeEntry(tenant, entry, dropped);
      if (decoded !== null) tenants[tenant] = decoded;
    }
  } else if (rawTenants !== undefined) {
    dropped.push("tenants");
  }
  for (const k of Object.keys(raw)) if (!["kind", "version", "tenants"].includes(k)) dropped.push(k);
  return { reads: { tenants }, dropped };
}

/**
 * What the saved-reads KV read means.
 *
 *   absent        nothing of ours is stored (not found, empty, corrupt, or an
 *                 object with neither kind nor version); nothing saved, writes OK
 *   ok            ours and readable; writes OK
 *   foreign       `kind` present and not ours; writes blocked
 *   unreadable    ours but `version` is not exactly 1; writes blocked
 *   read-unknown  the read failed (403, 5xx, timeout); writes blocked
 *
 * Every status but `ok` seeds no answer: the grid reads "not read yet".
 */
export type GapReadsDocument =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly decoded: DecodedGapReads }
  | { readonly status: "foreign"; readonly kind: unknown }
  | { readonly status: "unreadable"; readonly version: unknown }
  | { readonly status: "read-unknown"; readonly reason: string };

/** Classify the port's answer, decoding only a readable document of ours. Never throws. */
export function readGapReadsDocument(load: KvDocumentLoad): GapReadsDocument {
  if (load.kind === "unknown") return { status: "read-unknown", reason: load.reason };
  if (load.kind === "absent") return { status: "absent" };
  let parsed: unknown = load.value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { status: "absent" };
    }
  }
  if (!isRecord(parsed)) return { status: "absent" };
  if ("kind" in parsed && parsed["kind"] !== TENANT_GAP_READS_KIND) return { status: "foreign", kind: parsed["kind"] };
  if (!("kind" in parsed) && !("version" in parsed)) return { status: "absent" };
  if (parsed["version"] !== TENANT_GAP_READS_VERSION) return { status: "unreadable", version: parsed["version"] };
  return { status: "ok", decoded: decodeGapReads(parsed) };
}

/** Whether a write is allowed after this read. */
export function canWriteGapReads(doc: GapReadsDocument): boolean {
  return doc.status === "absent" || doc.status === "ok";
}

/** The saved answers to seed from: none unless the document is ours and readable. */
export function gapReadsFrom(doc: GapReadsDocument): TenantGapReads {
  return doc.status === "ok" ? doc.decoded.reads : emptyGapReads();
}

/**
 * The sentence for a load that seeds nothing although something may be there,
 * or null when the load is `absent` or `ok` with nothing dropped.
 */
export function gapReadsLoadNote(doc: GapReadsDocument): string | null {
  switch (doc.status) {
    case "absent":
      return null;
    case "ok":
      return doc.decoded.dropped.length === 0
        ? null
        : `Some saved gap reads could not be understood and are shown as not read yet (${doc.decoded.dropped.length} ${
            doc.decoded.dropped.length === 1 ? "part" : "parts"
          } dropped).`;
    case "read-unknown":
      return `Saved gap reads could not be loaded (${doc.reason}), so every tenant shows as not read yet. Reading a tenant again shows its answer, but it is not saved until the saved reads load.`;
    case "foreign":
      return "The saved gap reads key holds a document this app did not write, so every tenant shows as not read yet and nothing is saved over it.";
    case "unreadable":
      return "Saved gap reads were written by a newer release of this app, so every tenant shows as not read yet and nothing is saved over them.";
  }
}
