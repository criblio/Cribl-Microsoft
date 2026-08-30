/**
 * Air-gap export - porting-plan Unit 20 task item 9 (ENG-10, GUI-15).
 *
 * For air-gapped / partial modes there is no live Azure or Cribl to write into,
 * so the deploy instead ASSEMBLES the full artifact set IN MEMORY and delivers
 * it as ONE archive through the ArtifactSink port (browser download on cloud, a
 * file on local; local may alternatively install directly). The legacy wrote a
 * loose directory tree to ~/Downloads (pack-builder.ts 2631-2739); this port
 * produces a single deterministic .tgz using Unit 19's PURE ustar/.crbl builder
 * - no filesystem, no child process, byte-reproducible from a caller-supplied
 * mtime.
 *
 * Archive layout (mirrors the legacy export directory):
 *   {packName}.crbl                         the built pack (when provided)
 *   arm-templates/azure-deploy.json         ONE ARM deployment template
 *   cribl-destinations/{id}.json            one file per destination config
 *   README-deployment.md                    generated deploy instructions
 *
 * DBT-33: `arm-templates/` used to hold one file per collected request, each
 * a bare ARM REST body, while the README told operators to feed them to Portal
 * or `az deployment group create` - neither of which accepts a body with no
 * `$schema` and no `resources[]`. It now holds ONE real deployment template
 * (domain/arm-template), so the instruction and the artifact agree. The
 * template also carries the `dependsOn` edges the loose files never stated.
 *
 * SECRET CONVENTION: destination JSON in the archive ALWAYS carries the
 * `<replace me>` placeholder (SENTINEL_SECRET_PLACEHOLDER), never a real secret
 * and never the `!{sentinel_client_secret}` reference (that reference only makes
 * sense inside a live Cribl). The exporter FORCES the placeholder defensively,
 * so an air-gap archive can never leak a transient secret even if a fully-formed
 * config is handed in.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { buildArmTemplate } from "../../domain/arm-template";
import {
  buildCrbl,
  buildUstarTar,
  type TarFileEntry,
} from "../../domain/pack-assembly";
import {
  SENTINEL_SECRET_PLACEHOLDER,
  type SentinelDestinationConfig,
} from "../../domain/sentinel-destination";
import type { CollectedArmRequest } from "../onboard-batch";

/** The single ARM deployment template's path inside the archive. */
export const AIR_GAP_ARM_TEMPLATE_PATH = "arm-templates/azure-deploy.json";

/** Input for {@link buildAirGapArchive}. */
export interface AirGapExportInput {
  /** Human-readable solution/vendor name (README heading). */
  solutionName: string;
  /** Pack name (archive .crbl file name, README, route filter guidance). */
  packName: string;
  /** The built .crbl pack bytes, when a pack was assembled. */
  crbl?: Uint8Array;
  /** Per-table ARM request bodies (from onboard-batch templateOnly collection). */
  armRequests: readonly CollectedArmRequest[];
  /** Deployed Cribl Sentinel destination configs (secret forced to placeholder). */
  destinations: readonly SentinelDestinationConfig[];
  /** Cribl source id for the README route filter guidance (optional). */
  sourceId?: string;
  /** Deterministic archive mtime (epoch seconds) - injected, never Date.now(). */
  mtimeSec: number;
}

/** The assembled archive plus its manifest. */
export interface AirGapArchive {
  /** The in-memory file set (relPath -> bytes), report files already excluded. */
  entries: TarFileEntry[];
  /** File names in the archive, in insertion order (manifest). */
  fileNames: string[];
  /** The raw (uncompressed) ustar tar of {@link entries}. */
  tar: Uint8Array;
  /** The gzipped archive delivered via ArtifactSink (a .tgz / .crbl stream). */
  archive: Uint8Array;
  /** The generated README markdown (also included as a file in the archive). */
  readme: string;
  /**
   * The scope the ARM template must be deployed to, and anything the template
   * could NOT include. `scopeConflicts`/`unparseable` are non-empty only when
   * the collected requests span more than one resource group or name no
   * resource; the caller surfaces them rather than shipping a silent partial.
   */
  arm: {
    subscriptionId: string;
    resourceGroup: string;
    scopeConflicts: string[];
    unparseable: string[];
    resourceCount: number;
  };
}

const ENCODER = new TextEncoder();

/** Destination config -> its archive path under cribl-destinations/. */
function destinationPath(config: SentinelDestinationConfig): string {
  return `cribl-destinations/${config.id}.json`;
}

/**
 * Generate the deploy README (pack-builder.ts 2707-2735, ported verbatim in
 * structure; ASCII only). Lists the archive contents and the three manual
 * deploy steps: Azure ARM, pack import, route configuration.
 *
 * The Azure step names the EXACT subscription and resource group the template
 * must go to (DBT-33). It is not advice: the bodies carry absolute resource
 * ids, so a deployment into a different group would build resources that point
 * at the wrong workspace and endpoint - and would do it without failing.
 */
