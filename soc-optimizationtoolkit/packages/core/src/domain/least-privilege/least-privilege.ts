/**
 * The least-privilege registry - ONE place that says, for every function the
 * app performs, which calls it makes, which operation each call needs, the
 * least built-in role that grants it, at the narrowest scope, and the source
 * that says so (ADR 0009 decision 4, AZR-61).
 *
 * WHY ONE REGISTRY. The roles an operator must ask for used to live in four
 * places - the setup-path role plan, the app-registration catalog, the
 * preflight's REQUIRED_ACTIONS and the How-to rbac lines - and each restated
 * role names and action strings by hand. The 2026-11-03 audit diffed them
 * against what the code actually calls and found 24 discrepancies, three of
 * them high: a permission every Create Cribl source with listKeys needs was
 * asked for nowhere. A role restated in four places drifts four ways; read
 * from one, it drifts nowhere.
 *
 * TWO LEVELS, BECAUSE THE FACTS LIVE AT TWO LEVELS.
 *
 *   - An OPERATION is one kind of call: its method and path template, the
 *     action it needs, the least role, the narrowest scope and the citation.
 *     Those facts belong to the call, whoever makes it, so they are written
 *     once (operations.ts).
 *   - A FUNCTION is something an operator does - deploy a DCR, install
 *     Sentinel content, validate onboarding - and lists the operations it
 *     uses. Necessity (core or feature) belongs to the function.
 *
 * {@link LEAST_PRIVILEGE_REGISTRY} is the product of the two: one row per
 * function and operation, carrying every field ADR 0009 names.
 *
 * WHAT `leastRole` MEANS. The narrowest BUILT-IN role the audit found that
 * grants the operation, at {@link PrivilegeOperation.scope}. It is not always
 * what a change request asks for: a ticket may deliberately ask for a broader
 * role that covers many operations at once (Reader at the subscription rather
 * than eleven narrower read roles), and the consumers that do so say why
 * where they do it. What they may not do is restate a role this registry
 * already names.
 *
 * Measured, not exercised: the audit read the code and Microsoft Learn; no
 * call was made against Azure with a reduced identity. `confidence` carries
 * the audit's own rating per operation.
 *
 * Pure: data and lookups only. No IO, no Date, no Math.random.
 */

import type { PermissionNecessity } from "../azure-permissions/azure-permissions";
import { LEAST_PRIVILEGE_OPERATIONS } from "./operations";
import type { OperationId } from "./operations";
import { LEAST_PRIVILEGE_FUNCTIONS } from "./functions";
import type { FunctionId } from "./functions";

export type { OperationId } from "./operations";
export type { FunctionId } from "./functions";
export { LEAST_PRIVILEGE_OPERATIONS } from "./operations";
export { LEAST_PRIVILEGE_FUNCTIONS } from "./functions";

/** Which API surface a call is made against. */
export type PrivilegeApi = "arm" | "graph" | "entra-token" | "cribl";

/** HTTP verbs the registry records. */
export type PrivilegeMethod = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

/**
 * One call behind an operation.
 *
 * `path` is a TEMPLATE: `{name}` stands for exactly one path segment (any
 * segment containing `{` is a one-segment placeholder, so
 * `SecurityInsights({ws})` is one), and `{*}` stands for one or more segments
 * - a scope that may be a subscription, a resource group or a resource. Query
 * strings are not part of the template. Graph and token paths are absolute
 * URLs; ARM paths are relative to https://management.azure.com.
 */
export interface PrivilegeCall {
  readonly method: PrivilegeMethod;
  readonly path: string;
  readonly api: PrivilegeApi;
}

/**
 * The narrowest scope an operation can be granted at.
 *
 * `resource` means the resource the call addresses (a namespace, a DCR, a
 * workspace); {@link PrivilegeOperation.scopeNote} names which. The `cribl-*`
 * levels are Cribl's: the installed app's own KV namespace, the leader, or a
 * worker group.
 */
export type PrivilegeScope =
  | "tenant"
  | "managementGroup"
  | "subscription"
  | "resourceGroup"
  | "resource"
  | "cribl-app"
  | "cribl-leader"
  | "cribl-group";

