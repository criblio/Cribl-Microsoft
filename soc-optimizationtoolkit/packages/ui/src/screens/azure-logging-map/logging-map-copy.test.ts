/**
 * Copy gate for the Azure Logging Map (AZR-19).
 *
 * 1. NO PROJECT HISTORY in anything the operator reads (copy-rules.ts):
 *    every string the copy module exports or builds, plus every string literal
 *    and JSX text in this folder's components, goes through findHistoryInCopy.
 * 2. NO MOCKUP EXAMPLE DATA ships. The approved mockup ran on a made-up
 *    tenant; none of its names may appear in this folder or in core's
 *    domain/logging-map. The forbidden strings are assembled from FRAGMENTS
 *    and this file skips itself, so the scan can never match its own needle;
 *    a self-check proves the scanner does find a fragment-joined string, so
 *    the pin can fail.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CoverageState, LoggingClass, Refusal, ScopeNode } from "@soc/core";

import { describeViolations, findHistoryInCopy, type CopyEntry } from "../../components/copy-rules";
import * as copy from "./logging-map-copy";

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const CORE_DOMAIN = resolve(HERE, "../../../../core/src/domain/logging-map");

// ---------------------------------------------------------------- 1. history

function entriesFromRecord(where: string, rec: Readonly<Record<string, string>>): CopyEntry[] {
  return Object.entries(rec).map(([k, text]) => ({ where: `${where}.${k}`, text }));
}

const SAMPLE_NODE: ScopeNode = {
  id: "/subscriptions/x",
  kind: "subscription",
  name: "x",
  displayName: "x",
  parentId: null,
  treeRole: "listed",
};

const SAMPLE_STATES: readonly CoverageState[] = [
  { state: "covered" },
  { state: "conditional", regions: ["eastus"] },
  { state: "partial", belowCount: 2 },
  { state: "covered-exemptions-unknown" },
  { state: "partial", belowCount: 1, regions: ["westus"] },
  { state: "covered-exemptions-unknown", belowCount: 2, regions: ["eastus", "not westus"] },
  { state: "exempt", exemptionIds: ["e"] },
  { state: "partially-exempt", exemptionIds: ["e"], referenceIds: ["r"] },
  { state: "excluded", by: "/subscriptions/x" },
  { state: "unknown", why: "assignments-unread" },
  { state: "unknown", why: "ancestry-unknown" },
  { state: "not-reached" },
];

const SAMPLE_CLASSES: readonly (LoggingClass | null)[] = [
  null,
  { verdict: "yes", destinations: ["event-hub", "log-analytics"], basis: "definition" },
  { verdict: "no", reason: "effect-not-deploy", effect: "Audit" },
  { verdict: "no", reason: "not-diagnostic-settings", effect: null },
  { verdict: "unknown", reason: "definition-not-read", unread: [], knownDestinations: [] },
  { verdict: "unknown", reason: "member-not-read", unread: [], knownDestinations: [] },
  { verdict: "unknown", reason: "effect-unresolved", unread: [], knownDestinations: [] },
];

const SAMPLE_REFUSALS: readonly Refusal[] = [
  { request: "/x", status: 403, code: "AuthorizationFailed", text: "denied", reason: "http" },
  { request: "/x", status: null, code: "", text: "network", reason: "transport" },
  { request: "/x", status: 200, code: "", text: "no value", reason: "unexpected-shape" },
  { request: "/x", status: null, code: "", text: "role read cap reached", reason: "too-many-pages" },
];

function copyModuleEntries(): CopyEntry[] {
  const out: CopyEntry[] = [
    ...entriesFromRecord("TIPS", copy.TIPS),
    ...entriesFromRecord("KIND_HEADER", copy.KIND_HEADER),
    ...entriesFromRecord("KIND_WORD", copy.KIND_WORD),
    ...entriesFromRecord("KIND_TAG", copy.KIND_TAG),
    ...entriesFromRecord("STRENGTH_LABEL", copy.STRENGTH_LABEL),
    ...entriesFromRecord("EVIDENCE_LABEL", copy.EVIDENCE_LABEL),
    ...entriesFromRecord("DESTINATION_LABEL", copy.DESTINATION_LABEL),
    ...entriesFromRecord("MARK_LABEL", copy.MARK_LABEL),
    ...copy.LEGEND.map((l) => ({ where: `LEGEND.${l.key}`, text: l.label })),
  ];
  for (const [k, v] of Object.entries(copy)) if (typeof v === "string") out.push({ where: k, text: v });
  for (const kind of ["tenant-root", "management-group", "subscription", "placeholder"] as const) {
    out.push({ where: `readRoleFor(${kind})`, text: copy.readRoleFor(kind) });
  }
  for (const role of ["listed", "unread-origin", "parent-unknown"] as const) {
    out.push({ where: `unreadSentence(${role})`, text: copy.unreadSentence({ ...SAMPLE_NODE, treeRole: role }, true) ?? "" });
  }
  for (const s of SAMPLE_STATES) {
    out.push({ where: `coveragePill(${s.state})`, text: copy.coveragePill(s) ?? "" });
    out.push({ where: `coverageSentence(${s.state})`, text: copy.coverageSentence(s, "Origin") });
  }
  for (const c of SAMPLE_CLASSES) out.push({ where: "classSentence", text: copy.classSentence(c) });
  for (const r of SAMPLE_REFUSALS) out.push({ where: `refusalText(${r.reason})`, text: copy.refusalText(r) });
  for (const n of ["no-identity", "principal-not-given", "not-read", "some-not-read"] as const) {
    out.push({ where: `rolesNoteText(${n})`, text: copy.rolesNoteText(n) });
  }
  out.push({
    where: "traceSummaryText",
    text: copy.traceSummaryText({
      subscriptionsCovered: 3,
      coveredExemptionsUnknown: 1,
      excluded: 1,
      exempt: 1,
      partial: 1,
      conditional: 1,
      unknown: 2,
      notReached: 4,
    }),
  });
  for (const o of ["ours", "other", null] as const) out.push({ where: `ownerPill(${String(o)})`, text: copy.ownerPill(o) });
  return out;
}

/** Comments removed; `//` inside a string such as a URL is kept. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

/** String literals and JSX text in a component source. */
function literalsOf(file: string): CopyEntry[] {
  const code = stripComments(readFileSync(file, "utf8"));
  const out: CopyEntry[] = [];
  const name = file.split(/[\\/]/).pop() ?? file;
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    out.push({ where: name, text: m[1] ?? m[2] ?? "" });
  }
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push({ where: `${name} (JSX)`, text: m[1] ?? "" });
  return out;
}

