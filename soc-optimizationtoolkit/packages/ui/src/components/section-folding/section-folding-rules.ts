/**
 * Section folding rules - the PURE decisions behind a page that opens
 * collapsed and folds the sections the operator is not using. Extracted from
 * the Sentinel Integration screen (DBT-232, DBT-237) so Setup and the wizard
 * fold by the same rules (DBT-248). Generic over string ids; no IO, no React.
 */

/**
 * The page opens collapsed (DBT-237): every section starts folded except the
 * current one (where the operator starts). Pinned sections are reopened once
 * the stored pins load. A folded section keeps its header, status and
 * one-line summary in view.
 */
export function initialCollapsed(
  ids: readonly string[],
  currentId: string | undefined,
): Set<string> {
  return new Set(ids.filter((id) => id !== currentId));
}

/**
 * The sections to fold when the operator moves to `active` (DBT-232): every
 * other OPEN section, except the pinned ones and those that must stay in view
 * (`keepOpen`: a running operation). The current section folds like any other
 * - the operator chose to work elsewhere. Only explicit moves call this -
 * opening a section, clicking or focusing inside it, Done - next - never
 * scrolling, so nothing shrinks under the pointer mid-read.
 */
export function sectionsToCollapseOnMove(
  active: string,
  ids: readonly string[],
  collapsed: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
  keepOpen: ReadonlySet<string>,
): string[] {
  return ids.filter(
    (id) => id !== active && !collapsed.has(id) && !pinned.has(id) && !keepOpen.has(id),
  );
}

/** The per-user content-cache key the pinned sections are stored under. */
export function pinnedKey(prefix: string, userId: string): string {
  return `${prefix}:${userId}`;
}

/** Parse a stored pin list, keeping only ids the page still has. */
export function parsePinned(raw: unknown, validIds: readonly string[]): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return validIds.filter((id) => parsed.includes(id));
}
