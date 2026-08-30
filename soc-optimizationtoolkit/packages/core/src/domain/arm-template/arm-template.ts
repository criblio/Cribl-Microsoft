/**
 * ARM deployment-template envelope (DBT-33).
 *
 * The onboard path collects ARM REST REQUEST BODIES - `{method: "PUT", path,
 * apiVersion, body}`, where `body` is a bare resource. Those deploy fine
 * through `az rest`, but they are NOT deployment templates: no `$schema`, no
 * `resources[]`, nothing Portal's "Deploy a custom template" blade or
 * `az deployment group create` will accept. The air-gap README told operators
 * to use exactly those two, which is the defect this module closes.
 *
 * ONE template for the whole run, not one file per resource. The collected
 * requests have real ordering constraints - a DCR cannot reference a custom
 * table or a DCE that does not exist yet - and a template with `dependsOn`
 * states them once, in the artifact, rather than leaving the operator to
 * rediscover them from file names. Per-resource files would also be a second
 * copy of the same deployment, free to disagree with this one.
 *
 * WHAT IS DELIBERATELY ABSENT: parameters. The template captures precisely the
 * deployment the live path would have performed, locations and all. Adding
 * parameters would invent a second story about what varies, and the bodies
 * carry absolute resource ids (`dataCollectionEndpointId`, the workspace on a
 * DCR destination) that a retargeted deployment would silently contradict.
 * {@link buildArmTemplate} instead REPORTS the single scope the template must
 * be deployed to, and reports it as a conflict when the requests disagree.
 *
 * Resource entries are built by spreading the collected body's own top-level
 * keys (`kind`, `location`, `properties`, whatever a future request adds) and
 * adding `type`/`apiVersion`/`name`/`dependsOn`. There is no kind-to-type
 * table: the type comes from the request's own path, so a new
 * CollectedArmRequestKind needs no change here and cannot drift out of step.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import {
  parseArmTypeAndName,
  parseResourceId,
} from "../azure-resource-id/azure-resource-id";

/** The resource-group-scoped deployment schema (ARM's current published one). */
export const ARM_TEMPLATE_SCHEMA =
  "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#";

/** ARM requires contentVersion; it is metadata and carries no behaviour. */
export const ARM_TEMPLATE_CONTENT_VERSION = "1.0.0.0";

/** The subset of a collected request this module needs. */
export interface ArmTemplateRequest {
  /** Full ARM resource path, e.g. '/subscriptions/S/resourceGroups/R/...'. */
  path: string;
  /** The api-version the live PUT would have used. */
  apiVersion: string;
  /** The bare resource body: `{ [kind], [location], properties }`. */
  body: unknown;
  /** Owning table, or null for run-shared resources (DCE, AMPLS). */
  table?: string | null;
  /** Collected-request kind, used only to pair a DCR with its custom table. */
  kind?: string;
}

/** One entry in the template's `resources` array. */
export interface ArmTemplateResource {
  type: string;
  apiVersion: string;
  name: string;
  dependsOn?: string[];
  [key: string]: unknown;
}

/** A resource-group-scoped ARM deployment template. */
export interface ArmDeploymentTemplate {
  $schema: string;
  contentVersion: string;
  resources: ArmTemplateResource[];
}

/** {@link buildArmTemplate}'s result: the template plus what it could not do. */
export interface ArmTemplateBuild {
  template: ArmDeploymentTemplate;
  /** The subscription every included resource shares ('' when none parsed). */
  subscriptionId: string;
  /** The resource group every included resource shares ('' when none parsed). */
  resourceGroup: string;
  /**
   * Paths whose scope differs from the first resource's. NON-EMPTY MEANS THE
   * TEMPLATE IS INCOMPLETE: those resources are EXCLUDED, because one
   * resource-group deployment cannot create them, and silently relocating them
   * into the majority scope would deploy something nobody asked for.
   */
  scopeConflicts: string[];
  /** Paths that named no ARM resource; also excluded. */
  unparseable: string[];
}

/**
 * The ARM expression that references a resource in the same template.
 * `resourceId('Microsoft.Insights/dataCollectionEndpoints', 'my-dce')`, and one
 * argument per name segment for nested types.
 */
