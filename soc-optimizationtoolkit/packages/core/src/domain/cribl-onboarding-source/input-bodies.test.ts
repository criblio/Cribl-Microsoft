import { describe, expect, it } from "vitest";
import { defaultPlanValues } from "../onboarding-howto/plan-values";
import { onboardingSource, type OnboardingSource } from "../onboarding-howto/sources";
import { stampFor } from "../../kit/config-writes/ownership";
import {
  APP_ID,
  IDENTITY_FIELDS,
  ONBOARDING_ID_MAX,
  buildBlobInputBody,
  buildEventHubInputBody,
  buildSecretBody,
  jsStringExpression,
  onboardingInputId,
  onboardingSecretId,
} from "./input-bodies";

const src = (id: string): OnboardingSource => onboardingSource(id)!;

/** Every key and string value anywhere in `v`, depth first. */
function deepStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => deepStrings(x, out));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      deepStrings(x, out);
    }
  }
  return out;
}

const EH_SPEC = {
  id: "azure_onb_eh_ns1_hub1",
  namespace: "ns1",
  topics: ["hub1"],
  consumerGroup: "cribl",
  secretId: "azure_onb_eh_ns1_hub1_secret",
  sourceId: "defenderExport",
  sourceTitle: "Defender",
};

describe("buildEventHubInputBody", () => {
  const body = buildEventHubInputBody(EH_SPEC);

  it("is an eventhub INPUT on 9093 with SASL PLAIN $ConnectionString and the secret's name", () => {
    expect(body["type"]).toBe("eventhub");
    expect(body["brokers"]).toEqual(["ns1.servicebus.windows.net:9093"]);
    expect(body["topics"]).toEqual(["hub1"]);
    expect(body["sasl"]).toEqual({
      disabled: false,
      mechanism: "plain",
      authType: "secret",
      username: "$ConnectionString",
      textSecret: "azure_onb_eh_ns1_hub1_secret",
    });
    expect((body["tls"] as Record<string, unknown>)["disabled"]).toBe(false);
    expect((body["tls"] as Record<string, unknown>)["rejectUnauthorized"]).toBe(true);
  });

  it("takes groupId from the plan's consumer group", () => {
    expect(body["groupId"]).toBe("cribl");
    expect(buildEventHubInputBody({ ...EH_SPEC, consumerGroup: "other" })["groupId"]).toBe("other");
  });

  it("carries no password and no _metadata anywhere", () => {
    const all = deepStrings(body);
    expect(all).not.toContain("password");
    expect(all).not.toContain("_metadata");
  });

  it("is stamped with the app's ownership marker", () => {
    expect(String(body["description"])).toContain(stampFor(APP_ID));
  });
});

describe("buildBlobInputBody", () => {
  const body = buildBlobInputBody({
    id: "azure_onb_blob_acct_q1",
    storageAccount: "acct",
    queueName: "q1",
    tenantId: "t",
    clientId: "c",
    secretId: "azure_onb_blob_acct_q1_secret",
    sourceId: "vnetFlowLogs",
    sourceTitle: "VNet",
  });

  it("is azure_blob with a backtick-quoted queue expression and clientSecret auth", () => {
    expect(body["type"]).toBe("azure_blob");
    expect(body["queueName"]).toBe("`q1`");
    expect(body["authType"]).toBe("clientSecret");
    expect(body["clientTextSecret"]).toBe("azure_onb_blob_acct_q1_secret");
    expect(body).not.toHaveProperty("connectionString");
  });

  it("carries no secret value and no _metadata", () => {
    const all = deepStrings(body);
    expect(all).not.toContain("password");
    expect(all).not.toContain("_metadata");
    expect(all).not.toContain("SECRET-VALUE");
  });

  it("escapes characters that would end or interpolate the template literal", () => {
    expect(jsStringExpression("a`b${c}\\")).toBe("`a\\`b\\${c}\\\\`");
  });
});

describe("buildSecretBody", () => {
  it("sends secretType text, never type", () => {
    const body = buildSecretBody({ id: "s1", value: "v", description: "d" });
    expect(body.secretType).toBe("text");
    expect(body).not.toHaveProperty("type");
    expect(body.value).toBe("v");
    expect(body.description).toContain(stampFor(APP_ID));
  });
});

describe("onboardingInputId / onboardingSecretId", () => {
  const values = { ...defaultPlanValues(null), namespace: "my-ns", hubName: "cribl.hub", storageAccount: "acct", queueName: "q-1" };

  it("names a named-hub lane by its hub and an auto-created lane by its source", () => {
    expect(onboardingInputId(src("defenderExport"), values)).toBe("azure_onb_eh_my_ns_cribl_hub");
    expect(onboardingInputId(src("entraId"), values)).toBe("azure_onb_eh_my_ns_entraId");
    expect(onboardingInputId(src("vnetFlowLogs"), values)).toBe("azure_onb_blob_acct_q_1");
  });

  it("is idempotent", () => {
    expect(onboardingInputId(src("defenderExport"), values)).toBe(onboardingInputId(src("defenderExport"), { ...values }));
  });

  it("is null when a needed value is unset", () => {
    expect(onboardingInputId(src("defenderExport"), { ...values, hubName: "" })).toBeNull();
    expect(onboardingInputId(src("entraId"), { ...values, namespace: " " })).toBeNull();
    expect(onboardingInputId(src("vnetFlowLogs"), { ...values, queueName: "" })).toBeNull();
  });

  it("stays within the length cap, the secret id too", () => {
    const long = { ...values, namespace: "n".repeat(50), hubName: "h".repeat(50) };
    const id = onboardingInputId(src("defenderExport"), long)!;
    expect(id.length).toBeLessThanOrEqual(ONBOARDING_ID_MAX);
    expect(id.startsWith("azure_onb_eh_n")).toBe(true);
    const secret = onboardingSecretId(id);
    expect(secret.length).toBeLessThanOrEqual(ONBOARDING_ID_MAX);
    expect(secret.endsWith("_secret")).toBe(true);
  });
});

describe("IDENTITY_FIELDS", () => {
  it("covers both input types and names the fields an operator would change", () => {
    expect(Object.keys(IDENTITY_FIELDS).sort()).toEqual(["azure_blob", "eventhub"]);
    expect(IDENTITY_FIELDS.eventhub).toEqual(expect.arrayContaining(["topics", "brokers", "groupId", "sasl.textSecret"]));
    expect(IDENTITY_FIELDS.azure_blob).toEqual(expect.arrayContaining(["queueName", "storageAccountName", "clientTextSecret"]));
  });
});
