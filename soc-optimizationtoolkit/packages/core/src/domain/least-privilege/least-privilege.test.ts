/**
 * The least-privilege registry's own shape: functions and operations join
 * cleanly, rows carry every field ADR 0009 names, and the lookups read the
 * one table.
 */

import { describe, expect, it } from "vitest";

import {
  LEAST_PRIVILEGE_FUNCTIONS,
  LEAST_PRIVILEGE_OPERATIONS,
  LEAST_PRIVILEGE_REGISTRY,
  leastRoleFor,
  operationAction,
  privilegeFunction,
  rowsForFunction,
} from "./least-privilege";
import type { FunctionId, OperationId } from "./least-privilege";

const OPERATIONS = Object.values(LEAST_PRIVILEGE_OPERATIONS);

describe("least-privilege registry", () => {
  it("keys every operation by its own id", () => {
    for (const [key, op] of Object.entries(LEAST_PRIVILEGE_OPERATIONS)) {
      expect(op.id).toBe(key);
    }
  });

  it("gives every function a unique id and at least one operation", () => {
    const ids = LEAST_PRIVILEGE_FUNCTIONS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fn of LEAST_PRIVILEGE_FUNCTIONS) {
      expect(fn.operations.length, fn.id).toBeGreaterThan(0);
      expect(new Set(fn.operations).size, fn.id).toBe(fn.operations.length);
    }
  });

  it("uses every operation in at least one function (no orphan facts)", () => {
    const used = new Set<string>(LEAST_PRIVILEGE_FUNCTIONS.flatMap((f) => f.operations));
    expect(OPERATIONS.filter((op) => !used.has(op.id)).map((op) => op.id)).toEqual([]);
  });

  it("has one row per function and operation, carrying the operation's facts", () => {
    const expected = LEAST_PRIVILEGE_FUNCTIONS.reduce((n, f) => n + f.operations.length, 0);
    expect(LEAST_PRIVILEGE_REGISTRY).toHaveLength(expected);
    for (const row of LEAST_PRIVILEGE_REGISTRY) {
      const op = LEAST_PRIVILEGE_OPERATIONS[row.operationId as OperationId];
      expect(row.leastRole).toBe(op.leastRole);
      expect(row.operation).toBe(op.operation);
      expect(row.scope).toBe(op.scope);
      expect(row.citation).toBe(op.citation);
      expect(row.calls).toBe(op.calls);
      expect(row.necessity).toBe(privilegeFunction(row.functionId as FunctionId).necessity);
    }
  });

  it("fills every field a ticket would print", () => {
    for (const op of OPERATIONS) {
      expect(op.calls.length, op.id).toBeGreaterThan(0);
      expect(op.operation, op.id).not.toBe("");
      expect(op.leastRole, op.id).not.toBe("");
      expect(op.scopeNote, op.id).not.toBe("");
      expect(op.citation, op.id).toMatch(/^https:\/\//);
    }
  });

  it("states the narrowest scope of the listKeys call as the namespace, not the subscription", () => {
    // The first high-severity audit discrepancy: listKeys can be granted on
    // the namespace alone, which is also why the preflight cannot measure it
    // at the subscription.
    expect(LEAST_PRIVILEGE_OPERATIONS["eventhub.rule.listKeys"].scope).toBe("resource");
    expect(leastRoleFor("eventhub.rule.listKeys")).toBe("Azure Event Hubs Data Owner");
  });

  it("reads actions and roles from the one table", () => {
    expect(operationAction("dcr.write")).toBe("Microsoft.Insights/dataCollectionRules/write");
    expect(leastRoleFor("dcr.write")).toBe("Monitoring Contributor");
    expect(leastRoleFor("table.write")).toBe("Log Analytics Contributor");
    expect(leastRoleFor("defender.automation.write")).toBe("Security Admin");
  });

  it("returns a function's rows in its operation order", () => {
    expect(rowsForFunction("defender-export").map((r) => r.operationId)).toEqual([
      ...privilegeFunction("defender-export").operations,
    ]);
  });
});
