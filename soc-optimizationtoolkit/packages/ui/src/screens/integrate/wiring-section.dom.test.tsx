// @vitest-environment happy-dom
/**
 * DBT-152: the Ensure secret action renders each ensureTextSecret outcome.
 * Created and updated are notes in the ok state; a refusal (the secret there
 * is someone else's, or its owner could not be read) and a failure render the
 * outcome's own message in the failed state, so the operator is told the id
 * and that it was left unchanged - never a bare "ok" over a secret this app
 * did not write.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { APP_ID, SENTINEL_CLIENT_SECRET_NAME } from "@soc/core";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { WiringSection } from "./wiring-section";

afterEach(cleanup);

type Scripted = { status: number; body: unknown };

const STAMP = `[managed-by:${APP_ID}]`;

function renderWith(responses: Scripted[]) {
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unscripted request");
    return next;
  });
  const ports = { cribl: { request } } as unknown as UiPorts;
  const view = render(
    <PortsProvider ports={ports} config={{} as AzureConfig}>
      <WiringSection
        deployCompleted
        mode="full"
        deploymentType="cloud"
        workerGroup="default"
        packName="my-pack"
      />
    </PortsProvider>,
  );
  return { ...view, request };
}

async function ensure(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  fireEvent.change(input, { target: { value: "s3cr3t" } });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Ensure secret")!;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  // The first status chip is the secret action's.
  await waitFor(() => expect(container.querySelector(".status")?.textContent).not.toMatch(/idle|running/));
  return {
    state: container.querySelector(".status")?.textContent,
    text: [...container.querySelectorAll("pre.result")].map((p) => p.textContent).join("\n"),
  };
}

describe("WiringSection Ensure secret outcomes (DBT-152)", () => {
  it("created: ok, and says so", async () => {
    const { container } = renderWith([{ status: 201, body: {} }]);
    expect(await ensure(container)).toEqual({
      state: "ok",
      text: `Created Cribl secret ${SENTINEL_CLIENT_SECRET_NAME}.`,
    });
  });

  it("409 on a secret this app stamped: ok, updated", async () => {
    const { container, request } = renderWith([
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: SENTINEL_CLIENT_SECRET_NAME, description: `x ${STAMP}` }] } },
      { status: 200, body: {} },
    ]);
    expect(await ensure(container)).toEqual({
      state: "ok",
      text: `Updated existing Cribl secret ${SENTINEL_CLIENT_SECRET_NAME}.`,
    });
    expect(request.mock.calls.map((c) => (c as unknown as [{ method: string }])[0].method)).toEqual(["POST", "GET", "PATCH"]);
  });

  it("409 on someone else's secret: failed, the refusal names the id, and no PATCH is sent", async () => {
    const { container, request } = renderWith([
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: SENTINEL_CLIENT_SECRET_NAME, description: "Made by hand" }] } },
    ]);
    const shown = await ensure(container);
    expect(shown.state).toBe("failed");
    expect(shown.text).toContain(`Cribl secret '${SENTINEL_CLIENT_SECRET_NAME}' already exists`);
    expect(shown.text).toContain("it was left unchanged");
    expect(request.mock.calls.map((c) => (c as unknown as [{ method: string }])[0].method)).toEqual(["POST", "GET"]);
  });

  it("409 whose owner cannot be read: failed, says the owner could not be read", async () => {
    const { container } = renderWith([
      { status: 409, body: {} },
      { status: 403, body: { message: "Forbidden" } },
    ]);
    const shown = await ensure(container);
    expect(shown.state).toBe("failed");
    expect(shown.text).toBe(
      `Cribl secret '${SENTINEL_CLIENT_SECRET_NAME}' already exists and its owner could not be read (HTTP 403); it was left unchanged.`,
    );
  });

  it("400: failed with the HTTP status, no overwrite", async () => {
    const { container, request } = renderWith([{ status: 400, body: { message: "bad" } }]);
    const shown = await ensure(container);
    expect(shown.state).toBe("failed");
    expect(shown.text).toContain("HTTP 400");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
