import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_CATEGORIES } from "../../domain/activity-log-export/activity-log-setting";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { removeActivityLogExport } from "./remove-activity-log-export";

const SUB = "00000000-0000-0000-0000-000000000001";
const SETTINGS_PATH = `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings`;
const OUR_PATH = `${SETTINGS_PATH}/cribl-activity-log`;
const RULE_ID = `/subscriptions/${SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns/authorizationRules/DiagManage`;
const RECORD = { subscriptionId: SUB, settingName: "cribl-activity-log", ruleId: RULE_ID };
const API = "2021-05-01-preview";

function ours(ruleId = RULE_ID): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      id: OUR_PATH,
      name: "cribl-activity-log",
      properties: { eventHubAuthorizationRuleId: ruleId, logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })) },
    },
  };
}
const notFound = { status: 404, body: { code: "ResourceNotFound" } };
const forbidden = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };

describe("removeActivityLogExport", () => {
  it("reads it by name, deletes it, and confirms the 404 - in that order and nothing else", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ours(), { status: 200, body: null }, notFound);
    const outcome = await removeActivityLogExport(azure, { subscriptionId: SUB, record: RECORD });
    expect(outcome).toEqual({ kind: "removed", settingId: OUR_PATH });
    expect(azure.calls).toEqual([
      { method: "GET", path: OUR_PATH, apiVersion: API },
      { method: "DELETE", path: OUR_PATH, apiVersion: API },
      { method: "GET", path: OUR_PATH, apiVersion: API },
    ]);
  });

  it("a setting with no record of the app writing it is never deleted", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ours());
    const outcome = await removeActivityLogExport(azure, { subscriptionId: SUB, record: null });
    expect(outcome.kind).toBe("not-proven");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a setting now sending with another rule is not provably the app's: nothing is deleted", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ours(`${RULE_ID}X`));
    const outcome = await removeActivityLogExport(azure, { subscriptionId: SUB, record: RECORD });
    expect(outcome.kind).toBe("not-proven");
    expect(outcome.kind === "not-proven" && outcome.detail).toContain(`it now sends with rule ${RULE_ID}X`);
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a 404 on the first read is already gone, never an error, and sends no DELETE", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    expect(await removeActivityLogExport(azure, { subscriptionId: SUB, record: RECORD })).toEqual({ kind: "already-gone", settingId: OUR_PATH });
    expect(azure.calls).toHaveLength(1);
  });

  it("a 403 on the DELETE is denied, with the step named", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ours(), forbidden);
    const outcome = await removeActivityLogExport(azure, { subscriptionId: SUB, record: RECORD });
    expect(outcome).toMatchObject({ kind: "denied", step: "setting-delete", status: 403, code: "AuthorizationFailed" });
  });

  it("a 403 on the read is denied at the read, and nothing is deleted", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const outcome = await removeActivityLogExport(azure, { subscriptionId: SUB, record: RECORD });
    expect(outcome).toMatchObject({ kind: "denied", step: "setting-read", status: 403 });
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a DELETE accepted while the setting still reads is removed-not-confirmed, not removed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ours(), { status: 202, body: null }, ours());
    const outcome = await removeActivityLogExport(azure, { subscriptionId: SUB, record: RECORD });
    expect(outcome).toEqual({ kind: "removed-not-confirmed", settingId: OUR_PATH, reason: "Azure accepted the removal, but the setting still reads back." });
  });
});
