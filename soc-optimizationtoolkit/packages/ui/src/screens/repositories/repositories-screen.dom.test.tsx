// @vitest-environment happy-dom
/**
 * Pins for the Repositories screen's numbered sections (DBT-118).
 *
 * The screen used to render a third section, "Elastic integrations sample
 * data", telling the operator that raw vendor samples were "fetched ON DEMAND
 * per selected solution to drive field mapping and reduction rules". ADR 0003
 * deleted every consumer of those samples, so the copy described a data path
 * that no longer existed, and its Refresh button spent proxied GitHub calls on
 * a probe that proved nothing the Sentinel probe does not.
 *
 * These pins hold three things: the false copy is gone (exact occurrence
 * counts, not a presence check), the section list is EXACTLY the three that
 * remain in order, and no Refresh click reaches an Elastic listing. The mount
 * deliberately still hands the screen a sampleSource-shaped extra property,
 * because a shell that still bound one is precisely the regression to catch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { RepositoriesScreen } from "./repositories-screen";

afterEach(cleanup);

const CONFIG = {
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
} as unknown as AzureConfig;

function makePorts() {
  const listElasticTestFiles = vi.fn(async () => []);
  const githubPat = {
    status: vi.fn(async () => ({ hasPat: true, login: "octo" })),
    validateAndStore: vi.fn(),
    clear: vi.fn(),
  };
  const content = {
    getCommitSha: vi.fn(async () => "abcdef012345"),
    listSolutions: vi.fn(async () => []),
    listRepoFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => null),
  };
  // sampleSource is passed as an EXTRA property through a loose cast: the
  // field is gone from UiPorts, and this is what a stale shell binding would
  // look like at runtime.
  const ports = {
    githubPat,
    content,
    sampleSource: { listElasticTestFiles, listCriblPackSamples: vi.fn() },
  } as unknown as UiPorts;
  return { ports, listElasticTestFiles };
}

async function mount(ports: UiPorts): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <PortsProvider ports={ports} config={CONFIG}>
        <RepositoriesScreen platform="cloud" />
      </PortsProvider>,
    ));
  });
  return container;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Repositories screen sections (DBT-118)", () => {
  it("carries none of the deleted Elastic sample-fetch copy", async () => {
    const container = await mount(makePorts().ports);
    const text = container.textContent ?? "";
    expect(countOccurrences(text, "elastic/integrations")).toBe(0);
    expect(countOccurrences(text, "fetched ON DEMAND")).toBe(0);
    expect(countOccurrences(text, "Elastic integrations sample data")).toBe(0);
    expect(countOccurrences(text, "fetched on demand")).toBe(0);
  });

  it("renders exactly three numbered sections, schema tables third", async () => {
    const container = await mount(makePorts().ports);
    const heads = Array.from(
      container.querySelectorAll(".numbered-section-head"),
    ).map((head) => [
      head.querySelector(".numbered-section-badge")?.textContent?.trim() ?? "",
      head.querySelector(".numbered-section-title")?.textContent?.trim() ?? "",
    ]);
    expect(heads).toEqual([
      ["1", "GitHub personal access token"],
      ["2", "Sentinel content"],
      ["3", "Schema tables (KQL validation)"],
    ]);
  });

  it("never lists Elastic test files, on mount or on any Refresh", async () => {
    const { ports, listElasticTestFiles } = makePorts();
    await mount(ports);
    const refreshes = screen.getAllByRole("button", { name: "Refresh" });
    // Two Refresh buttons remain: Sentinel content and the schema tables.
    expect(refreshes).toHaveLength(2);
    for (const button of refreshes) {
      await act(async () => {
        fireEvent.click(button);
      });
    }
    expect(listElasticTestFiles).toHaveBeenCalledTimes(0);
  });
});
