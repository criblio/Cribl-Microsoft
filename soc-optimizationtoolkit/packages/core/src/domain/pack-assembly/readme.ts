/**
 * Pack README.md - GEN-14.
 *
 * THE DEFECT THIS CLOSES. Seen live 2026-09-04 while investigating GEN-13: Pack
 * Settings -> README on an app-built pack showed Cribl's stock scaffold text
 * verbatim ("This is a paragraph that describes what this Pack enables...",
 * "configure the [Source|Destination|Dataset] by ____"). The app was not
 * shipping that template - it shipped NO README.md at all, and the template is
 * what Cribl shows in its place. The plan already knows the solution, every
 * table, every pipeline and how the pack is wired, so it writes them down.
 *
 * WHAT IT DELIBERATELY LEAVES OUT. Only names and ids the plan derives. No DCR
 * immutable id, ingestion endpoint, tenant or client id - those stay in
 * outputs.yml, where a placeholder can be filled in. A README is the file an
 * operator is most likely to paste into a ticket or a chat.
 *
 * The Deployment section encodes GEN-13's finding (a pack holding a configured
 * destination is withheld from the Routes page pipeline dropdown). If that
 * finding is ever revised, {@link deploymentSection} is the one place to change.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random - a rebuild is
 * byte-stable.
 */

import type { PipelinePlan, TablePlan } from "../pipeline-generation";

import { buildPackageJson, packAuthor } from "./package-json";

/** The unique values of `pick` over the tables, in plan order. */
function unique(tables: TablePlan[], pick: (t: TablePlan) => string): string[] {
  return [...new Set(tables.map(pick))];
}

/** One row per TablePlan - never deduplicated, so every pipeline pair is listed. */
function contentsSection(plan: PipelinePlan): string[] {
  return [
    "## What this pack contains",
    "",
    "| Log type | Sentinel table | Pipeline | Reduction pipeline | Destination | Stream |",
    "| --- | --- | --- | --- | --- | --- |",
    ...plan.tables.map(
      (t) =>
        `| ${t.logType} | ${t.sentinelTable} | ${t.pipelineName} | ` +
        `${t.reductionPipelineId} | ${t.destinationId} | ${t.streamName} |`,
    ),
  ];
}

/**
 * The wiring guidance, branching on the operator's GEN-13 choice. Omitted
 * packShape is all-inclusive, the same default scaffoldPack and route-yml use.
 */
function deploymentSection(plan: PipelinePlan): string[] {
  // Deduplicated by destination id: a multi-logType table shares ONE
  // destination, exactly as outputs.yml dedupes it.
  const destinations = new Map<string, string>();
  for (const t of plan.tables) {
    if (!destinations.has(t.destinationId)) destinations.set(t.destinationId, t.streamName);
  }
  const destinationList = [...destinations].map(
    ([id, stream]) => `- ${id} (stream ${stream})`,
  );

  if (plan.packShape === "routable") {
    return [
      "## Deployment",
      "",
      "This pack is ROUTABLE. It ships no destination, and every pack route sends " +
        "its events back to the worker group (`output: default`). It appears in the " +
        "pipeline dropdown on the Cribl Routes page, so it can be dropped into a flow " +
        "that already exists.",
      "",
      "The Sentinel destinations below must ALREADY EXIST in the worker group, with " +
        "their ingestion secret. The pack does not carry them. Deploying the table " +
        "from the SOC Optimization Toolkit creates them in the worker group.",
      "",
      ...destinationList,
    ];
  }
  return [
    "## Deployment",
    "",
    "This pack is SELF-CONTAINED. It ships its own Sentinel destinations in " +
      "`default/outputs.yml`, and each pack route sends to its table's destination, " +
      "so nothing has to exist in the worker group first.",
    "",
    "Before data flows, open each destination in the pack and confirm the DCR " +
      "immutable id, the ingestion endpoint and the client secret. A pack built " +
      "before its DCR was deployed carries placeholder values there.",
    "",
    ...destinationList,
    "",
    "It does NOT appear in the pipeline dropdown on the Cribl Routes page: a pack " +
      "holding a configured destination is withheld from that list. Send a source " +
      "to the pack directly instead (Build and install pack in the SOC Optimization " +
      "Toolkit wires this for you).",
  ];
}

/** Render the pack's root README.md from its resolved plan. */
export function generatePackReadme(plan: PipelinePlan): string {
  // The heading is the manifest's displayName, so the two never disagree.
  const displayName = buildPackageJson(plan).displayName;
  const tables = unique(plan.tables, (t) => t.sentinelTable);
  const lines = [
    `# ${displayName}`,
    "",
    `Transforms ${plan.solutionName} logs into the Microsoft Sentinel ` +
      `${tables.length === 1 ? "table" : "tables"} ${tables.join(", ")}, ` +
      "sent through the Azure Monitor Logs Ingestion API (a Data Collection Rule).",
    "",
    ...contentsSection(plan),
    "",
    ...deploymentSection(plan),
    "",
    "---",
    "",
    `Built by ${packAuthor(plan.toolkitVersion)}, pack version ${plan.version}.`,
  ];
  return lines.join("\n") + "\n";
}
