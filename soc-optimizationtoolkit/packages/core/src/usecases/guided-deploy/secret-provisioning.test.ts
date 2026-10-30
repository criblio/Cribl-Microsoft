import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { ensureTextSecret } from "../ensure-secret";
import { CRIBL_SECRET_REFERENCE } from "../../domain/pack-assembly";
import { SENTINEL_SECRET_PLACEHOLDER } from "../../domain/sentinel-destination";
import { APP_ID } from "../../domain/cribl-secrets";
import { stampFor } from "../../kit/config-writes/ownership";
import {
  SENTINEL_CLIENT_SECRET_DESCRIPTION,
  SENTINEL_CLIENT_SECRET_NAME,
  SENTINEL_CLIENT_SECRET_REFERENCE,
} from "./secret-provisioning";

/** The description every body carries: the app's ownership stamp (DBT-163). */
const STAMPED = `${SENTINEL_CLIENT_SECRET_DESCRIPTION} ${stampFor(APP_ID)}`;

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

describe("the Sentinel client secret through ensureTextSecret (connected path)", () => {
  // DBT-151: this pin used to expect `type: "text"`, which is the defect -
  // the vendored OpenAPI RestSecret requires `secretType`. Changed, not weakened:
  // the whole body is still compared, so a `type` key fails it.
  // DBT-163 added the stamped description to the whole-body compares.
  // DBT-152 moved the requests out of this module into ensureTextSecret (the
  // POST/PATCH builders went out on any 409 with no ownership check); the
  // whole-body pins follow the request to where it is now built.
  const SENTINEL = {
    groupId: "wg-1",
    id: SENTINEL_CLIENT_SECRET_NAME,
    value: "s3cr3t-value",
    description: SENTINEL_CLIENT_SECRET_DESCRIPTION,
  };

  it("creates the named text secret via POST /system/secrets with the stamped body", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 201, body: {} });
    expect(await ensureTextSecret(cribl, SENTINEL)).toEqual({ kind: "created", secretId: SENTINEL_CLIENT_SECRET_NAME });
    expect(cribl.calls).toEqual([
      {
        method: "POST",
        path: "/system/secrets",
        groupId: "wg-1",
        body: {
          id: SENTINEL_CLIENT_SECRET_NAME,
          secretType: "text",
          value: "s3cr3t-value",
          description: STAMPED,
        },
      },
    ]);
  });

  it("updates via PATCH /system/secrets/{id} on a 409 only when the secret is ours, same body", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: SENTINEL_CLIENT_SECRET_NAME, description: STAMPED }] } },
      { status: 200, body: {} },
    );
    expect(await ensureTextSecret(cribl, SENTINEL)).toEqual({ kind: "updated", secretId: SENTINEL_CLIENT_SECRET_NAME });
    expect(cribl.calls[2]).toEqual({
      method: "PATCH",
      path: "/system/secrets/sentinel_client_secret",
      groupId: "wg-1",
      body: {
        id: SENTINEL_CLIENT_SECRET_NAME,
        secretType: "text",
        value: "s3cr3t-value",
        description: STAMPED,
      },
    });
  });
});
