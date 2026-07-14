/**
 * Tests for the Wiring section's pure decisions. The load-bearing rules
 * (canWireSource unlock, deployModeGating, route order / Lake cloud-only) are
 * pinned in @soc/core's guided-deploy tests; these pin the BINDING layer this
 * section adds: the unlock chain, lake-toggle gating, and the single unlock
 * condition each action shows when disabled.
 */
import { describe, expect, it } from "vitest";
import {
  WIRING_CRIBL_SKIPPED_REASON,
  WIRING_NEEDS_DATASET_REASON,
  WIRING_NEEDS_DEPLOY_REASON,
  WIRING_NEEDS_PACK_NAME_REASON,
  WIRING_NEEDS_SECRET_REASON,
  WIRING_NEEDS_SOURCE_REASON,
  WIRING_NEEDS_WORKER_GROUP_REASON,
  deriveWiringState,
  isLakeAvailable,
  wiringLockReason,
} from "./wiring-state";
import type { WiringInputs } from "./wiring-state";

// A fully-ready wiring input (deploy done, full mode, cloud, group + pack set,
// source id present, Lake off, a secret typed). Individual tests override one
// field to isolate a single decision.
function ready(overrides: Partial<WiringInputs> = {}): WiringInputs {
  return {
    deployCompleted: true,
    mode: "full",
    deploymentType: "cloud",
    workerGroupSelected: true,
    packNameSet: true,
    sourceId: "in_http:sentinel",
    lakeRequested: false,
    lakeDataset: "",
    secretValue: "s3cr3t",
    ...overrides,
  };
}

describe("wiringLockReason", () => {
  it("locks until a deploy completes (full mode)", () => {
    expect(wiringLockReason(false, "full")).toBe(WIRING_NEEDS_DEPLOY_REASON);
    expect(wiringLockReason(true, "full")).toBeNull();
  });

  it("locks whenever the mode skips Cribl, even after a deploy", () => {
    expect(wiringLockReason(true, "air-gapped")).toBe(
      WIRING_CRIBL_SKIPPED_REASON,
    );
    expect(wiringLockReason(true, "azure-only")).toBe(
      WIRING_CRIBL_SKIPPED_REASON,
    );
  });

  it("cribl-only skips Azure but NOT Cribl, so it only waits on the deploy", () => {
    expect(wiringLockReason(false, "cribl-only")).toBe(
      WIRING_NEEDS_DEPLOY_REASON,
    );
    expect(wiringLockReason(true, "cribl-only")).toBeNull();
  });
});

describe("isLakeAvailable", () => {
  it("offers Lake only for a cloud Cribl deployment", () => {
    expect(isLakeAvailable("cloud")).toBe(true);
    expect(isLakeAvailable("onprem")).toBe(false);
    expect(isLakeAvailable(undefined)).toBe(false);
  });
});

describe("deriveWiringState - unlock", () => {
  it("is locked with the deploy reason before any deploy", () => {
    const s = deriveWiringState(ready({ deployCompleted: false }));
    expect(s.unlocked).toBe(false);
    expect(s.lockReason).toBe(WIRING_NEEDS_DEPLOY_REASON);
    expect(s.canWire).toBe(false);
    expect(s.wireDisabledReason).toBe(WIRING_NEEDS_DEPLOY_REASON);
    expect(s.canEnsureSecret).toBe(false);
    expect(s.secretDisabledReason).toBe(WIRING_NEEDS_DEPLOY_REASON);
  });

  it("is locked with the cribl-skipped reason in an air-gapped run", () => {
    const s = deriveWiringState(ready({ mode: "air-gapped" }));
    expect(s.unlocked).toBe(false);
    expect(s.wireDisabledReason).toBe(WIRING_CRIBL_SKIPPED_REASON);
  });

  it("unlocks after a full-mode deploy", () => {
    const s = deriveWiringState(ready());
    expect(s.unlocked).toBe(true);
    expect(s.lockReason).toBeNull();
    expect(s.canWire).toBe(true);
    expect(s.wireDisabledReason).toBeNull();
  });
});

describe("deriveWiringState - lake gating", () => {
  it("forces Lake off for an onprem deployment even when requested", () => {
    const s = deriveWiringState(
      ready({ deploymentType: "onprem", lakeRequested: true }),
    );
    expect(s.lakeAvailable).toBe(false);
    expect(s.lakeEffective).toBe(false);
    // A blank dataset must NOT block the wire when Lake is not effective.
    expect(s.canWire).toBe(true);
  });

  it("keeps Lake off unless the operator requests it, even on cloud", () => {
    const s = deriveWiringState(ready({ lakeRequested: false }));
    expect(s.lakeAvailable).toBe(true);
    expect(s.lakeEffective).toBe(false);
  });

  it("requires a dataset once Lake is effective (cloud + requested)", () => {
    const blank = deriveWiringState(
      ready({ lakeRequested: true, lakeDataset: "  " }),
    );
    expect(blank.lakeEffective).toBe(true);
    expect(blank.canWire).toBe(false);
    expect(blank.wireDisabledReason).toBe(WIRING_NEEDS_DATASET_REASON);

    const filled = deriveWiringState(
      ready({ lakeRequested: true, lakeDataset: "sentinel_lake" }),
    );
    expect(filled.canWire).toBe(true);
    expect(filled.wireDisabledReason).toBeNull();
  });
});

describe("deriveWiringState - wire disabled cascade", () => {
  it("names the worker group first, then pack, then source", () => {
    expect(
      deriveWiringState(ready({ workerGroupSelected: false })).wireDisabledReason,
    ).toBe(WIRING_NEEDS_WORKER_GROUP_REASON);
    expect(
      deriveWiringState(ready({ packNameSet: false })).wireDisabledReason,
    ).toBe(WIRING_NEEDS_PACK_NAME_REASON);
    expect(
      deriveWiringState(ready({ sourceId: "   " })).wireDisabledReason,
    ).toBe(WIRING_NEEDS_SOURCE_REASON);
  });
});

describe("deriveWiringState - secret ensure", () => {
  it("needs a worker group and a typed secret, independently of the source id", () => {
    // A blank source id blocks the wire but NOT the secret ensure (they are
    // independently re-runnable actions).
    const s = deriveWiringState(ready({ sourceId: "" }));
    expect(s.canWire).toBe(false);
    expect(s.canEnsureSecret).toBe(true);
    expect(s.secretDisabledReason).toBeNull();
  });

  it("blocks the secret ensure until a secret is typed", () => {
    const s = deriveWiringState(ready({ secretValue: "   " }));
    expect(s.canEnsureSecret).toBe(false);
    expect(s.secretDisabledReason).toBe(WIRING_NEEDS_SECRET_REASON);
  });

  it("blocks the secret ensure when no worker group is selected", () => {
    const s = deriveWiringState(ready({ workerGroupSelected: false }));
    expect(s.secretDisabledReason).toBe(WIRING_NEEDS_WORKER_GROUP_REASON);
  });
});
