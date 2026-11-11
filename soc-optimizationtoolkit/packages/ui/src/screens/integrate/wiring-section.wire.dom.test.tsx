// @vitest-environment happy-dom
/**
 * DBT-301: "Wire source" is two clicks. The first only reads (the group's
 * sources, its routing table, its pending changes) and shows the confirm; the
 * second writes the routing table with every other route kept, commits and
 * deploys. Changing the source disarms; a table that moved after the confirm
 * is a void, worded as "check again", and the next click plans again.
 *
 * The leader here is a small stateful fake answering the MEASURED listing
 * shape `{items:[{id, groups, routes}], count:1}`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { WiringSection } from "./wiring-section";

afterEach(cleanup);

interface Req {
  method: string;
  path: string;
  groupId?: string;
  body?: unknown;
}

const OTHER_ROUTES = [
  { id: "r_fw", filter: "__inputId.startsWith('syslog:in_fw:')", pipeline: "fw", output: "splunk", final: true },
  { id: "default", filter: "true", pipeline: "main", output: "default", final: true },
];

function leader() {
  const state = {
    table: { id: "default", groups: { G1: { name: "Security", index: 1 } }, routes: structuredClone(OTHER_ROUTES) } as Record<string, unknown>,
    pending: [] as string[],
    head: "0",
  };
  const log: string[] = [];
  const request = vi.fn(async (req: Req) => {
    log.push(`${req.method} ${req.groupId ? `/m/${req.groupId}` : ""}${req.path}`);
    const copy = () => structuredClone(state.table);
    if (req.method === "GET" && req.path === "/system/inputs") return { status: 200, body: { items: [{ id: "in_pan", type: "syslog" }] } };
    if (req.method === "GET" && req.path === "/routes") return { status: 200, body: { items: [copy()], count: 1 } };
    if (req.path === "/routes/default" && req.method === "GET") return { status: 200, body: { items: [copy()], count: 1 } };
    if (req.path === "/routes/default" && req.method === "PATCH") {
      state.table = structuredClone(req.body as Record<string, unknown>);
      state.pending = ["groups/default/local/cribl/pipelines/route.yml"];
      return { status: 200, body: { items: [copy()] } };
    }
    if (req.path === "/version/status") return { status: 200, body: { items: [{ modified: state.pending }] } };
    if (req.path === "/version/commit") {
      state.pending = [];
      state.head = "a1b2c3d4e5f6";
      return { status: 200, body: { items: [{ commit: "a1b2c3d4e5f6" }] } };
    }
    if (req.path === "/version") return { status: 200, body: { items: [{ hash: state.head }] } };
    if (req.path === "/products/stream/groups/default/deploy") return { status: 200, body: {} };
    throw new Error(`unscripted ${req.method} ${req.path}`);
  });
  return { state, log, request };
}

function renderWith(l: ReturnType<typeof leader>) {
  const ports = { cribl: { request: l.request } } as unknown as UiPorts;
  return render(
    <PortsProvider ports={ports} config={{} as AzureConfig}>
      <WiringSection deployCompleted mode="full" deploymentType="cloud" workerGroup="default" packName="pan" />
    </PortsProvider>,
  );
}

function sourceInput(c: HTMLElement): HTMLInputElement {
  return c.querySelector<HTMLInputElement>('input[placeholder="in_syslog or syslog:in_syslog"]')!;
}

function button(c: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...c.querySelectorAll("button")].find((b) => b.textContent === text);
}

async function plan(c: HTMLElement) {
  fireEvent.change(sourceInput(c), { target: { value: "in_pan" } });
  fireEvent.click(button(c, "Wire source")!);
  await waitFor(() => expect(button(c, "Confirm: write the routes")).toBeDefined());
}

describe("WiringSection - Wire source is two clicks", () => {
  it("the first click only reads and shows the confirm; the second writes with every other route kept", async () => {
    const l = leader();
    const { container } = renderWith(l);
    await plan(container);
    expect(l.log.every((x) => x.startsWith("GET "))).toBe(true);
    const confirm = container.querySelector(".azo-confirm")!.textContent!;
    expect(confirm).toContain("Worker group default: add 1 route at the top of routing table default, above its 2 existing routes.");
    expect(confirm).toContain("__inputId.startsWith('syslog:in_pan:')");
    expect(confirm).toContain("groups/default/local/cribl/pipelines/route.yml");
    expect(confirm).toContain("restarts its workers");

    fireEvent.click(button(container, "Confirm: write the routes")!);
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toContain("Wired: routes written, committed and deployed."));
    const routes = l.state.table["routes"] as Array<{ id: string }>;
    expect(routes.map((r) => r.id)).toEqual(["pan-sentinel", "r_fw", "default"]);
    expect(l.state.table["groups"]).toEqual({ G1: { name: "Security", index: 1 } });
    expect(l.log).toContain("PATCH /m/default/routes/default");
  });

  it("changing the source after the confirm disarms it; nothing is written", async () => {
    const l = leader();
    const { container } = renderWith(l);
    await plan(container);
    fireEvent.change(sourceInput(container), { target: { value: "in_other" } });
    await waitFor(() => expect(button(container, "Confirm: write the routes")).toBeUndefined());
    expect(container.querySelector(".azo-confirm")).toBeNull();
    expect(l.log.filter((x) => !x.startsWith("GET "))).toEqual([]);
  });

  it("a table that moved after the confirm is a void: nothing written, 'check again', and the next click plans", async () => {
    const l = leader();
    const { container } = renderWith(l);
    await plan(container);
    (l.state.table["routes"] as unknown[]).push({ id: "late", filter: "__inputId=='http:x'", output: "o" });
    fireEvent.click(button(container, "Confirm: write the routes")!);
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toContain("changed since you confirmed. Check again."));
    expect(l.log.some((x) => x.startsWith("PATCH"))).toBe(false);
    expect(button(container, "Wire source")).toBeDefined();
  });

  it("an existing route on the source refuses at the first click, naming it", async () => {
    const l = leader();
    (l.state.table["routes"] as unknown[]).unshift({ id: "mine", filter: "__inputId=='in_pan'", pipeline: "p", output: "o" });
    const { container } = renderWith(l);
    fireEvent.change(sourceInput(container), { target: { value: "in_pan" } });
    fireEvent.click(button(container, "Wire source")!);
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toContain("already routes this source"));
    expect(container.querySelector('[role="status"]')!.textContent).toContain("route mine");
    expect(container.querySelector(".azo-confirm")).toBeNull();
    expect(l.log.filter((x) => !x.startsWith("GET "))).toEqual([]);
  });
});
