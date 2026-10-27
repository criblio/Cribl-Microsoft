import { describe, expect, it } from "vitest";
import { CRIBL_SECRET_REFERENCE } from "../../domain/pack-assembly";
import { SENTINEL_SECRET_PLACEHOLDER } from "../../domain/sentinel-destination";
import {
  buildEnsureSecretRequest,
  buildUpdateSecretRequest,
  SECRETS_API_PATH,
  SENTINEL_CLIENT_SECRET_NAME,
  SENTINEL_CLIENT_SECRET_REFERENCE,
} from "./secret-provisioning";

describe("secret convention - ONE reference, two delivery paths", () => {
  it("the connected reference is `!{sentinel_client_secret}` and matches pack-assembly's", () => {
    expect(SENTINEL_CLIENT_SECRET_REFERENCE).toBe("!{sentinel_client_secret}");
    // Single source of truth: the ensure-secret name and the outputs.yml
    // reference can never drift.
    expect(SENTINEL_CLIENT_SECRET_REFERENCE).toBe(CRIBL_SECRET_REFERENCE);
    expect(SENTINEL_CLIENT_SECRET_REFERENCE).toContain(SENTINEL_CLIENT_SECRET_NAME);
  });

  it("the air-gap placeholder is a DIFFERENT string (`<replace me>`), not the reference", () => {
    // The two paths must never be confused: the reference only lives inside a
    // live Cribl; `<replace me>` only lives in air-gap artifacts.
    expect(SENTINEL_SECRET_PLACEHOLDER).toBe("<replace me>");
    expect(SENTINEL_SECRET_PLACEHOLDER).not.toBe(SENTINEL_CLIENT_SECRET_REFERENCE);
  });
});

describe("buildEnsureSecretRequest / buildUpdateSecretRequest (connected path)", () => {
  // DBT-151: this pin used to expect `type: "text"`, which is the defect -
  // the vendored OpenAPI RestSecret requires `secretType`. Changed, not weakened:
  // the whole body is still compared, so a `type` key fails it.
  it("creates the named text secret via POST /system/secrets", () => {
    const request = buildEnsureSecretRequest("s3cr3t-value", "wg-1");
    expect(request).toEqual({
      method: "POST",
      path: SECRETS_API_PATH,
      groupId: "wg-1",
      body: {
        id: SENTINEL_CLIENT_SECRET_NAME,
        secretType: "text",
        value: "s3cr3t-value",
      },
    });
  });

  it("omits groupId when none is given (leader-scoped)", () => {
    const request = buildEnsureSecretRequest("s3cr3t-value");
    expect(request.groupId).toBeUndefined();
    expect(request.path).toBe(SECRETS_API_PATH);
  });

  it("updates via PATCH /system/secrets/{id} on conflict", () => {
    const request = buildUpdateSecretRequest("rotated", "wg-1");
    expect(request.method).toBe("PATCH");
    expect(request.path).toBe(`${SECRETS_API_PATH}/${SENTINEL_CLIENT_SECRET_NAME}`);
    expect((request.body as { value: string }).value).toBe("rotated");
  });

  it("names the secret kind `secretType` on the PATCH too (DBT-151)", () => {
    const request = buildUpdateSecretRequest("rotated", "wg-1");
    expect(request.body).toEqual({
      id: SENTINEL_CLIENT_SECRET_NAME,
      secretType: "text",
      value: "rotated",
    });
  });
});