const COMPONENTS = readdirSync(HERE)
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .map((f) => join(HERE, f));

describe("logging map copy - no project history", () => {
  it("the copy module's strings and sentence builders are clean", () => {
    const entries = copyModuleEntries();
    expect(entries.length).toBeGreaterThan(60);
    const v = findHistoryInCopy(entries);
    expect(v, describeViolations(v)).toEqual([]);
  });

  it("every literal and JSX text in the components is clean", () => {
    expect(COMPONENTS.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual([
      "azure-logging-map-screen.tsx",
      "logging-map-canvas.tsx",
      "logging-map-outline.tsx",
      "logging-map-panel.tsx",
      "logging-map-toolbar.tsx",
    ]);
    const entries = COMPONENTS.flatMap(literalsOf);
    expect(entries.length).toBeGreaterThan(100);
    const v = findHistoryInCopy(entries);
    expect(v, describeViolations(v)).toEqual([]);
  });

  it("the gate catches a history token (so it can fail)", () => {
    const planted = ["Tracked as ", ["AZR", "19"].join("-"), " in phase 1"].join("");
    expect(findHistoryInCopy([{ where: "planted", text: planted }]).length).toBe(2);
  });
});

// ---------------------------------------------------------------- 2. mockup data

/** The mockup's example tenant, assembled so this file never contains a needle. */
const FORBIDDEN: readonly string[] = [
  ["con", "toso"],
  ["Cribl-Diag", "AllLogs"],
  ["evhns-cribl", "-prod"],
  ["uami-cribl", "-policy"],
  ["uami-platform", "-diag"],
  ["Net-Diag", "-to-LA"],
  ["sub-corp", "-prod"],
  ["sub-online", "-prod"],
  ["sub-sandbox", "-01"],
  ["72f988bf", "-86f1"],
  ["cribl-", "defender"],
].map((parts) => parts.join("").toLowerCase());

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function findMockupData(texts: readonly { file: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { file, text } of texts) {
    const lower = text.toLowerCase();
    for (const needle of FORBIDDEN) if (lower.includes(needle)) hits.push(`${file}: ${needle}`);
  }
  return hits;
}

describe("logging map copy - no mockup example data", () => {
  it("scans this folder and core's domain/logging-map, skipping only itself", () => {
    const files = [...filesUnder(HERE), ...filesUnder(CORE_DOMAIN)].filter((f) => resolve(f) !== resolve(SELF));
    expect(files.some((f) => f.endsWith("logging-map-canvas.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("ownership.ts"))).toBe(true);
    expect(files.some((f) => resolve(f) === resolve(SELF))).toBe(false);
    const hits = findMockupData(files.map((file) => ({ file, text: readFileSync(file, "utf8") })));
    expect(hits).toEqual([]);
  });

  it("the scanner does find a fragment-joined needle (so the pin can fail)", () => {
    const sample = `const tenant = "${["Con", "toso"].join("")} Landing Zones";`;
    expect(findMockupData([{ file: "sample", text: sample }])).toEqual([`sample: ${["con", "toso"].join("")}`]);
  });
});

describe("logging map copy - portal link shapes", () => {
  // Both shapes are pinned so a change to either is deliberate. The
  // subscription deep link is known to work; the management-group one is
  // UNVERIFIED until the AZR-19 live checklist opens it (the portal normally
  // uses the ManagementGroups drilldown blade for management groups).
  it("links a subscription to its #resource overview", () => {
    expect(copy.portalLink("/subscriptions/00000000-0000-0000-0000-000000000001")).toBe(
      "https://portal.azure.com/#resource/subscriptions/00000000-0000-0000-0000-000000000001/overview",
    );
  });

  it("links a management group the same way (unverified live)", () => {
    expect(copy.portalLink("/providers/microsoft.management/managementgroups/mg-a")).toBe(
      "https://portal.azure.com/#resource/providers/microsoft.management/managementgroups/mg-a/overview",
    );
  });
});
