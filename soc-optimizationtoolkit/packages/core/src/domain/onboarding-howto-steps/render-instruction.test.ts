import { describe, expect, it } from "vitest";
import { PLAN_VALUE_KEYS, defaultPlanValues, type PlanValues } from "../onboarding-howto/plan-values";
import { fillTemplate, filledPlanValues, renderStep, unsetPlaceholder } from "./render-instruction";
import { howToStep, type HowToStep } from "./steps";

const BLANK: PlanValues = Object.fromEntries(PLAN_VALUE_KEYS.map((k) => [k, ""])) as unknown as PlanValues;

describe("renderStep", () => {
  it("substitutes set values and renders unset ones as a visible stand-in", () => {
    const values = { ...BLANK, namespace: "  ns1  " };
    const filled = filledPlanValues(values);
    expect(filled.namespace).toBe("ns1");
    expect(filled.hubName).toBe(unsetPlaceholder("hubName"));
    expect(unsetPlaceholder("hubName")).toBe("<hubName>");
    expect(fillTemplate("{{namespace}}/{{hubName}}/{{notAKey}}", filled)).toBe("ns1/<hubName>/{{notAKey}}");
  });

  it("fills the values table from the same filled values", () => {
    const r = renderStep(howToStep("eh-namespace")!, { ...BLANK, namespace: "ns1" });
    expect(r.values.find((v) => v.label === "Kafka endpoint Cribl connects to")?.value).toBe(
      "ns1.servicebus.windows.net:9093",
    );
    expect(r.values.find((v) => v.label === "Namespace resource ID")?.value).toBe(
      "/subscriptions/<subscriptionId>/resourceGroups/<resourceGroup>/providers/Microsoft.EventHub/namespaces/ns1",
    );
    expect(r.missing).toEqual(["subscriptionId", "resourceGroup", "region"]);
    expect(r.title).toBe("Create or pick the Event Hub namespace ns1");
  });

  it("marks inferred steps unverified and repo steps not", () => {
    expect(renderStep(howToStep("eh-network")!, BLANK).unverified).toBe(true);
    expect(renderStep(howToStep("eh-namespace")!, BLANK).unverified).toBe(false);
  });

  it("uses the consumer group default, never $Default, in the consumer group command", () => {
    const r = renderStep(howToStep("eh-consumer-group")!, defaultPlanValues(null));
    expect(r.cli).toContain("--name cribl");
    expect(r.cli).not.toContain("--name $Default");
  });

  it("passes the sub-selection to the values table", () => {
    const step: HowToStep = {
      id: "t",
      sourceIds: ["entraId"],
      title: "",
      why: "",
      portal: [],
      cli: "",
      values: (_v, sub) => [{ label: "sub", value: sub.join("+") }],
      rbac: [],
      confirmHow: "",
      dependsOnValues: [],
      checkKinds: [],
      provenance: "repo",
    };
    expect(renderStep(step, BLANK, ["a", "b"]).values).toEqual([{ label: "sub", value: "a+b" }]);
    expect(renderStep(step, BLANK).warning).toBeNull();
  });
});