/** One kind of call and the least privilege it needs. */
export interface PrivilegeOperation {
  /** The key it is registered under ({@link OperationId}); a string here so the data file can be typed against this interface. */
  readonly id: string;
  readonly calls: readonly PrivilegeCall[];
  /**
   * The RBAC action, Graph application permission or Cribl permission the
   * call needs - the exact string the preflight checks, for Azure.
   */
  readonly operation: string;
  /** Further actions the same call needs (a flow log PUT also writes storage). */
  readonly extraActions?: readonly string[];
  /** The narrowest built-in role that grants {@link operation} (see the module header). */
  readonly leastRole: string;
  /** Broader built-in roles that also grant it. */
  readonly alsoGrantedBy: readonly string[];
  readonly scope: PrivilegeScope;
  /** Which resource or group the scope is, in words a ticket can use. */
  readonly scopeNote: string;
  /** The first source the audit cites for the role (Microsoft Learn or Cribl docs). */
  readonly citation: string;
  readonly confidence: "high" | "medium" | "low";
  /**
   * The audit rows this operation was populated from, as `METHOD path`
   * exactly as the corrected row spells them - the fidelity pin's join key.
   * Empty only for an operation the audit did not list (the coverage pin
   * found the call), which then carries `auditGap`.
   */
  readonly audit: readonly string[];
  /** Why an operation has no audit row. Present exactly when `audit` is empty. */
  readonly auditGap?: string;
}

/** One function the app performs and the operations it uses. */
export interface PrivilegeFunction {
  /** The key it is registered under ({@link FunctionId}); a string for the same reason as {@link PrivilegeOperation.id}. */
  readonly id: string;
  readonly label: string;
  /**
   * `core` when a setup path cannot do its primary job without the function;
   * `feature` when it is one capability an approver can refuse. The same
   * vocabulary as the preflight and the change-request tags.
   */
  readonly necessity: PermissionNecessity;
  readonly operations: readonly OperationId[];
}

/** One registry row: a function, one of its operations, and that operation's least privilege. */
export interface LeastPrivilegeRow {
  readonly functionId: string;
  readonly functionLabel: string;
  readonly operationId: string;
  readonly calls: readonly PrivilegeCall[];
  readonly operation: string;
  readonly leastRole: string;
  readonly scope: PrivilegeScope;
  readonly scopeNote: string;
  readonly citation: string;
  readonly necessity: PermissionNecessity;
}

/** Every function and operation pair, in function order then operation order. */
export const LEAST_PRIVILEGE_REGISTRY: readonly LeastPrivilegeRow[] = Object.freeze(
  LEAST_PRIVILEGE_FUNCTIONS.flatMap((fn) =>
    fn.operations.map((opId) => {
      const op = LEAST_PRIVILEGE_OPERATIONS[opId];
      return Object.freeze({
        functionId: fn.id,
        functionLabel: fn.label,
        operationId: op.id,
        calls: op.calls,
        operation: op.operation,
        leastRole: op.leastRole,
        scope: op.scope,
        scopeNote: op.scopeNote,
        citation: op.citation,
        necessity: fn.necessity,
      });
    }),
  ),
);

/** The operation registered under `id`. */
export function privilegeOperation(id: OperationId): PrivilegeOperation {
  return LEAST_PRIVILEGE_OPERATIONS[id];
}

/** The action string an operation needs - what the preflight checks. */
export function operationAction(id: OperationId): string {
  return LEAST_PRIVILEGE_OPERATIONS[id].operation;
}

/** The least built-in role for an operation. */
export function leastRoleFor(id: OperationId): string {
  return LEAST_PRIVILEGE_OPERATIONS[id].leastRole;
}

/** The function registered under `id`. */
export function privilegeFunction(id: FunctionId): PrivilegeFunction {
  const fn = LEAST_PRIVILEGE_FUNCTIONS.find((f) => f.id === id);
  if (fn === undefined) {
    // Unreachable through the FunctionId type; kept so a cast cannot hide one.
    throw new Error(`no least-privilege function '${id}'`);
  }
  return fn;
}

/** The registry rows of one function, in its operation order. */
export function rowsForFunction(id: FunctionId): LeastPrivilegeRow[] {
  return LEAST_PRIVILEGE_REGISTRY.filter((row) => row.functionId === id);
}

// ---------------------------------------------------------------------------
// Call matching
// ---------------------------------------------------------------------------

/** Strip the host, the query string and the trailing slash, then split. */
function segmentsOf(path: string): string[] {
  const withoutQuery = path.split("?")[0] ?? "";
  const withoutHost = withoutQuery.replace(/^https?:\/\/[^/]+/i, "");
  return withoutHost.split("/").filter((segment) => segment !== "");
}

