/**
 * arm-resource - unit pins for the toolkit the phase modules share. The
 * engine tests exercise these shapes end-to-end; these tests pin the seam
 * DIRECTLY (poll exhaustion, miss modes, keep-vs-reset on failed reads)
 * without scripting the whole engine.
 */

import { describe, expect, it } from "vitest";
import {
  armProvisioningState,
  ensureResource,
  pollProvisioningState,
  type ArmExchange,
} from "./arm-resource";

const ok = (body: unknown = {}): ArmExchange => ({ status: 200, body });
const notFound: ArmExchange = { status: 404, body: {} };
const denied: ArmExchange = { status: 403, body: { error: { code: "Denied" } } };

describe("ensureResource", () => {
  it("reuses on a 2xx GET without calling put", async () => {
    let putCalls = 0;
    const outcome = await ensureResource({
      get: async () => ok({ id: "existing" }),
      put: async () => {
        putCalls++;
        return ok();
      },
      context: "widget 'w'",
    });
    expect(outcome).toEqual({ status: "reused", body: { id: "existing" } });
    expect(putCalls).toBe(0);
  });

  it("creates on a 404 GET and returns the PUT body", async () => {
    const outcome = await ensureResource({
      get: async () => notFound,
      put: async () => ok({ id: "fresh" }),
      context: "widget 'w'",
    });
    expect(outcome).toEqual({ status: "created", body: { id: "fresh" } });
  });

  it("strict mode reports a non-404 GET as a read failure", async () => {
    const outcome = await ensureResource({
      get: async () => denied,
      put: async () => ok(),
      context: "widget 'w'",
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("read widget 'w': HTTP 403");
  });

  it("any-non-2xx mode treats every GET miss as absent and PUTs", async () => {
    const outcome = await ensureResource({
      get: async () => denied,
      put: async () => ok(),
      context: "widget 'w'",
      missOn: "any-non-2xx",
    });
    expect(outcome.status).toBe("created");
  });

  it("reports a failed PUT as a create failure", async () => {
    const outcome = await ensureResource({
      get: async () => notFound,
      put: async () => ({ status: 400, body: { error: { code: "Bad" } } }),
      context: "widget 'w'",
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("create widget 'w': HTTP 400");
  });
});

describe("pollProvisioningState", () => {
  const stateBody = (state: string): unknown => ({
    properties: { provisioningState: state },
  });

  it("unseeded (read-first): reads until the target, sleeping between", async () => {
    const responses = [stateBody("Creating"), stateBody("Succeeded")];
    let reads = 0;
    const sleeps: number[] = [];
    const state = await pollProvisioningState({
      read: async () => ok(responses[reads++]),
      parse: armProvisioningState,
      attempts: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      delayMs: 10,
    });
    expect(state).toBe("Succeeded");
    expect(reads).toBe(2);
    expect(sleeps).toEqual([10]);
  });

  it("seeded (sleep-first): a Succeeded seed never reads at all", async () => {
    let reads = 0;
    const state = await pollProvisioningState({
      read: async () => {
        reads++;
        return ok(stateBody("Succeeded"));
      },
      parse: armProvisioningState,
      seed: "Succeeded",
      attempts: 5,
      sleep: async () => {},
      delayMs: 10,
    });
    expect(state).toBe("Succeeded");
    expect(reads).toBe(0);
  });

  it("exhausts after the attempt bound and returns the last state", async () => {
    let reads = 0;
    const state = await pollProvisioningState({
      read: async () => {
        reads++;
        return ok(stateBody("Creating"));
      },
      parse: armProvisioningState,
      seed: "Creating",
      attempts: 3,
      sleep: async () => {},
      delayMs: 10,
    });
    expect(state).toBe("Creating");
    expect(reads).toBe(3);
  });

  it("resets the state on a failed read by default", async () => {
    const exchanges: ArmExchange[] = [denied];
    let reads = 0;
    const state = await pollProvisioningState({
      read: async () => exchanges[reads++] ?? denied,
      parse: armProvisioningState,
      seed: "Creating",
      attempts: 1,
      sleep: async () => {},
      delayMs: 10,
    });
    expect(state).toBe("");
  });

  it("keeps the last state across a failed read when asked (ADX/DCR)", async () => {
    let reads = 0;
    const state = await pollProvisioningState({
      read: async () => {
        reads++;
        return denied;
      },
      parse: armProvisioningState,
      seed: "Creating",
      attempts: 2,
      sleep: async () => {},
      delayMs: 10,
      keepStateOnFailedRead: true,
    });
    expect(state).toBe("Creating");
    expect(reads).toBe(2);
  });

  it("hands every 2xx poll body to onBody (the ADX URI capture)", async () => {
    const bodies: unknown[] = [];
    const responses = [stateBody("Creating"), stateBody("Succeeded")];
    let reads = 0;
    await pollProvisioningState({
      read: async () => ok(responses[reads++]),
      parse: armProvisioningState,
      seed: "Creating",
      attempts: 5,
      sleep: async () => {},
      delayMs: 10,
      onBody: (body) => {
        bodies.push(body);
      },
    });
    expect(bodies).toEqual(responses);
  });

  it("supports a non-default target (provider Registered)", async () => {
    const state = await pollProvisioningState({
      read: async () => ok({ properties: { provisioningState: "Registered" } }),
      parse: armProvisioningState,
      target: "Registered",
      attempts: 2,
      sleep: async () => {},
      delayMs: 10,
    });
    expect(state).toBe("Registered");
  });
});

describe("armProvisioningState", () => {
  it("reads properties.provisioningState and defaults to ''", () => {
    expect(armProvisioningState({ properties: { provisioningState: "Succeeded" } })).toBe(
      "Succeeded",
    );
    expect(armProvisioningState({})).toBe("");
    expect(armProvisioningState(null)).toBe("");
  });
});
