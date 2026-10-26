/**
 * Shapes for the Azure Logging Map (AZR-19, phase 1, READ-ONLY).
 *
 * The map answers "which policy assignments deploy diagnostic settings, where
 * are they assigned, what do they reach, and who owns them". Everything here is
 * a plain data shape: the ARM parsers in `parse-arm.ts` produce them, the scope
 * tree in `scope-tree.ts` arranges them, and the coverage/ownership modules
 * judge them.
 *
 * Pure: no IO, no Date, no randomness. Domain code - must not import usecases
 * (see the header of `parse-arm.ts` for the rule and its citations).
 */

import type { ListRead } from "./list-read";

/**
 * What a node in the scope tree is.
 *
 * - `tenant-root`: the Tenant Root Group, the management group whose name is
 *   the tenant id.
 * - `management-group` / `subscription`: real Azure scopes.
 * - `placeholder`: a node that is NOT an Azure scope - the single holder for
 *   subscriptions whose parent was never read (treeRole `parent-unknown`).
 */
export type ScopeKind =
  | "tenant-root"
  | "management-group"
  | "subscription"
  | "placeholder";

/**
 * Why a node is in the tree. This is a TREE fact and deliberately not a read
 * verdict: whether the node's assignments or exemptions could be read lives in
 * its {@link ScopeRead}, the one place a read verdict is kept.
 *
 * - `listed`: the scope came back from a hierarchy read (descendants, the
 *   management-group list, or GET /subscriptions).
 * - `unread-origin`: the scope was never listed; it is known only because an
 *   assignment inherited by a readable scope names it as its origin
 *   (`properties.scope`). It must never be drawn as covered or as empty.
 * - `parent-unknown`: the synthetic holder for subscriptions whose parent
 *   management group was not read.
 */
export type ScopeTreeRole = "listed" | "unread-origin" | "parent-unknown";

/** One node of the management-group / subscription hierarchy. */
export interface ScopeNode {
  /** Normalised (lower-case, no trailing slash) ARM scope id. */
  readonly id: string;
  readonly kind: ScopeKind;
  /** The ARM `name` - the MG name or the subscription GUID. */
  readonly name: string;
  /** Human-readable name; falls back to `name` when ARM gave none. */
  readonly displayName: string;
  /** Normalised parent id, or null for a root. */
  readonly parentId: string | null;
  readonly treeRole: ScopeTreeRole;
}

/** `properties.resourceSelectors[*].selectors[*]` of a policy assignment. */
export interface ResourceSelectorClause {
  /** e.g. `resourceLocation`, `resourceType`. */
  readonly kind: string;
  readonly in: readonly string[];
  readonly notIn: readonly string[];
}

/** One `properties.resourceSelectors[*]` entry. */
export interface ResourceSelector {
  readonly name: string;
  readonly selectors: readonly ResourceSelectorClause[];
}

/** One user-assigned identity on an assignment. */
export interface UserAssignedIdentityRef {
  /** The identity's resource id, as ARM spelled it (the map key). */
  readonly id: string;
  readonly principalId: string | null;
}

/** The managed identity block of a policy assignment. */
export interface AssignmentIdentity {
  /** `SystemAssigned`, `UserAssigned` or `None` (the default when absent). */
  readonly type: string;
  /** The system-assigned principal id, when ARM gave one. */
  readonly principalId: string | null;
  readonly userAssigned: readonly UserAssignedIdentityRef[];
}

/** Whether `policyDefinitionId` names a single definition or an initiative. */
export type DefinitionKind = "policy" | "set" | "unknown";

