// @vitest-environment happy-dom
/**
 * Pin: the Reconfigure explanation lives in ONE place, the InfoTip (DBT-246).
 * A visible note under the card used to repeat it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SettingsScreen } from "./settings-screen";

afterEach(cleanup);

describe("Settings - Reconfigure explanation", () => {
  it("renders the explanation once, as the InfoTip", () => {
    const { container } = render(
      <SettingsScreen shellName="test" platformRows={[]} onReconfigure={vi.fn()} />,
    );
    const text = container.textContent ?? "";
    expect(text.split("Reopens the setup wizard").length - 1).toBe(1);
    expect(text).not.toContain("Reconfigure reopens the first-run wizard");
    expect(text).not.toContain("configurations are kept");
  });
});
