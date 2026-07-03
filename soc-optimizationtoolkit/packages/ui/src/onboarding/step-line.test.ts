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

  it("aligns every status tag to the same width", () => {
    for (const status of ["pending", "running", "succeeded", "failed"] as const) {
      const line = formatStepLine({ name: "x", status });
      expect(line.indexOf("x")).toBe(STEP_STATUS_TAG_WIDTH);
    }
  });
});
