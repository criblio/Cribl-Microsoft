/**
 * Azure ARM resource-id parser - TOLERANT, TOTAL, PURE.
 *
 * Azure Resource Manager (ARM) identifies every resource by a path-shaped id:
 *
 *   /subscriptions/{sub}/resourceGroups/{rg}/providers/{namespace}/{type}/{name}
 *
 * Nested (child) resource types extend the tail with additional `/{type}/{name}`
 * pairs, e.g. a subnet:
 *
 *   /subscriptions/S/resourceGroups/R/providers/Microsoft.Network
 *     /virtualNetworks/my-vnet/subnets/my-subnet
 *
 * This module extracts the well-known parts so the resource-discovery dropdowns
 * can label and group resources without every caller re-implementing the split.
 *
 * The segment KEYS ('subscriptions', 'resourceGroups', 'providers') are matched
 * CASE-INSENSITIVELY: Azure canonically returns 'resourceGroups', but other
 * casings ('resourcegroups', 'RESOURCEGROUPS') show up in hand-written ids and
 * older API responses. The VALUES that follow each key are returned VERBATIM -
 * casing, hyphens, and dots preserved - because they are identifiers the rest of
 * the system must round-trip exactly.
 *
 * {@link parseResourceId} is deliberately TOLERANT and TOTAL: it accepts any
 * string (or null/undefined), never throws, and returns a well-formed
 * {@link ParsedResourceId} with '' for every part it cannot find.
 *
 * Pure: no IO, no fetch, no React.
 */

/**
 * The well-known parts of an Azure ARM resource id. Every field is '' when that
 * part is absent from the input.
 */
export interface ParsedResourceId {
  /** Value after a case-insensitive 'subscriptions' segment. */
  subscriptionId: string;
  /** Value after a case-insensitive 'resourceGroups' segment. */
  resourceGroup: string;
  /** Provider namespace: the value immediately after 'providers'. */
  provider: string;
  /** The type segment of the final `/{type}/{name}` pair after 'providers'. */
  resourceType: string;
  /** The resource's own name: the last path segment. */
  name: string;
}

/** An all-empty {@link ParsedResourceId}; the result for unparseable input. */
const EMPTY_PARSED_RESOURCE_ID: ParsedResourceId = {
  subscriptionId: "",
  resourceGroup: "",
  provider: "",
  resourceType: "",
  name: "",
};

/**
 * Return the segment immediately following the first case-insensitive match of
 * `key` in `segments`, or '' if `key` is absent or is the final segment.
 */
function valueAfter(
  segments: readonly string[],
  lowerSegments: readonly string[],
  key: string,
): string {
  const index = lowerSegments.indexOf(key);
  if (index < 0 || index + 1 >= segments.length) {
    return "";
  }
  return segments[index + 1];
}

/**
 * Parse an untrusted Azure ARM resource id into its well-known parts.
 *
 * TOLERANT and TOTAL - NEVER throws. Returns an all-empty
 * {@link ParsedResourceId} for null, undefined, or a string with no usable
 * segments (e.g. '', '/', 'garbage').
 *
 * The id is split on '/' with empty segments dropped, so leading, trailing, and
 * doubled slashes are all tolerated. Then:
 *   - subscriptionId = value after a case-insensitive 'subscriptions' segment
 *   - resourceGroup  = value after a case-insensitive 'resourceGroups' segment
 *   - provider       = value immediately after a case-insensitive 'providers'
 *   - resourceType/name = the LAST `/{type}/{name}` pair after 'providers'
 *     (name is the final segment; resourceType is the segment before it)
 *
 * When there is no 'providers' section, `name` falls back to the resourceGroup
 * value, or the subscriptionId value, whichever is present (resourceType stays
 * '' in that case).
 */
