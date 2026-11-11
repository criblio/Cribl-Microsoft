/**
 * Words for the tenant inventory heat map. Colour is never the only signal, so
 * every cell and card is also stated in text here. Pure: no React, no IO.
 */

import type { CategoryCard, Destination, LogTypeCell } from "@soc/core";

const KIND_WORD: Readonly<Record<Destination["kind"], string>> = {
  workspace: "workspace",
  "event-hub": "event hub",
  storage: "storage",
  partner: "partner",
};

/** The last path segment plus the kind, for example "workspace law-soc-prod". */
export function destinationLabel(d: Destination): string {
  const segments = d.resourceId.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1] ?? d.resourceId;
  return `${KIND_WORD[d.kind]} ${last}`;
}

/** The read time as a local date and time; the raw text when it is not a date. */
export function readAtLabel(readAt: string): string {
  const t = new Date(readAt);
  return Number.isNaN(t.getTime()) ? readAt : t.toLocaleString();
}

/** A whole percentage, or "not known" for a share that could not be worked out. */
export function shareLabel(share: number | null): string {
  return share === null ? "not known" : `${Math.round(share * 100)}%`;
}

/**
 * The Cribl archive is judged from this app's own record of the Cribl sources
 * and Lake routes it wrote, not from a live read of Cribl, so the words say so.
 */
const VIA_WORDS = {
  storage: "archived to storage",
  cribl: "archived through Cribl, as recorded by this app",
  "storage-and-cribl": "archived to storage and through Cribl, as recorded by this app",
} as const;

function archiveWords(cell: LogTypeCell): string {
  switch (cell.archive.kind) {
    case "archived":
      return VIA_WORDS[cell.archive.via];
    case "partial":
      return `archived in ${cell.archive.archived} of ${cell.archive.collecting} collecting scopes`;
    case "not-archived":
      return "not archived";
    case "unknown":
      return `archive not known (${cell.archive.reason})`;
  }
}

/** The state of one log type, in words. */
export function cellLabel(cell: LogTypeCell): string {
  const state = cell.state;
  switch (state.kind) {
    case "could-not-check":
      return `Could not check: ${state.reason}`;
    case "not-collected":
      return "Not collected";
    case "collected":
      return `Collected, ${archiveWords(cell)}`;
    case "partly": {
      const s = state.scopes;
      const unread = s.unread > 0 ? `, ${s.unread} could not be read` : "";
      return `Partly collected (${s.collected} of ${s.read} read), ${archiveWords(cell)}${unread}`;
    }
  }
}

/** A category card in words: its counts, or the reason it is not read. */
export function cardSummary(card: CategoryCard): string {
  if (card.notChecked !== null) return card.notChecked;
  const c = card.counts;
  const parts = [
    c.green > 0 ? `${c.green} collected and archived` : "",
    c.amber > 0 ? `${c.amber} collected, not fully archived or not everywhere` : "",
    c.red > 0 ? `${c.red} not collected` : "",
    c.blue > 0 ? `${c.blue} could not check` : "",
  ].filter((p) => p !== "");
  return parts.length === 0 ? "Could not check: nothing was read" : parts.join(", ");
}
