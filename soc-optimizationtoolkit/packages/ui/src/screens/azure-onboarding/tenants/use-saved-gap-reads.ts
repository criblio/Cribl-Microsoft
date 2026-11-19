/**
 * useSavedGapReads - each tenant's latest gap read, kept in the app KV store
 * (AZR-147, ADR 0009 decision 6 amendment 2026-11-19).
 *
 *   - MOUNT makes ONE kvDocuments load (`tenant-gap-reads`) and nothing else:
 *     no Azure, Graph or Cribl call. What it holds SEEDS the shell's tenant gap
 *     cache (TenantGapCache.seed, which never replaces a newer answer), and the
 *     grid and the Focus summary read the cache.
 *   - A missing, refused, foreign, newer or undecodable document seeds nothing:
 *     every tenant reads "not read yet" (unknown), never green, and the reason
 *     is shown (gapReadsLoadNote).
 *   - SAVE runs after each complete answer the grid reads, serialized through
 *     one promise chain. Each save loads the document again, merges the one
 *     tenant, and writes only when that load answered absent or ours and
 *     readable - so another tab's saves since mount are kept, and a document
 *     this release cannot read is never written over. No compare-and-swap
 *     exists: two tabs saving at the same instant can still lose one answer,
 *     which costs a re-read, never a wrong colour.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TENANT_GAP_READS_KEY,
  canWriteGapReads,
  encodeGapReads,
  gapReadsFrom,
  gapReadsLoadNote,
  readGapReadsDocument,
  savedGapReadFor,
  withGapRead,
} from "@soc/core";
import type { GapReadsDocument, KvDocumentStore, Logger, TenantGapReads } from "@soc/core";
import type { TenantGapCache, TenantGapEntry } from "../../tenant-gap/tenant-gap-state";

/** Shown when the shell wires no document store. */
export const GAP_READS_NO_STORE =
  "This build of the app has no storage for gap reads, so answers are not saved and are gone after a reload.";

export interface SavedGapReads {
  /** Why saved answers are missing or were not saved, or null. */
  readonly note: string | null;
  /** Save one complete answer under its tenant. */
  readonly save: (entry: TenantGapEntry) => void;
}

interface ProfileLike {
  readonly id: string;
  readonly name: string;
  readonly config: { readonly tenantId: string };
}

/** Why a save was refused after its own load: the document may hold reads this release must not overwrite. */
function refusedSave(doc: GapReadsDocument): string {
  switch (doc.status) {
    case "read-unknown":
      return `the saved gap reads could not be read (${doc.reason}), and writing now could replace answers saved since`;
    case "foreign":
      return "the saved gap reads key holds a document this app did not write";
    case "unreadable":
      return "the saved gap reads were written by a newer release of this app";
    default:
      return "the saved gap reads could not be read";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSavedGapReads(
  store: KvDocumentStore | undefined,
  cache: TenantGapCache,
  profiles: readonly ProfileLike[],
  logger?: Logger,
): SavedGapReads {
  const [loadNote, setLoadNote] = useState<string | null>(store === undefined ? GAP_READS_NO_STORE : null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const reads = useRef<TenantGapReads | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const latestProfiles = useRef(profiles);
  latestProfiles.current = profiles;

  const seed = useCallback(
    (from: TenantGapReads, which: readonly ProfileLike[]) => {
      for (const p of which) {
        const saved = savedGapReadFor(from, p);
        if (saved !== null) cache.seed({ row: saved.row, readAt: saved.readAt });
      }
    },
    [cache],
  );

  // The ONE mount read.
  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void store
      .load(TENANT_GAP_READS_KEY)
      .then(readGapReadsDocument, (error: unknown) => readGapReadsDocument({ kind: "unknown", reason: errorText(error) }))
      .then((doc) => {
        if (cancelled) return;
        const loaded = gapReadsFrom(doc);
        reads.current = loaded;
        seed(loaded, latestProfiles.current);
        setLoadNote(gapReadsLoadNote(doc));
        logger?.info("azure-onboarding: saved gap reads loaded", {
          load: doc.status,
          tenants: Object.keys(loaded.tenants).length,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [store, seed, logger]);

  // A connection added (or re-pointed) later is seeded from what was loaded.
  useEffect(() => {
    if (reads.current !== null) seed(reads.current, profiles);
  }, [profiles, seed]);

  const save = useCallback(
    (entry: TenantGapEntry) => {
      if (store === undefined) return;
      const name = latestProfiles.current.find((p) => p.id === entry.row.profileId)?.name ?? "this tenant";
      chain.current = chain.current.then(async () => {
        try {
          const doc = readGapReadsDocument(await store.load(TENANT_GAP_READS_KEY));
          if (!canWriteGapReads(doc)) {
            setSaveNote(
              `The gap read of ${name} was not saved: ${refusedSave(doc)}. It shows until the page is reloaded.`,
            );
            return;
          }
          const next = withGapRead(gapReadsFrom(doc), entry);
          await store.save(TENANT_GAP_READS_KEY, encodeGapReads(next));
          reads.current = next;
          // This load answered where the mount load may not have (review round
          // 1): seed the other tenants' saved answers it holds, and say what
          // this load says rather than what a failed mount load said.
          seed(next, latestProfiles.current);
          setLoadNote(gapReadsLoadNote(doc));
          setSaveNote(null);
          logger?.info("azure-onboarding: gap read saved", { tenants: Object.keys(next.tenants).length });
        } catch (error) {
          setSaveNote(`The gap read of ${name} was not saved (${errorText(error)}). It shows until the page is reloaded.`);
        }
      });
    },
    [store, logger, seed],
  );

  return { note: saveNote ?? loadNote, save };
}

