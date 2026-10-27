// Delete only what you can prove you created — and delete it in an order the server accepts.
//
// Standard: standards/config-plane-writes.md rule 11.
//
// Provenance:
//  - The App Platform gives an app no uninstall hook: scheduled searches it created keep running,
//    and billing, after removal — Documented by absence (no hook in AGENTS.md); the house rule is
//    to ship an in-app Pause/Remove and say so in the README.
//  - DELETE of a destination a route still names answers 409 — Measured 2026-09-25 (pack objects).
//    Hence teardown runs referrers before the things they reference.
//
// Ownership needs THREE independent signals, because each alone has been wrong: an id can collide
// with something an admin made by hand, a description can be copied, and a KV record can outlive the
// object. For a pack, the installed version AND the source URL must both match the app's release.

export interface OwnershipEvidence {
  /** Ids this app's manifest declares it creates. */
  manifestIds: ReadonlySet<string>;
  /** The object as read now. */
  object: { id: string; description?: unknown };
  /** This app's own record of having written the object (from its KV store). */
  recordedWrite: boolean;
}

/** The marker this app writes into every object's description. Keep it short and grep-able. */
export const stampFor = (appId: string): string => `[managed-by:${appId}]`;

/** Add the stamp to a description, once. */
export function stampDescription(description: string | undefined, appId: string): string {
  const stamp = stampFor(appId);
  const d = (description ?? '').trim();
  return d.includes(stamp) ? d : d ? `${d} ${stamp}` : stamp;
}

export function proveOwnership(appId: string, e: OwnershipEvidence): { mine: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!e.manifestIds.has(e.object.id)) missing.push('id is not in this app’s manifest');
  if (typeof e.object.description !== 'string' || !e.object.description.includes(stampFor(appId))) missing.push('description carries no stamp from this app');
  if (!e.recordedWrite) missing.push('this app has no record of writing it');
  return { mine: missing.length === 0, missing };
}

/** A pack is ours only when the installed version AND its source URL are this app's release. */
export function provePackOwnership(
  installed: { id: string; version?: unknown; source?: unknown },
  release: { id: string; version: string; url: string },
): { mine: boolean; missing: string[] } {
  const missing: string[] = [];
  if (installed.id.toLowerCase() !== release.id.toLowerCase()) missing.push('pack id differs'); // ids are case-insensitive unique
  if (installed.version !== release.version) missing.push(`installed version ${String(installed.version)} is not this app’s release ${release.version}`);
  if (installed.source !== release.url) missing.push('installed from a different source');
  return { mine: missing.length === 0, missing };
}

export interface TeardownNode {
  id: string;
  /** Ids this object references (a route → its pipeline and output). */
  references: readonly string[];
}

/**
 * Order deletions so every referrer goes before what it references. Throws on a cycle rather than
 * picking an order the server will refuse halfway through.
 */
export function teardownOrder(nodes: readonly TeardownNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const referrers = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const n of nodes) for (const r of n.references) if (ids.has(r)) referrers.set(r, (referrers.get(r) ?? 0) + 1);
  const ready = nodes.filter((n) => referrers.get(n.id) === 0).map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const r of byId.get(id)!.references) {
      if (!ids.has(r)) continue;
      const left = (referrers.get(r) ?? 0) - 1;
      referrers.set(r, left);
      if (left === 0) ready.push(r);
    }
  }
  if (out.length !== nodes.length) throw new Error('Reference cycle among objects to delete; resolve it by hand.');
  return out;
}
