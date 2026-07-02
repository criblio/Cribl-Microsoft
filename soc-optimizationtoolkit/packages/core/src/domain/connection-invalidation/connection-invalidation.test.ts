/**
 * Truth-table tests for computeInvalidation. The contract:
 *   - identity change (tenantId OR clientId) -> clear all three
 *   - scope change only (subscriptionId / resourceGroup / workspaceName) ->
 *     clear permission results only
 *   - whitespace/case-only difference in an identity field -> NOT a change
 *   - identical configs -> nothing cleared
 */
import { describe, expect, it } from "vitest";
import { computeInvalidation } from "./index";
import type { AzureConfig } from "../azure-config";

const BASE: AzureConfig = {
  clientId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  subscriptionId: "33333333-3333-3333-3333-333333333333",
  resourceGroup: "rg-soc",
  workspaceName: "law-soc",
  setupPath: "existing",
};

const CLEAR_ALL = {
  clearSecret: true,
  clearToken: true,
  clearPermissionResults: true,
};
const RESULTS_ONLY = {
  clearSecret: false,
  clearToken: false,
  clearPermissionResults: true,
};
const NOTHING = {
  clearSecret: false,
  clearToken: false,
  clearPermissionResults: false,
};

describe("computeInvalidation", () => {
  it("clears everything when the tenant changes", () => {
    const next: AzureConfig = { ...BASE, tenantId: "99999999-9999-9999-9999-999999999999" };
    expect(computeInvalidation(BASE, next)).toEqual(CLEAR_ALL);
  });

  it("clears everything when the clientId changes", () => {
    const next: AzureConfig = { ...BASE, clientId: "88888888-8888-8888-8888-888888888888" };
    expect(computeInvalidation(BASE, next)).toEqual(CLEAR_ALL);
  });

  it("clears results only when only the subscription changes", () => {
    const next: AzureConfig = { ...BASE, subscriptionId: "44444444-4444-4444-4444-444444444444" };
    expect(computeInvalidation(BASE, next)).toEqual(RESULTS_ONLY);
  });

  it("clears results only when only the resource group changes", () => {
    const next: AzureConfig = { ...BASE, resourceGroup: "rg-other" };
    expect(computeInvalidation(BASE, next)).toEqual(RESULTS_ONLY);
  });

  it("clears results only when only the workspace changes", () => {
    const next: AzureConfig = { ...BASE, workspaceName: "law-other" };
    expect(computeInvalidation(BASE, next)).toEqual(RESULTS_ONLY);
  });

  it("treats a whitespace/case-only tenant difference as NO identity change", () => {
    const next: AzureConfig = {
      ...BASE,
      tenantId: `  ${BASE.tenantId.toUpperCase()}  `,
      clientId: ` ${BASE.clientId.toUpperCase()} `,
    };
    expect(computeInvalidation(BASE, next)).toEqual(NOTHING);
  });

  it("clears nothing for identical configs", () => {
    expect(computeInvalidation(BASE, { ...BASE })).toEqual(NOTHING);
  });
});
