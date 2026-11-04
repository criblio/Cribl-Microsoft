/**
 * AUDIT FIDELITY PIN - every least-privilege operation says what the
 * 2026-11-03 audit says, after every skeptic correction, and every audit row
 * lands somewhere.
 *
 * The registry is hand-curated from the audit (structured role names, path
 * templates and scopes cannot be copied mechanically from its prose), so this
 * pin is what makes "populated from the audit" checkable rather than a claim:
 *
 *   1. every corrected audit row is referenced by an operation, or is in
 *      NOT_REGISTERED with the reason it needs no permission row;
 *   2. every operation's audit refs name real corrected rows;
 *   3. each operation's action, least role and citation appear in one of the
 *      rows it cites - a role the audit never named cannot slip in.
 *
 * HOW THE CORRECTIONS ARE APPLIED. Every refuted row is dropped and every
 * correction is kept. A refutation names its row by method and path, and the
 * skeptics sometimes quoted the path without its trailing parenthetical note,
 * so a refutation also names the one row in its family whose path matches up
 * to the first " (". When two skeptics corrected the same row, BOTH
 * corrections are kept as rows: the registry operation cites both and
 * reconciles them (least-privilege/operations.ts says how), rather than this
 * pin silently letting the later one win - the first draft of this pin did
 * exactly that, and lost a Management Group Reader correction.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LEAST_PRIVILEGE_OPERATIONS } from "./operations";

interface AuditRow {
  method: string;
  path: string;
  operation: string;
  leastBuiltInRole: string;
  citation: string;
}

interface Audit {
  families: {
    family: string;
    matrix: { rows: AuditRow[] };
    verdicts: { refutedRows: { method: string; path: string; corrected: AuditRow }[] }[];
  }[];
}

const audit = JSON.parse(
  readFileSync(
    new URL("../../../../../docs/audit/2026-11-03-least-privilege-audit.json", import.meta.url),
    "utf8",
  ),
) as Audit;

const basePath = (path: string): string => (path.split(" (")[0] ?? "").trim();

function correctedRows(): AuditRow[] {
  const out: AuditRow[] = [];
  for (const family of audit.families) {
    const refuted = family.verdicts.flatMap((v) => v.refutedRows);
    const refutes = (row: AuditRow, r: { method: string; path: string }): boolean => {
      if (row.method !== r.method) {
        return false;
      }
      if (row.path === r.path) {
        return true;
      }
      const sameBase = family.matrix.rows.filter(
        (x) => x.method === r.method && basePath(x.path) === basePath(r.path),
      );
      return sameBase.length === 1 && sameBase[0] === row;
    };
    out.push(
      ...family.matrix.rows.filter((row) => !refuted.some((r) => refutes(row, r))),
      ...refuted.map((r) => r.corrected),
    );
  }
  return out;
}

const CORRECTED = correctedRows();
const keyOf = (r: AuditRow): string => `${r.method} ${r.path}`;
const BY_KEY = new Map<string, AuditRow[]>();
for (const row of CORRECTED) {
  BY_KEY.set(keyOf(row), [...(BY_KEY.get(keyOf(row)) ?? []), row]);
}

/**
 * Whether an audit operation text states `action`. The full string, or - for
 * an audit that abbreviates a sibling (".../virtualNetworkLinks/write") - its
 * provider namespace plus its last two segments.
 */
function statesAction(text: string, action: string): boolean {
  const t = text.toLowerCase();
  const a = action.toLowerCase();
  if (t.includes(a)) {
    return true;
  }
  const parts = a.split("/");
  const provider = parts[0] ?? "";
  const tail = parts.slice(-2).join("/");
  return parts.length > 2 && t.includes(provider) && t.includes(tail);
}

/**
 * Audit rows with no registry operation, each with why. None of them needs a
 * permission of its own, which is the only admissible reason.
 */