export function resourceIdExpression(
  type: string,
  nameSegments: readonly string[],
): string {
  const args = [type, ...nameSegments]
    .map((part) => `'${part}'`)
    .join(", ");
  return `[resourceId(${args})]`;
}

/** Every string appearing anywhere in `value`, at any depth. */
function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, into);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectStrings(item, into);
    }
  }
}

/** The body's own top-level keys, minus anything the template entry owns. */
function bodyFields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "type" && key !== "apiVersion" && key !== "name" && key !== "dependsOn") {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * Assemble the collected requests into ONE resource-group-scoped ARM template.
 *
 * Dependencies are DERIVED FROM THE DATA, never guessed from collection order,
 * by two rules that between them cover every edge the onboard path produces:
 *
 *   1. REFERENCE - if resource A's body contains resource B's path as a string
 *      anywhere at any depth, A depends on B. This is what links a DCE-based
 *      DCR to its DCE (`properties.dataCollectionEndpointId`) and an AMPLS
 *      scoped resource to the DCE it links (`properties.linkedResourceId`).
 *   2. TABLE - a DCR for table T depends on the custom-table request for the
 *      same T. The DCR body names its table by stream, not by resource id, so
 *      rule 1 cannot see this edge.
 *
 * Requests are kept in collection order; `dependsOn` makes the order the
 * template actually needs explicit, so ARM may parallelise the rest.
 */
export function buildArmTemplate(
  requests: readonly ArmTemplateRequest[],
): ArmTemplateBuild {
  const scopeConflicts: string[] = [];
  const unparseable: string[] = [];

  // Pass 1: parse, and hold the first parsed scope as the deployment target.
  interface Parsed {
    request: ArmTemplateRequest;
    type: string;
    name: string;
    nameSegments: string[];
  }
  const parsedRequests: Parsed[] = [];
  let subscriptionId = "";
  let resourceGroup = "";

  for (const request of requests) {
    const typeAndName = parseArmTypeAndName(request.path);
    if (typeAndName === null) {
      unparseable.push(request.path);
      continue;
    }
    const scope = parseResourceId(request.path);
    if (subscriptionId === "" && resourceGroup === "") {
      subscriptionId = scope.subscriptionId;
      resourceGroup = scope.resourceGroup;
    } else if (
      scope.subscriptionId !== subscriptionId ||
      scope.resourceGroup !== resourceGroup
    ) {
      scopeConflicts.push(request.path);
      continue;
    }
    parsedRequests.push({ request, ...typeAndName });
  }

  // Pass 2: dependency edges, over the resources that survived pass 1 only -
  // a dependsOn pointing at an excluded resource would never resolve.
  const byPath = new Map<string, Parsed>();
  const customTableByTable = new Map<string, Parsed>();
  for (const parsed of parsedRequests) {
    byPath.set(parsed.request.path, parsed);
    if (
      parsed.request.kind === "custom-table" &&
      typeof parsed.request.table === "string"
    ) {
      customTableByTable.set(parsed.request.table, parsed);
    }
  }

  const resources: ArmTemplateResource[] = parsedRequests.map((parsed) => {
    const dependencies = new Set<string>();

    // Rule 1: any other resource's path appearing inside this body.
    const strings = new Set<string>();
    collectStrings(parsed.request.body, strings);
    for (const value of strings) {
      const target = byPath.get(value);
      if (target !== undefined && target !== parsed) {
        dependencies.add(resourceIdExpression(target.type, target.nameSegments));
      }
    }

    // Rule 2: a DCR waits for its own table's creation.
    if (parsed.request.kind === "dcr" && typeof parsed.request.table === "string") {
      const table = customTableByTable.get(parsed.request.table);
      if (table !== undefined) {
        dependencies.add(resourceIdExpression(table.type, table.nameSegments));
      }
    }

    const resource: ArmTemplateResource = {
      type: parsed.type,
      apiVersion: parsed.request.apiVersion,
      name: parsed.name,
      ...bodyFields(parsed.request.body),
    };
    if (dependencies.size > 0) {
      resource.dependsOn = [...dependencies];
    }
    return resource;
  });

  return {
    template: {
      $schema: ARM_TEMPLATE_SCHEMA,
      contentVersion: ARM_TEMPLATE_CONTENT_VERSION,
      resources,
    },
    subscriptionId,
    resourceGroup,
    scopeConflicts,
    unparseable,
  };
}
