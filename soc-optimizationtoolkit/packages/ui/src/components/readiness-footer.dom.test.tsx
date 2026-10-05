// @vitest-environment happy-dom
/**
 * DBT-127: the readiness pills are the way back to an earlier section. With a
 * handler they are buttons that name their pill; without one they stay plain
 * status chips, so screens that never wired navigation are unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReadinessPill } from "@soc/core";
import { ReadinessFooter } from "./readiness-footer";

afterEach(cleanup);

const PILLS: ReadinessPill[] = [
  { id: "solution", label: "Solution", state: "ok", hint: "A Sentinel solution is selected." },
  { id: "mappings", label: "Mappings", state: "missing", hint: "Approve the mappings." },
];

describe("ReadinessFooter pills (DBT-127)", () => {
  it("are buttons that report which pill was clicked", () => {
    const clicked: string[] = [];
    const { getByRole } = render(
      <ReadinessFooter
        pills={PILLS}
        canDeploy={false}
        onDeploy={() => undefined}
        onPillClick={(id) => clicked.push(id)}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Go to Mappings" }));
    fireEvent.click(getByRole("button", { name: "Go to Solution" }));
    expect(clicked).toEqual(["mappings", "solution"]);
  });

  it("stay plain chips when no handler is given", () => {
    const { container, queryByRole } = render(
      <ReadinessFooter pills={PILLS} canDeploy={false} onDeploy={() => undefined} />,
    );
    expect(queryByRole("button", { name: /Go to/ })).toBeNull();
    expect(container.querySelectorAll("span.readiness-pill")).toHaveLength(2);
  });
});
