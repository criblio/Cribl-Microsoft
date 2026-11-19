/**
 * Every write flow on the onboarding screen reports itself (AZR-147 review
 * round 2).
 *
 * The page refuses a connection switch while a flow is registered with
 * useReportBusy (operation-busy.ts). Round 1 wired eleven flows by hand and
 * missed "Route to Cribl Lake"; nothing failed, because a flow that forgets to
 * report simply lets the switch through. This gate does not rely on someone
 * remembering: every component in this folder whose source runs a write phase
 * ("applying", "removing", or an awaited onApply) must call useReportBusy, and
 * the set of labels is pinned exactly, so a removed or renamed report fails.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function components(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...components(full));
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** A write phase: the shape every create, deploy and removal panel here uses. */
const WRITE_PHASE = /"applying"|\bremoving\b|await hooks\.onApply\(/;

/**
 * Files that match WRITE_PHASE without being a flow that should report:
 * the screen only HOSTS the handlers its panels call (each panel reports).
 */
const NOT_A_FLOW: Readonly<Record<string, string>> = {
  "azure-onboarding-screen.tsx": "hosts the handlers; the panels that run them report",
};

const REPORT = /useReportBusy\(\s*"([^"]+)"/g;

const FILES = components(HERE).map((f) => ({ rel: relative(HERE, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));

describe("operation-busy coverage", () => {
  it("every component with a write phase calls useReportBusy", () => {
    const writers = FILES.filter((f) => WRITE_PHASE.test(f.text) && NOT_A_FLOW[f.rel] === undefined);
    const silent = writers.filter((f) => !f.text.includes("useReportBusy(")).map((f) => f.rel);
    expect(silent).toEqual([]);
    // The scan must find the panels at all, or it proves nothing.
    expect(writers.map((f) => f.rel).sort()).toEqual([
      "activity-log-remove-panel.tsx",
      "activity-log-section.tsx",
      "cribl-source/cribl-source-panel.tsx",
      "cribl-source/lake-route-panel.tsx",
      "cribl-source/listen-access-panel.tsx",
      "cribl-source/listen-access-remove-panel.tsx",
      "cribl-source/teardown-panel.tsx",
      "entra-remove-panel.tsx",
      "receiver-grant-remove-panel.tsx",
      "receiver-grant-section.tsx",
    ]);
  });

  it("reports exactly these flows, by the words the refusal quotes", () => {
    const labels = FILES.flatMap((f) => [...f.text.matchAll(REPORT)].map((m) => m[1]!)).sort();
    expect(labels).toEqual([
      "a Cribl source create",
      "a Cribl source removal, pause or resume",
      "a Data Receiver role grant",
      "a Data Receiver role grant removal",
      "a Defender for Cloud alert export deploy",
      "a Listen rule and consumer group create",
      "a Listen rule or consumer group removal",
      "a route to Cribl Lake create",
      "an Activity Log diagnostic setting deploy",
      "an Activity Log diagnostic setting removal",
      "an Entra ID diagnostic setting deploy",
      "an Entra ID diagnostic setting removal",
    ]);
  });
});