const NOT_REGISTERED: Readonly<Record<string, string>> = {
  "{caller-supplied} {CRIBL_API_URL}[/m/{groupId}]{path} - PlatformCriblClient.request":
    "the Cribl transport; every path it carries is its own row",
  "GET {nextLink} absolute https://management.azure.com/... (listAllPages)":
    "a list continuation; it needs exactly the permission of the list it continues",
  "GET {nextLink} absolute https://management.azure.com/... (requestUrl callers outside listAllPages)":
    "a list continuation; it needs exactly the permission of the list it continues",
  "ANY (GET|PUT|POST|PATCH|DELETE) https://management.azure.com{path}?api-version={v} (PlatformAzureManagement.send)":
    "the ARM transport; every path it carries is its own row",
  "GET https://api.github.com/repos/Azure/Azure-Sentinel/commits/master":
    "GitHub public repository read; no Azure, Graph or Cribl permission",
  "GET https://api.github.com/repos/Azure/Azure-Sentinel/contents/{Solutions | Solutions/{solution} | Solutions/{solution}/{subDir}}":
    "GitHub public repository read; no Azure, Graph or Cribl permission",
  "GET https://api.github.com/repos/Azure/Azure-Sentinel/git/trees/{connectorDirSha}?recursive=1":
    "GitHub public repository read; no Azure, Graph or Cribl permission",
  "GET https://raw.githubusercontent.com/Azure/Azure-Sentinel/{master|commitSha}/{repoPath}":
    "GitHub public content read; no Azure, Graph or Cribl permission",
  "GET https://api.github.com/user":
    "GitHub token validation; no Azure, Graph or Cribl permission",
};

/**
 * Whether an audit least-role text NAMES `role` as a least role, not merely
 * mentions it. The audit leads each clause with the role it recommends and
 * then discusses broader ones ("Azure Event Hubs Data Owner (...). Contributor
 * also covers it but is far broader"), so a bare substring test would let a
 * mutated "Contributor" pass. Parentheticals are dropped, the text is split
 * into ";" clauses (one per method on a GET/PUT row), and each clause is cut
 * at its first sentence end; the role must appear in what is left.
 *
 * It must appear as a WHOLE role name, too: "Owner" is inside "Azure Event
 * Hubs Data Owner" and "Reader" inside "Security Reader", and a substring
 * test let both broader roles through (found by review, by mutation). Role
 * names are Title Case runs, so an occurrence counts only when the word
 * right before it and the word right after it (across spaces alone) are not
 * capitalised - "Reader at the subscription" names Reader, "Security Reader"
 * does not. Two kinds of capitalised neighbour are not part of a name and
 * are let through: the audit's upper-case joiners ("Network Contributor PLUS
 * Storage Account Contributor") and "Entra", which marks a directory role
 * ("Entra Security Administrator") rather than lengthening an RBAC one.
 */
function namesRole(text: string, role: string): boolean {
  let flat = text;
  for (let i = 0; i < 4; i++) {
    flat = flat.replace(/\([^()]*\)/g, " ");
  }
  return flat
    .split(";")
    .map((clause) => clause.split(". ")[0] ?? "")
    .some((lead) => namesWholeRole(lead, role));
}

/** Capitalised words beside a role that are not part of its name (see namesRole). */
const NOT_PART_OF_A_NAME = new Set(["PLUS", "AND", "OR", "Entra"]);

/** Whether a neighbouring word would lengthen the role name it touches. */
function extendsName(word: string): boolean {
  return /^[A-Z]/.test(word) && !NOT_PART_OF_A_NAME.has(word);
}

/** Whether `role` occurs in `lead` with no capitalised word glued to either side. */
function namesWholeRole(lead: string, role: string): boolean {
  const haystack = lead.toLowerCase();
  const needle = role.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = lead.slice(0, at);
    const after = lead.slice(at + role.length);
    const wordBefore = /([A-Za-z][\w.-]*) +$/.exec(before)?.[1] ?? "";
    const wordAfter = /^ +([A-Za-z][\w.-]*)/.exec(after)?.[1] ?? "";
    const glued = /[\w-]$/.test(before) || /^[\w-]/.test(after);
    if (!glued && !extendsName(wordBefore) && !extendsName(wordAfter)) {
      return true;
    }
  }
  return false;
}