/** One policy assignment, as ARM returned it. Ids keep ARM's own casing. */
export interface PolicyAssignment {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  /**
   * `properties.scope` - where the assignment is SET. Under an `atScope()`
   * read this differs from the read scope for inherited assignments, and is
   * how an unread parent becomes an `unread-origin` node.
   */
  readonly scope: string;
  readonly policyDefinitionId: string;
  readonly definitionKind: DefinitionKind;
  readonly notScopes: readonly string[];
  /**
   * Parameter VALUES, unwrapped from ARM's `{ name: { value } }` envelope.
   * An entry with no `value` key is omitted, so `name in parameters` means the
   * assignment really set it.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** `properties.metadata`, or `{}`. Azure stamps createdBy etc. here. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly identity: AssignmentIdentity;
  /** `Default` or `DoNotEnforce`; `Default` when absent. */
  readonly enforcementMode: string;
  readonly resourceSelectors: readonly ResourceSelector[];
}

/** One policy exemption. */
export interface PolicyExemption {
  readonly id: string;
  readonly name: string;
  /** The scope the exemption is placed at, derived from its id. */
  readonly scope: string;
  readonly policyAssignmentId: string;
  /** `Waiver` or `Mitigated`; '' when absent. */
  readonly category: string;
  /** ISO timestamp, or null for a non-expiring exemption. */
  readonly expiresOn: string | null;
  readonly policyDefinitionReferenceIds: readonly string[];
}

/** One parameter declared by a policy definition or set definition. */
export interface DefinitionParameter {
  readonly type: string;
  /** True when the definition declares a `defaultValue` (it may be null). */
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
}

/** A single policy definition. */
export interface PolicyDefinition {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  /** `BuiltIn`, `Custom`, `Static`; '' when absent. */
  readonly policyType: string;
  readonly mode: string;
  readonly parameters: Readonly<Record<string, DefinitionParameter>>;
  /** `policyRule.then.effect` exactly as written: a literal or `[parameters('x')]`. */
  readonly thenEffect: unknown;
  /** `policyRule.then.details.type`, as written; '' when absent. */
  readonly thenDetailsType: string;
  /** The whole `policyRule`, untouched, for anything the classifier needs later. */
  readonly policyRule: unknown;
}

/** One member of a policy set definition. */
export interface PolicySetMember {
  readonly policyDefinitionId: string;
  readonly referenceId: string;
  /** Member parameter values, unwrapped from `{ name: { value } }`. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A policy set definition (initiative). */
export interface PolicySetDefinition {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly policyType: string;
  readonly parameters: Readonly<Record<string, DefinitionParameter>>;
  readonly members: readonly PolicySetMember[];
}

/** One role assignment held by an assignment's identity. */
export interface RoleGrant {
  readonly scope: string;
  readonly roleDefinitionId: string;
  /** Filled from the role definition read; null until (or unless) read. */
  readonly roleName: string | null;
}

/** A role definition's id and display name. */
export interface RoleDefinitionInfo {
  readonly id: string;
  readonly roleName: string;
}

/**
 * The two per-scope list reads of one scope. Each carries its OWN verdict, so
 * "no exemptions here" (read, zero rows) and "exemptions unreadable" (refused)
 * are different values. There is no separate refusals list beside it -
 * `refusalsOf` derives one.
 */
export interface ScopeRead {
  /** Normalised scope id. */
  readonly scopeId: string;
  readonly assignments: ListRead<PolicyAssignment>;
  readonly exemptions: ListRead<PolicyExemption>;
}

/**
 * A hierarchy entry before it becomes a {@link ScopeNode}: what a descendants
 * row, a management group, or a subscription parses to.
 */
export interface ScopeEntry {
  /** ARM id, any casing. */
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  /** ARM parent id, any casing, or null when the read did not say. */
  readonly parentId: string | null;
}

/** A management group read with `$expand=path`. */
export interface ManagementGroupWithPath extends ScopeEntry {
  /** Ancestor names from `properties.path`, as ARM listed them. */
  readonly pathNames: readonly string[];
}

/** A subscription from GET /subscriptions. */
export interface SubscriptionEntry extends ScopeEntry {
  readonly subscriptionId: string;
  /** `Enabled`, `Disabled`, `Warned`...; '' when absent. */
  readonly state: string;
}
