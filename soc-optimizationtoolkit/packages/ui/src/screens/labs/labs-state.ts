/**
 * Labs screen state - roadmap Phase 5. The pure decision layer behind
 * LabsScreen: form defaults, form -> LabPlanInput parsing, deploy gating,
 * plan/result formatting, and the plan artifact. All lab knowledge lives in
 * @soc/core (domain/labs + provision-lab); this module only adapts it to the
 * screen's controls.
 *
 * Pure: no IO, no fetch, no React, no Date (the expiry preview takes an
 * injected nowIso), no crypto.
 */

import {
  buildLabPlan,
  labTtlInstants,
  provisionLabStepsFor,
  type JobStep,
  type LabComponentFlags,
  type LabCriblBundle,
  type LabMode,
  type LabOnPremConnection,
  type LabPermissionCheckOutcome,
  type LabPhase,
  type LabPlan,
  type LabPlanInput,
  type LabResourceGroupMode,
  type LabResourceNames,
  type LabType,
  type ProvisionLabResult,
} from "@soc/core";

/** The Labs screen's raw control values (all strings straight from inputs). */
export interface LabFormState {
  labType: LabType;
  labMode: LabMode;
  rgMode: LabResourceGroupMode;
  resourceGroupPrefix: string;
  existingResourceGroupName: string;
  location: string;
  baseObjectName: string;
  ttlHours: string;
  ttlWarningHours: string;
  ttlEmail: string;
  /** TRANSIENT VM admin password (profiles that deploy test VMs). */
  vmPassword: string;
  /** Optional on-premises VPN details (profiles that deploy a gateway). */
  onPremGatewayIp: string;
  onPremAddressSpace: string;
  onPremSharedKey: string;
}

/**
 * Defaults: SentinelLab (the toolkit's Sentinel-centric focus; CompleteLab
 * with its ADX cost stays one click away), public mode, create-new RG with
 * the legacy TTL defaults (72h lifetime, 24h warning).
 */
export function defaultLabFormState(): LabFormState {
  return {
    labType: "SentinelLab",
    labMode: "public",
    rgMode: "create-new",
    resourceGroupPrefix: "rg-lab",
    existingResourceGroupName: "",
    location: "eastus",
    baseObjectName: "",
    ttlHours: "72",
    ttlWarningHours: "24",
    ttlEmail: "",
    vmPassword: "",
    onPremGatewayIp: "",
    onPremAddressSpace: "",
    onPremSharedKey: "",
  };
}