/** A template segment that stands for exactly one path segment. */
function isOnePlaceholder(segment: string): boolean {
  return segment.includes("{") && segment !== "{*}";
}

/** Template segments that only locate a scope, never a resource type. */
const SCOPE_KEYWORDS = new Set(["subscriptions", "resourcegroups"]);

/** Whether a template segment may be hidden inside a leading run-time id that is followed by a child or an action. */
function isScopeOnly(segment: string): boolean {
  return segment.includes("{") || SCOPE_KEYWORDS.has(segment.toLowerCase());
}

/**
 * Whether `actual` path segments fit `template` segments.
 *
 * `{*}` in the template takes one or more segments; any other segment with a
 * `{` takes exactly one. In `actual`, a segment of `{}` is an UNKNOWN - a
 * value the caller only knows at run time. Anywhere but the start it stands
 * for exactly one segment, so a trailing name can never swallow the rest of
 * an unrelated template. Literal segments compare case-insensitively, as ARM
 * does.
 *
 * A LEADING unknown is usually a whole scope or resource id
 * (`${dcrId}/providers/...`), so it may stand for several segments - but only
 * as many as the rest of the path can vouch for:
 *
 *   - followed by `providers`, the call is an EXTENSION resource
 *     (role assignments, metrics, permissions), which ARM accepts at any
 *     scope, so the id may hide anything;
 *   - followed by anything else, the call is a child or an action of the id
 *     (`${id}/listKeys`, `${id}/consumergroups`), which depends on the id's
 *     resource TYPE. The id may then hide only scope segments
 *     (placeholders, `subscriptions`, `resourceGroups`); a template that
 *     needs it to hide a provider or a type does not match, because
 *     `{}/listKeys` is a storage key read as readily as an Event Hub one.
 *     Such a site is declared by hand (coverage.test.ts).
 *
 * Either way the id ends where the template next names a literal segment, so
 * `{}/consumergroups` cannot match a resource group read by filling `{rg}`.
 */
function segmentsMatch(template: readonly string[], actual: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const extension = actual[0] === "{}" && (actual[1] ?? "").toLowerCase() === "providers";
  const go = (t: number, a: number): boolean => {
    const key = `${t}:${a}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let result = false;
    if (t === template.length || a === actual.length) {
      result = t === template.length && a === actual.length;
    } else {
      const ts = template[t] ?? "";
      const as = actual[a] ?? "";
      if (as === "{}" && a === 0) {
        // A leading run-time id absorbs one or more template segments, within
        // the limits above. Tried before the template's {*}, and as well as
        // it, so a template that starts with {*} can still give the id its
        // literal provider and type segments.
        for (let i = 1; !result && t + i <= template.length; i++) {
          const absorbed = template.slice(t, t + i);
          if (!extension && !absorbed.every((seg) => seg === "{*}" || isScopeOnly(seg))) {
            break;
          }
          // The id ends where the template names something literal: the
          // segment after it is the call's own child or action, never a
          // placeholder the next actual segment could fill by accident.
          const next = template[t + i];
          if (next === undefined || !next.includes("{")) {
            result = go(t + i, a + 1);
          }
        }
      }
      if (!result && ts === "{*}") {
        // The template's scope wildcard absorbs one or more actual segments.
        for (let j = 1; !result && a + j <= actual.length; j++) {
          result = go(t + 1, a + j);
        }
      } else if (!result && as === "{}" && a > 0) {
        // Any other run-time value is one segment, whatever the template has there.
        result = go(t + 1, a + 1);
      } else if (!result && as !== "{}" && (isOnePlaceholder(ts) || ts.toLowerCase() === as.toLowerCase())) {
        result = go(t + 1, a + 1);
      }
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/**
 * The operations whose calls fit a method and path.
 *
 * `method` may be `"*"` when the caller does not know it. `path` may carry
 * `{}` for run-time values (see {@link segmentsMatch}). Returns every match,
 * because one call shape can serve two operations (a role assignment PUT to
 * a run-time scope is the DCR grant or the lab TTL grant, and only the
 * caller knows which).
 */
export function operationsForCall(method: string, path: string): PrivilegeOperation[] {
  const actual = segmentsOf(path);
  const verb = method.toUpperCase();
  return Object.values(LEAST_PRIVILEGE_OPERATIONS).filter((op) =>
    op.calls.some(
      (call) =>
        (verb === "*" || call.method === verb) &&
        segmentsMatch(segmentsOf(call.path), actual),
    ),
  );
}
