// @vitest-environment happy-dom
/**
 * Outline pins for the Azure Logging Map (AZR-19): the WAI-ARIA tree pattern
 * (roving tabIndex, arrow keys move focus, Left/Right change aria-expanded)
 * and the ONE selection shared with the canvas, driven through the screen so
 * the sharing is real and not a harness artefact.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { normaliseScopeId, type AzureConfig } from "@soc/core";

import { PortsProvider, type UiPorts } from "../../ports-context";
import { AzureLoggingMapScreen } from "./azure-logging-map-screen";
import { MG_ALPHA, ROOT_ID, SUB_C, TENANT, makeFixtureAzure } from "./logging-map-test-fixture";

afterEach(cleanup);

async function mountRead() {
  const azure = makeFixtureAzure();
  render(
    <PortsProvider
      ports={{ azure: azure.port } as unknown as UiPorts}
      config={{ tenantId: TENANT } as unknown as AzureConfig}
    >
      <AzureLoggingMapScreen />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Outline" }));
}

const item = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-lm-row="${normaliseScopeId(id)}"]`);
  if (el === null) throw new Error(`no outline row for ${id}`);
  return el;
};

describe("LoggingMapOutline", () => {
  it("is a role=tree with levels and exactly one tab stop", async () => {
    await mountRead();
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(item(ROOT_ID).getAttribute("aria-level")).toBe("1");
    expect(item(MG_ALPHA).getAttribute("aria-level")).toBe("2");
    const stops = [...document.querySelectorAll("[role='treeitem']")].filter((e) => e.getAttribute("tabindex") === "0");
    expect(stops.length).toBe(1);
    expect(stops[0]).toBe(item(ROOT_ID));
  });

  it("ArrowDown moves focus and selection; ArrowLeft and ArrowRight change aria-expanded", async () => {
    await mountRead();
    const tree = screen.getByRole("tree");
    item(ROOT_ID).focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(MG_ALPHA));
    expect(item(MG_ALPHA).getAttribute("aria-selected")).toBe("true");
    expect(item(MG_ALPHA).getAttribute("tabindex")).toBe("0");
    expect(item(ROOT_ID).getAttribute("tabindex")).toBe("-1");

    expect(item(MG_ALPHA).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(item(MG_ALPHA).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(item(MG_ALPHA));
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(item(MG_ALPHA).getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(tree, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tree, { key: "Home" });
    expect(document.activeElement).toBe(item(ROOT_ID));
  });

  it("an outline selection is the canvas selection: the card is aria-pressed", async () => {
    await mountRead();
    fireEvent.click(item(SUB_C));
    expect(item(SUB_C).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    const card = document.querySelector(`[data-lm-card="${normaliseScopeId(SUB_C)}"]`);
    expect(card?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-lm-card][aria-pressed='true']").length).toBe(1);
  });
});