/** Role names the audit spells out in full where the app uses Azure's short form. */
const ROLE_ALIASES: Readonly<Record<string, string>> = {
  "RBAC Administrator": "Role Based Access Control Administrator",
};

const OPERATIONS = Object.values(LEAST_PRIVILEGE_OPERATIONS);

describe("namesRole", () => {
  it("names a role only as a whole name, never inside a longer one", () => {
    // The two mutations review found surviving the substring test.
    expect(namesRole("Azure Event Hubs Data Owner on the namespace", "Owner")).toBe(false);
    expect(namesRole("Log Analytics Contributor on the workspace", "Contributor")).toBe(false);
    expect(namesRole("Security Reader at the subscription", "Reader")).toBe(false);
    expect(namesRole("Azure Event Hubs Data Owner on the namespace", "Azure Event Hubs Data Owner")).toBe(true);
    expect(namesRole("Reader at the subscription", "Reader")).toBe(true);
    expect(namesRole("Network Contributor (rg) PLUS Storage Account Contributor", "Network Contributor")).toBe(true);
    expect(namesRole("Documented: Entra Security Administrator (configure)", "Security Administrator")).toBe(true);
  });

  it("reads only the lead of each clause", () => {
    expect(namesRole("Azure Event Hubs Data Owner. Contributor also covers it", "Contributor")).toBe(false);
  });
});

describe("least-privilege operations against the audit", () => {
  it("applies the corrections to a known number of rows (173 after 84 refutations)", () => {
    // Pinned so a re-run audit file is noticed rather than silently re-read.
    expect(CORRECTED).toHaveLength(173);
  });

  it("references every corrected audit row, or says why a row needs no permission", () => {
    const referenced = new Set(OPERATIONS.flatMap((op) => op.audit));
    const missing = CORRECTED.map(keyOf).filter(
      (key) => !referenced.has(key) && NOT_REGISTERED[key] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("lists in NOT_REGISTERED only rows that exist and that no operation also references", () => {
    const referenced = new Set(OPERATIONS.flatMap((op) => op.audit));
    for (const key of Object.keys(NOT_REGISTERED)) {
      expect(BY_KEY.has(key), key).toBe(true);
      expect(referenced.has(key), key).toBe(false);
    }
  });

  it("cites only audit rows that exist after the corrections", () => {
    const unknown = OPERATIONS.flatMap((op) =>
      op.audit.filter((key) => !BY_KEY.has(key)).map((key) => `${op.id}: ${key}`),
    );
    expect(unknown).toEqual([]);
  });

  it("carries an audit row for every operation, or says why it has none", () => {
    for (const op of OPERATIONS) {
      expect(op.audit.length > 0 || (op.auditGap ?? "") !== "", op.id).toBe(true);
      expect(op.audit.length > 0 && op.auditGap !== undefined, op.id).toBe(false);
    }
  });

  it("states an action, least role and citation that the cited audit rows state", () => {
    const wrong: string[] = [];
    for (const op of OPERATIONS) {
      const rows = op.audit.flatMap((key) => BY_KEY.get(key) ?? []);
      if (rows.length === 0) {
        continue;
      }
      const has = (field: (r: AuditRow) => string, needle: string): boolean =>
        rows.some((r) => field(r).toLowerCase().includes(needle.toLowerCase()));
      if (!rows.some((r) => statesAction(r.operation, op.operation))) {
        wrong.push(`${op.id}: operation '${op.operation}'`);
      }
      const role = ROLE_ALIASES[op.leastRole] ?? op.leastRole;
      if (!rows.some((r) => namesRole(r.leastBuiltInRole, role))) {
        wrong.push(`${op.id}: leastRole '${op.leastRole}'`);
      }
      if (op.citation === "" || !has((r) => r.citation, op.citation)) {
        wrong.push(`${op.id}: citation '${op.citation}'`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
