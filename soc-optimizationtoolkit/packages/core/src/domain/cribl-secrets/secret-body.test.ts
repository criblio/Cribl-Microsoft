import { describe, expect, it } from "vitest";
import { proveOwnership, stampFor } from "../../kit/config-writes/ownership";
import { APP_ID, buildSecretBody } from "./secret-body";
import * as onboardingSource from "../cribl-onboarding-source";

describe("buildSecretBody", () => {
  it("builds the whole body: secretType text, the value, and the stamped description", () => {
    expect(buildSecretBody({ id: "s1", value: "v", description: "d" })).toEqual({
      id: "s1",
      secretType: "text",
      value: "v",
      description: `d ${stampFor(APP_ID)}`,
    });
  });

  it("never sends `type` (DBT-151)", () => {
    expect(buildSecretBody({ id: "s1", value: "v", description: "d" })).not.toHaveProperty("type");
  });

  it("writes the stamp proveOwnership reads (DBT-163)", () => {
    const body = buildSecretBody({ id: "s1", value: "v", description: "d" });
    const proof = proveOwnership(APP_ID, {
      object: { id: body.id, description: body.description },
      manifestIds: new Set([body.id]),
      recordedWrite: true,
    });
    expect(proof).toEqual({ mine: true, missing: [] });
  });

  it("is the same binding cribl-onboarding-source re-exports, so its public API is unchanged", () => {
    expect(onboardingSource.buildSecretBody).toBe(buildSecretBody);
    expect(onboardingSource.APP_ID).toBe(APP_ID);
  });
});