export function generateAirGapReadme(
  input: AirGapExportInput,
  fileNames: readonly string[],
  scope?: { subscriptionId: string; resourceGroup: string },
): string {
  const sourceId = input.sourceId ?? "your_source_id";
  const subscriptionId =
    scope !== undefined && scope.subscriptionId !== ""
      ? scope.subscriptionId
      : "<your-subscription-id>";
  const resourceGroup =
    scope !== undefined && scope.resourceGroup !== ""
      ? scope.resourceGroup
      : "<your-resource-group>";
  const hasTemplate = fileNames.includes(AIR_GAP_ARM_TEMPLATE_PATH);
  return [
    `# ${input.solutionName} - Deployment Artifacts`,
    "",
    "Generated by Cribl SOC Optimization Toolkit",
    "",
    "## Contents",
    "",
    ...fileNames.map((name) => `- \`${name}\``),
    "",
    "## Deployment Steps",
    "",
    "### 1. Azure Resources",
    ...(hasTemplate
      ? [
          `- \`${AIR_GAP_ARM_TEMPLATE_PATH}\` is one ARM deployment template holding every`,
          "  resource this onboard would have created, with the dependencies between",
          "  them declared, so a single deployment brings them up in the right order.",
          "- Deploy it to the subscription and resource group below. The template",
          "  contains absolute resource ids, so deploying it elsewhere produces",
          "  resources that point at the wrong workspace and endpoint:",
          "",
          "```",
          "az deployment group create \\",
          `  --subscription ${subscriptionId} \\`,
          `  --resource-group ${resourceGroup} \\`,
          `  --template-file ${AIR_GAP_ARM_TEMPLATE_PATH}`,
          "```",
          "",
          "- Or in the Azure Portal: Deploy a custom template > Build your own",
          "  template in the editor > Load file, then select that same subscription",
          "  and resource group.",
        ]
      : [
          "- No Azure resources were collected for this export, so there is no",
          "  template to deploy. Everything below still applies.",
        ]),
    "",
    "### 2. Cribl Pack",
    `- Import \`${input.packName}.crbl\` into Cribl Stream via Packs > Add Pack > Import from File`,
    "- Configure the Sentinel destination with your DCR credentials",
    "- The destination configs in `cribl-destinations/` contain the DCR IDs and endpoints",
    "- Replace the `<replace me>` secret placeholder with your app-registration client secret",
    "",
    "### 3. Route Configuration",
    "- Create a route in Cribl that directs your source to the pack pipeline",
    `- Filter: \`__inputId=='${sourceId}'\``,
    `- Pipeline: \`pack:${input.packName}\``,
    "",
  ].join("\n");
}

/**
 * Assemble the air-gap artifact set into ONE archive, in memory. The returned
 * `archive` is the single gzipped stream to hand to ArtifactSink.save; `tar` and
 * `entries` are exposed for round-trip verification against the Unit 19 parser.
 */
export function buildAirGapArchive(input: AirGapExportInput): AirGapArchive {
  const entries: TarFileEntry[] = [];
  const fileNames: string[] = [];

  const add = (path: string, content: Uint8Array): void => {
    entries.push({ path, content });
    fileNames.push(path);
  };

  if (input.crbl !== undefined) {
    add(`${input.packName}.crbl`, input.crbl);
  }

  // ONE deployment template for every collected request, with the dependency
  // edges between them (DBT-33). Omitted entirely when nothing was collected -
  // an empty resources[] would be a template that deploys nothing while the
  // README pointed at it as the Azure step.
  const arm = buildArmTemplate(input.armRequests);
  if (arm.template.resources.length > 0) {
    add(
      AIR_GAP_ARM_TEMPLATE_PATH,
      ENCODER.encode(JSON.stringify(arm.template, null, 2)),
    );
  }

  for (const config of input.destinations) {
    // Defensive: air-gap artifacts ALWAYS ship the placeholder, never a real
    // secret and never the live-Cribl reference.
    const safe: SentinelDestinationConfig = {
      ...config,
      secret: SENTINEL_SECRET_PLACEHOLDER,
    };
    add(destinationPath(config), ENCODER.encode(JSON.stringify(safe, null, 2)));
  }

  // README lists every file added so far; it is itself the last file.
  const readme = generateAirGapReadme(input, fileNames, {
    subscriptionId: arm.subscriptionId,
    resourceGroup: arm.resourceGroup,
  });
  add("README-deployment.md", ENCODER.encode(readme));

  return {
    entries,
    fileNames,
    tar: buildUstarTar(entries, input.mtimeSec),
    archive: buildCrbl(entries, input.mtimeSec),
    readme,
    arm: {
      subscriptionId: arm.subscriptionId,
      resourceGroup: arm.resourceGroup,
      scopeConflicts: arm.scopeConflicts,
      unparseable: arm.unparseable,
      resourceCount: arm.template.resources.length,
    },
  };
}