/** Tolerant integer parse: junk becomes NaN, which the core validators reject. */
function parseIntStrict(value: string): number {
  const trimmed = value.trim();
  if (!/^-?[0-9]+$/.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
}

/** Map the form onto the core plan input (validation runs in buildLabPlan). */
export function labPlanInputFromForm(
  form: LabFormState,
  subscriptionId: string,
): LabPlanInput {
  return {
    labType: form.labType,
    labMode: form.labMode,
    subscriptionId,
    rgMode: form.rgMode,
    resourceGroupPrefix: form.resourceGroupPrefix.trim(),
    existingResourceGroupName: form.existingResourceGroupName.trim(),
    location: form.location.trim(),
    baseObjectName: form.baseObjectName.trim(),
    ttl: {
      hours: parseIntStrict(form.ttlHours),
      warningHours: parseIntStrict(form.ttlWarningHours),
      userEmail: form.ttlEmail.trim(),
    },
  };
}

/** Build the plan from the form in one step (the screen's single source). */
export function labPlanFromForm(form: LabFormState, subscriptionId: string): LabPlan {
  return buildLabPlan(labPlanInputFromForm(form, subscriptionId));
}

/**
 * Deploy gate: the plan must validate, the shell must provide the GUID
 * minter (absent minter = a shell wiring gap surfaced as a reason, the same
 * convention as the role-assignment step), and a profile that deploys test
 * VMs needs the transient admin password.
 */
export function canDeployFoundation(
  plan: LabPlan,
  hasMinter: boolean,
  vmPasswordMissing = false,
): { ok: boolean; reason: string } {
  if (plan.errors.length > 0) {
    return { ok: false, reason: "Resolve the validation errors above first." };
  }
  if (!hasMinter) {
    return {
      ok: false,
      reason:
        "This shell did not provide a role-assignment id minter (mintAssignmentName) - a wiring gap, not a runtime state.",
    };
  }
  if (vmPasswordMissing) {
    return {
      ok: false,
      reason:
        "This profile deploys test VMs - enter the transient VM admin password first.",
    };
  }
  return { ok: true, reason: "" };
}

/** True when the profile deploys VMs but the form holds no password yet. */
export function vmPasswordMissing(plan: LabPlan, form: LabFormState): boolean {
  return plan.flags.virtualMachines.deployVMs && form.vmPassword.trim() === "";
}

/**
 * The optional on-premises connection from the form: undefined when every
 * field is blank (the connection step then reports itself skipped).
 */
export function onPremFromForm(form: LabFormState): LabOnPremConnection | undefined {
  const ip = form.onPremGatewayIp.trim();
  const space = form.onPremAddressSpace.trim();
  const key = form.onPremSharedKey.trim();
  if (ip === "" && space === "" && key === "") {
    return undefined;
  }
  return {
    gatewayIpAddress: ip,
    addressSpaces: space === "" ? [] : space.split(",").map((s) => s.trim()),
    sharedKey: key,
  };
}

/** "Phase 4 - Monitoring: Log Analytics, Microsoft Sentinel, Private Link" */
export function formatLabPhaseLine(phase: LabPhase): string {
  return `Phase ${phase.number} - ${phase.title}: ${phase.steps.join(", ")}`;
}

/** The TTL expiry preview for the current form values ("" when unparseable). */
export function ttlExpiryPreview(form: LabFormState, nowIso: string): string {
  const hours = parseIntStrict(form.ttlHours);
  const warningHours = parseIntStrict(form.ttlWarningHours);
  if (!Number.isInteger(hours) || hours < 1 || !Number.isInteger(warningHours)) {
    return "";
  }
  const instants = labTtlInstants(
    { hours, warningHours, userEmail: form.ttlEmail },
    nowIso,
  );
  return `self-destructs ${instants.expirationTime} (warning ${instants.warningTime})`;
}

/** One planned-resource row for the preview table. */
export interface LabNameRow {
  label: string;
  value: string;
}

/**
 * The planned-resource rows, filtered to what the profile actually deploys
 * (a Sentinel lab preview does not list a VPN gateway it will never create).
 */
export function labResourceNameRows(
  names: LabResourceNames,
  flags: LabComponentFlags,
): LabNameRow[] {
  const rows: LabNameRow[] = [];
  if (flags.infrastructure.deployVNet) {
    rows.push({ label: "Virtual network", value: names.vnet });
  }
  if (flags.infrastructure.deployNSGs) {
    for (const [subnetKey, nsg] of Object.entries(names.nsgBySubnet)) {
      rows.push({ label: `NSG (${subnetKey})`, value: nsg });
    }
  }
  if (flags.infrastructure.deployVPN) {
    rows.push({ label: "VPN gateway", value: names.vpnGateway });
    rows.push({ label: "VPN public IP", value: names.vpnPublicIp });
  }
  if (flags.storage.deploy) {
    rows.push({ label: "Storage account", value: names.storageAccount });
  }
  if (flags.monitoring.deployLogAnalytics || flags.monitoring.deploySentinel) {
    rows.push({ label: "Log Analytics workspace", value: names.logAnalytics });
  }
  if (flags.monitoring.deployFlowLogs) {
    rows.push({ label: "Network Watcher", value: names.networkWatcher });
  }
  if (flags.analytics.deployEventHub) {
    rows.push({ label: "Event Hub namespace", value: names.eventHubNamespace });
    for (const hub of names.eventHubs) {
      rows.push({ label: "Event Hub", value: hub });
    }
  }
  if (flags.analytics.deployADX) {
    rows.push({ label: "ADX cluster", value: names.adxCluster });
  }
  return rows;
}

/** The downloadable plan artifact (deterministic for a given plan). */
export function labPlanArtifact(plan: LabPlan): { filename: string; json: string } {
  return {
    filename: `lab-plan-${plan.labType}-${plan.labMode}.json`,
    json: JSON.stringify(
      {
        labType: plan.labType,
        labMode: plan.labMode,
        resourceGroupName: plan.resourceGroupName,
        rgMode: plan.rgMode,
        location: plan.location,
        phases: plan.phases.map(formatLabPhaseLine),
        resources: plan.names,
        permissions: plan.permissions,
        warnings: plan.warnings,
      },
      null,
      2,
    ),
  };
}

/** The pre-seeded pending step list for a plan's deploy run. */
export function initialLabSteps(flags: LabComponentFlags): JobStep[] {
  return provisionLabStepsFor(flags).map((name) => ({
    name,
    status: "pending" as const,
  }));
}

/** One created/reused resource line ("created" vs "existed"). */
function resourceLine(label: string, name: string, created: boolean): string {
  return `${label} ${created ? "created" : "already existed"}: ${name}`;
}

/** Honest, line-by-line summary of a lab deployment outcome. */
export function labRunResultLines(result: ProvisionLabResult): string[] {
  const lines: string[] = [];
  lines.push(
    result.resourceGroupCreated
      ? `Resource group created: ${result.resourceGroupId}`
      : `Resource group already existed - TTL extended: ${result.resourceGroupId}`,
  );
  lines.push(`TTL self-destruct expires ${result.ttlExpiresAt}`);
  lines.push(
    result.logicAppCreated
      ? `TTL watchdog Logic App created: ${result.logicAppName}`
      : `TTL watchdog Logic App already existed: ${result.logicAppName}`,
  );
  if (result.principalId !== "") {
    lines.push(`Watchdog identity principal id: ${result.principalId}`);
  }
  if (result.roleAssigned) {
    lines.push(
      result.roleAlreadyAssigned
        ? "Watchdog delete permission was already granted."
        : "Watchdog granted Contributor on the resource group (it can now self-delete).",
    );
  } else if (result.manualRoleAssignmentCommand !== undefined) {
    lines.push(
      "Watchdog could NOT be granted delete permission - the lab will not self-destruct until an admin runs:",
    );
    lines.push(result.manualRoleAssignmentCommand);
  }
  if (result.storage !== undefined) {
    lines.push(
      resourceLine(
        "Storage account",
        result.storage.accountName,
        result.storage.accountCreated,
      ),
    );
    for (const container of result.storage.containers) {
      lines.push(resourceLine("Container", container.name, container.created));
    }
    for (const queue of result.storage.queues) {
      lines.push(resourceLine("Queue", queue.name, queue.created));
    }
    if (result.storage.eventGridTopic !== undefined) {
      lines.push(
        `Event Grid system topic: ${result.storage.eventGridTopic} ` +
          `(subscriptions: ${(result.storage.eventGridSubscriptions ?? []).join(", ")})`,
      );
    }
  }
  if (result.networking !== undefined) {
    for (const nsg of result.networking.nsgs) {
      lines.push(resourceLine("NSG", nsg.name, nsg.created));
    }
    lines.push(`Virtual network deployed: ${result.networking.vnetName}`);
  }
  if (result.monitoring !== undefined) {
    lines.push(
      resourceLine(
        "Log Analytics workspace",
        result.monitoring.workspaceName,
        result.monitoring.workspaceCreated,
      ),
    );
    if (result.monitoring.sentinelEnabled) {
      lines.push(
        result.monitoring.sentinelAlreadyEnabled
          ? "Microsoft Sentinel was already enabled on the workspace."
          : "Microsoft Sentinel enabled on the workspace.",
      );
    }
  }
  if (result.privateLink !== undefined) {
    lines.push(
      `Private Link: ${result.privateLink.amplsName} with endpoint ` +
        `${result.privateLink.privateEndpointName}` +
        (result.privateLink.dnsZoneLinked ? " (DNS zone linked)" : ""),
    );
  }
  if (result.analytics !== undefined) {
    if (result.analytics.namespaceName !== undefined) {
      lines.push(
        resourceLine(
          "Event Hub namespace",
          result.analytics.namespaceName,
          result.analytics.namespaceCreated === true,
        ),
      );
      for (const hub of result.analytics.hubs ?? []) {
        lines.push(resourceLine("Event Hub", hub.name, hub.created));
      }
    }
    if (result.analytics.adxClusterName !== undefined) {
      lines.push(
        resourceLine(
          "ADX cluster",
          result.analytics.adxClusterName,
          result.analytics.adxClusterCreated === true,
        ) +
          (result.analytics.adxClusterUri !== undefined &&
          result.analytics.adxClusterUri !== ""
            ? ` (${result.analytics.adxClusterUri})`
            : ""),
      );
    }
  }
  if (result.flowLogs !== undefined) {
    lines.push(
      `${result.flowLogs.flowLogs.length} flow log(s) via Network Watcher ` +
        result.flowLogs.networkWatcher,
    );
  }
  if (result.compute !== undefined) {
    for (const vm of result.compute.vms) {
      lines.push(resourceLine("Test VM", vm.name, vm.created));
    }
    if (result.compute.autoShutdownConfigured) {
      lines.push("VM auto-shutdown schedules configured (daily, cost control).");
    }
  }
  if (result.dcrs !== undefined) {
    for (const dcr of result.dcrs) {
      if (dcr.error !== undefined) {
        lines.push(`DCR for ${dcr.table} FAILED: ${dcr.error}`);
      } else {
        lines.push(
          `DCR ${dcr.dcrName} (${dcr.table}${dcr.reused ? ", reused" : ""}): ` +
            `immutable id ${dcr.immutableId}, ingest ${dcr.logsIngestionEndpoint}`,
        );
      }
    }
  }
  if (result.gateway !== undefined) {
    lines.push(
      `VPN gateway ${result.gateway.gatewayName}: ` +
        (result.gateway.gatewayReady
          ? "ready"
          : `still provisioning (${result.gateway.provisioningState || "state unknown"})`),
    );
    if (result.gateway.connectionName !== undefined) {
      lines.push(`Site-to-site connection deployed: ${result.gateway.connectionName}`);
    }
  }
  if (result.criblConfigs !== undefined) {
    const bundle = result.criblConfigs;
    lines.push(
      `Cribl configs generated: ${bundle.adxDestinations.length} destination(s), ` +
        `${bundle.eventHubSources.length + bundle.blobSources.length} source(s); ` +
        `required Cribl secrets: ${bundle.requiredSecrets.map((s) => s.name).join(", ") || "none"}. ` +
        "Download the bundle below.",
    );
  }
  return lines;
}

/**
 * Render the permission-check outcome as honest, line-by-line text: one
 * [OK]/[MISSING] row per profile action, then the TTL-grant condition
 * analysis (the ABAC case a live deploy fails on), remediation, and notes.
 */
export function permissionCheckLines(outcome: LabPermissionCheckOutcome): string[] {
  const lines: string[] = [`Permissions evaluated at ${outcome.scope}`];
  for (const check of outcome.checks) {
    lines.push(`[${check.granted ? "OK" : "MISSING"}] ${check.label} (${check.action})`);
  }
  switch (outcome.roleAssignmentGrant.kind) {
    case "unconditional":
      lines.push(
        "TTL grant: roleAssignments/write is held without a condition - the " +
          "self-destruct grant will succeed.",
      );
      break;
    case "conditional-allows-contributor":
      lines.push(
        "TTL grant: roleAssignments/write is held through a CONDITIONAL " +
          "(ABAC) assignment whose condition appears to allow Contributor - " +
          "expected to succeed (best-effort textual check).",
      );
      break;
    case "conditional-blocks-contributor":
      lines.push(
        "TTL grant: roleAssignments/write is held ONLY through a conditional " +
          "(ABAC) assignment that does NOT appear to allow Contributor - the " +
          "deploy WILL fail at ttl-role-assignment.",
      );
      break;
    case "conditional-constrains-principals":
      lines.push(
        "TTL grant: the conditional (ABAC) assignment pins SPECIFIC principal " +
          "ids - unsatisfiable for the deploy-time TTL identity; the deploy " +
          "WILL fail at ttl-role-assignment.",
      );
      break;
    case "not-granted":
      lines.push(
        "TTL grant: roleAssignments/write is not granted at this scope - " +
          "create-new mode needs a (constrained) RBAC Administrator " +
          "assignment; bring-your-own mode expects an admin to grant the TTL " +
          "identity manually after deploy.",
      );
      break;
  }
  if (outcome.roleConditionRemediation !== undefined) {
    lines.push(outcome.roleConditionRemediation);
  }
  for (const note of outcome.notes) {
    lines.push(`Note: ${note}`);
  }
  return lines;
}

/** The downloadable Cribl config bundle artifact (deterministic per run). */
export function criblBundleArtifact(
  bundle: LabCriblBundle,
  labType: LabType,
  labMode: LabMode,
): { filename: string; json: string } {
  return {
    filename: `lab-cribl-configs-${labType}-${labMode}.json`,
    json: JSON.stringify(bundle, null, 2),
  };
}
