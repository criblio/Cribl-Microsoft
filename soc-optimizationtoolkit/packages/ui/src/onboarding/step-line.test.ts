import { describe, expect, it } from "vitest";
import { formatStepLine, STEP_STATUS_TAG_WIDTH } from "./step-line";

describe("formatStepLine", () => {
  it("renders a pending step without detail", () => {
    expect(formatStepLine({ name: "deploy-dcr", status: "pending" })).toBe(
      "[pending]   deploy-dcr",
    );
  });

  it("renders a succeeded step with its detail", () => {
    expect(
      formatStepLine({
        name: "generate-dcr-name",
        status: "succeeded",
        detail: "dcr-securityevent",
      }),
    ).toBe("[succeeded] generate-dcr-name - dcr-securityevent");
  });

  it("renders a failed step with the raw error detail", () => {
    expect(
      formatStepLine({
        name: "fetch-workspace",
        status: "failed",
        detail: "fetch workspace 'ws': HTTP 404 {}",
      }),
    ).toBe("[failed]    fetch-workspace - fetch workspace 'ws': HTTP 404 {}");
  });

  it("treats an empty detail as absent", () => {
    expect(formatStepLine({ name: "verify", status: "running", detail: "" })).toBe(
      "[running]   verify",
    );
  });

  it("renders a skipped step with its skip-reason detail", () => {
    // 'skipped' is a first-class step status (porting-plan DECISIONS
    // 2026-07-03 item 1): downstream steps of a failed prerequisite and
    // skip-existing hits render it with the reason in the detail slot.
    expect(
      formatStepLine({
        name: "deploy-dcr",
        status: "skipped",
        detail: "DCR already exists",
      }),
    ).toBe("[skipped]   deploy-dcr - DCR already exists");
  });

  it("aligns every status tag to the same width", () => {
    // The full JobStatus union - the padded-tag width contract covers
    // 'skipped' too, and "[succeeded]" remains the longest tag within it.
    const statuses = [
      "pending",
      "running",
      "succeeded",
      "failed",
      "skipped",
    ] as const;
    for (const status of statuses) {
      const line = formatStepLine({ name: "x", status });
      expect(line.indexOf("x")).toBe(STEP_STATUS_TAG_WIDTH);
      expect(`[${status}]`.length).toBeLessThan(STEP_STATUS_TAG_WIDTH);
    }
  });
});