export function parseResourceId(
  id: string | null | undefined,
): ParsedResourceId {
  if (typeof id !== "string") {
    return { ...EMPTY_PARSED_RESOURCE_ID };
  }

  // Drop empty segments so leading/trailing/doubled slashes are all tolerated.
  const segments = id.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return { ...EMPTY_PARSED_RESOURCE_ID };
  }

  const lowerSegments = segments.map((segment) => segment.toLowerCase());

  const subscriptionId = valueAfter(segments, lowerSegments, "subscriptions");
  const resourceGroup = valueAfter(segments, lowerSegments, "resourcegroups");

  let provider = "";
  let resourceType = "";
  let name = "";

  const providersIndex = lowerSegments.indexOf("providers");
  if (providersIndex >= 0) {
    // provider namespace is the segment immediately after 'providers'.
    if (providersIndex + 1 < segments.length) {
      provider = segments[providersIndex + 1];
    }
    // Everything after the namespace is a run of /{type}/{name} pairs; the
    // resource's own name is the final segment and its type is the one before.
    const afterNamespace = segments.slice(providersIndex + 2);
    if (afterNamespace.length >= 1) {
      name = afterNamespace[afterNamespace.length - 1];
    }
    if (afterNamespace.length >= 2) {
      resourceType = afterNamespace[afterNamespace.length - 2];
    }
  } else {
    // No providers section: the tail resource is the resource group itself, or
    // the subscription when even that is absent.
    name = resourceGroup !== "" ? resourceGroup : subscriptionId;
  }

  return { subscriptionId, resourceGroup, provider, resourceType, name };
}

/**
 * Convenience accessor: the resource group of `id`, or '' if absent. Equivalent
 * to `parseResourceId(id).resourceGroup`; never throws.
 */
export function deriveResourceGroup(id: string | null | undefined): string {
  return parseResourceId(id).resourceGroup;
}

/**
 * The FULL nested type and name of a resource id, as an ARM template declares
 * them. Distinct from {@link ParsedResourceId}, which keeps only the LAST
 * `/{type}/{name}` pair because the dropdowns that use it only ever want the
 * leaf label.
 *
 * An ARM template needs both halves whole: a Log Analytics custom table is
 * `Microsoft.OperationalInsights/workspaces/tables` named `{workspace}/{table}`,
 * and `parseResourceId` would report type `tables` and name `{table}` - correct
 * for a label, unusable in a template.
 */
export interface ArmTypeAndName {
  /** Full nested type, e.g. 'Microsoft.OperationalInsights/workspaces/tables'. */
  type: string;
  /** Full nested name, e.g. 'my-workspace/MyTable_CL'. */
  name: string;
  /** The name split into its segments - the arguments `resourceId()` takes. */
  nameSegments: string[];
}

/**
 * Parse `id` into the full nested type and name an ARM template declares.
 *
 * Returns null - never a partial answer - when the id has no `providers`
 * section, names a namespace with no type, or ends on a type with no name
 * (an odd number of segments after the namespace). A caller building a
 * template must be able to tell "not a resource" from "a resource at the
 * root", and '' cannot carry that difference.
 *
 * TOTAL for any string input: accepts null/undefined and never throws.
 */
export function parseArmTypeAndName(
  id: string | null | undefined,
): ArmTypeAndName | null {
  if (typeof id !== "string") {
    return null;
  }

  const segments = id.split("/").filter((segment) => segment !== "");
  const providersIndex = segments
    .map((segment) => segment.toLowerCase())
    .indexOf("providers");
  if (providersIndex < 0 || providersIndex + 1 >= segments.length) {
    return null;
  }

  const namespace = segments[providersIndex + 1];
  const tail = segments.slice(providersIndex + 2);
  // The tail is a run of /{type}/{name} pairs. An odd length means a type with
  // no name - a collection URL, not a resource.
  if (tail.length === 0 || tail.length % 2 !== 0) {
    return null;
  }

  const typeSegments: string[] = [];
  const nameSegments: string[] = [];
  for (let index = 0; index < tail.length; index += 2) {
    typeSegments.push(tail[index]);
    nameSegments.push(tail[index + 1]);
  }

  return {
    type: `${namespace}/${typeSegments.join("/")}`,
    name: nameSegments.join("/"),
    nameSegments,
  };
}
