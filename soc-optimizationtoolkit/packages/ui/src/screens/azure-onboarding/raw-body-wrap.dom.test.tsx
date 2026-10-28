// @vitest-environment happy-dom
/**
 * Pins for AZR-44: a raw Azure or Cribl response body quoted on the onboarding
 * screens wraps instead of pushing the page sideways inside the Cribl frame.
 *
 * happy-dom cannot measure layout, so this pins the two halves that can fail:
 *   - the element that renders the body sits under a class (itself or an
 *     ancestor - overflow-wrap is inherited) whose stylesheet rule declares
 *     overflow-wrap: anywhere, resolved as the NEAREST class that declares
 *     overflow-wrap at all, so a closer rule resetting it would fail here;
 *   - that rule's declaration exists in styles.css, read the way
 *     dataflow/edge-styles.test.ts reads it (comments stripped).
 *
 * The body below is shaped like a real ARM 403: JSON with a resource scope
 * that has no space to break at.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FakeKvDocumentStore, PLAN_VALUE_KEYS, defaultPlanValues } from "@soc/core";
import type {
  AzureConfig,
  AzureManagementRequest,
  OnboardingCriblSide,
  PlanValues,
  PortHttpResponse,
  ValidationPlan,
  ValidationResult,
} from "@soc/core";

import { PortsProvider, type UiPorts } from "../../ports-context";
import { AzureLoggingMapScreen } from "../azure-logging-map/azure-logging-map-screen";
import { AzureOnboardingScreen } from "./azure-onboarding-screen";
import { CriblSourcePanel } from "./cribl-source/cribl-source-panel";
import { sourceRows } from "./cribl-source/cribl-source-state";
import { PickerLine } from "./eventhub-prerequisite-section";
import { ValidatePanel } from "./validate/validate-panel";

// The logging map's only raw-body line is its run failure, which only a throw
// out of readLoggingMap reaches; everything else in core stays real.
const mapFailure = vi.hoisted(() => ({ message: "" }));
vi.mock("@soc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@soc/core")>();
  return {
    ...actual,
    readLoggingMap: async () => {
      throw new Error(mapFailure.message);
    },
  };
});

afterEach(cleanup);

const SCOPE =
  "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/rg-onboarding-eastus2/providers/" +
  "Microsoft.EventHub/namespaces/ns-onboarding-eastus2-0001/authorizationRules/RootManageSharedAccessKey";
const body = (tag: string): string =>
  `HTTP 403\n{"error":{"code":"AuthorizationFailed","message":"${tag}","scope":"${SCOPE}"}}`;

// ---------------------------------------------------------------------------
// The stylesheet, and the nearest class that decides overflow-wrap
// ---------------------------------------------------------------------------

const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** overflow-wrap per single-class selector, from top-level plain rules; the last one wins. */
function overflowWrapByClass(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = /(?:^|;)\s*overflow-wrap\s*:\s*([^;]+)/.exec(m[2]);
    if (decl === null) continue;
    for (const sel of m[1].split(",").map((s) => s.trim())) {
      if (/^\.[\w-]+$/.test(sel)) out.set(sel.slice(1), decl[1].trim());
    }
  }
  return out;
}

const WRAP = overflowWrapByClass(css);

/** The one innermost element whose whole text is exactly `text`. */
function exactly(text: string): HTMLElement {
  const all = [...document.body.querySelectorAll<HTMLElement>("*")].filter((e) => e.textContent === text);
  const inner = all.filter((e) => ![...e.children].some((c) => c.textContent === text));
  expect(inner.length).toBe(1);
  return inner[0]!;
}

/** The innermost element whose text holds `token`. */
function carrier(token: string): HTMLElement {
  const all = [...document.body.querySelectorAll<HTMLElement>("*")].filter((e) => e.textContent?.includes(token));
  const inner = all.filter((e) => ![...e.children].some((c) => c.textContent?.includes(token)));
  expect(inner.length).toBe(1);
  return inner[0]!;
}

/** The nearest self-or-ancestor class that sets overflow-wrap, and its value. */
function wrapOf(el: HTMLElement): { cls: string; value: string } | null {
  for (let e: HTMLElement | null = el; e !== null; e = e.parentElement) {
    for (const cls of e.classList) {
      const value = WRAP.get(cls);
      if (value !== undefined) return { cls, value };
    }
  }
  return null;
}

describe("AZR-44 - the wrapping rules exist", () => {
  it("each class that carries a quoted body declares overflow-wrap: anywhere", () => {
    for (const cls of [
      "azo-validate",
      "azo-cribl-source",
      "azure-onboarding-banner",
      "azure-onboarding-defender",
      "azure-onboarding-state",
      "lm-note-unknown",
    ]) {
      expect([cls, WRAP.get(cls)]).toEqual([cls, "anywhere"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

const values = (over: Partial<PlanValues> = {}): PlanValues =>
  ({ ...Object.fromEntries(PLAN_VALUE_KEYS.map((k) => [k, ""])), ...over }) as PlanValues;
const VALUES = values({ subscriptionId: "sub-1", resourceGroup: "rg-1", namespace: "ns-live" });
const PLAN = { values: VALUES, firstPageReads: 2, listReads: 0, maxReads: 2, missing: [] } as unknown as ValidationPlan;

const RESULT: ValidationResult = {
  verdicts: {},
  checks: [
    {
      key: "k1",
      sourceId: "defenderExport",
      stepId: "eh-namespace",
      kind: "eh-namespace",
      verdict: { kind: "unknown", reason: "failed", detail: body("verdict-body") },
    },
  ],
  measuredHubs: [],
  arrival: { hub1: { kind: "unknown", reason: "failed", detail: body("arrival-body") } },
  cancelled: false,
};

function renderValidate(run: Parameters<typeof ValidatePanel>[0]["run"]): void {
  render(<ValidatePanel plan={PLAN} hasPacing run={run} onValidate={() => {}} onCancel={() => {}} />);
}

describe("AZR-44 - Validate quotes bodies inside a wrapping panel", () => {
  it("an unknown verdict's body and an unreadable arrival's body wrap", () => {
    renderValidate({ kind: "done", result: RESULT, asOf: "2026-10-28T00:00:00Z", values: VALUES });
    const verdict = carrier("verdict-body");
    expect(verdict.textContent).toContain(SCOPE);
    expect(verdict.closest("li")?.className).toBe("azo-verdict");
    expect(wrapOf(verdict)).toEqual({ cls: "azo-validate", value: "anywhere" });
    const arrival = carrier("arrival-body");
    expect(arrival.textContent).toContain(SCOPE);
    expect(wrapOf(arrival)).toEqual({ cls: "azo-validate", value: "anywhere" });
  });

  it("the 'Validate stopped' line's body wraps", () => {
    renderValidate({ kind: "failed", message: body("stopped-body") });
    const line = carrier("stopped-body");
    expect(line.textContent).toBe(`Validate stopped: ${body("stopped-body")}`);
    expect(wrapOf(line)).toEqual({ cls: "azo-validate", value: "anywhere" });
  });
});

// ---------------------------------------------------------------------------
// The shared banner (Defender export, Event Hub prerequisite, screen, How-to)
// ---------------------------------------------------------------------------

describe("AZR-44 - the shared PickerLine banner wraps", () => {
  it("an error banner quoting a body wraps on its own class", () => {
    render(<PickerLine message={{ tone: "error", text: body("banner-body") }} />);
    const line = carrier("banner-body");
    expect(line.className).toBe("azure-onboarding-banner azure-onboarding-banner-error");
    expect(wrapOf(line)).toEqual({ cls: "azure-onboarding-banner", value: "anywhere" });
  });
});

// ---------------------------------------------------------------------------
// Cribl source panel
// ---------------------------------------------------------------------------

describe("AZR-44 - the Cribl source row wraps what Cribl answered", () => {
  it("an unreadable input and route quote their bodies inside the wrapping row", () => {
    const record = { groupId: "g1", inputId: "azure_onb_eh_ns1_h1", inputType: "eventhub" as const, secretId: "s1" };
    const side: OnboardingCriblSide = {
      groupId: "g1",
      requests: [],
      inputs: [
        {
          inputId: record.inputId,
          inputType: "eventhub",
          input: { kind: "unknown", reason: "denied", detail: body("input-body") },
          route: { kind: "unknown", reason: "denied", detail: body("route-body") },
        },
      ],
    };
    render(
      <CriblSourcePanel
        rows={sourceRows(["defenderExport"], { criblSources: { defenderExport: record } })}
        modes={{ defenderExport: "manual" }}
        values={{ ...defaultPlanValues(null), namespace: "ns1", hubName: "h1" }}
        readSeq={1}
        workerGroups={{ kind: "idle" }}
        onLoadGroups={() => {}}
        groupId="g1"
        onGroupChange={() => {}}
        rules={null}
        topicsFor={() => ({ kind: "ok", topics: ["h1"] })}
        principal={null}
        onPlan={vi.fn()}
        onApply={vi.fn()}
        criblSide={side}
      />,
    );
    const line = carrier("input-body");
    expect(line.textContent).toContain("route-body");
    expect(line.closest("section")?.className).toBe("azo-cribl-row");
    expect(wrapOf(line)).toEqual({ cls: "azo-cribl-source", value: "anywhere" });
  });

  it("a worker-group list failure quotes its body in the no-wrap controls row and still wraps", () => {
    // What worker-group-listing stores: String(err) of the adapter's
    // "GET /master/groups: HTTP 403\n<body>" Error.
    const error = `Error: GET /master/groups: ${body("groups-body")}`;
    render(
      <CriblSourcePanel
        rows={[]}
        modes={{}}
        values={defaultPlanValues(null)}
        readSeq={0}
        workerGroups={{ kind: "failed", error }}
        onLoadGroups={() => {}}
        groupId=""
        onGroupChange={() => {}}
        rules={null}
        topicsFor={() => ({ kind: "ok", topics: [] })}
        principal={null}
        onPlan={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    const line = carrier("groups-body");
    expect(line.textContent).toBe(`Could not list worker groups: ${error}`);
    expect(line.parentElement?.className).toBe("panel-controls");
    expect(wrapOf(line)).toEqual({ cls: "azo-cribl-source", value: "anywhere" });
  });
});

// ---------------------------------------------------------------------------
// The screen's Defender row and Deploy reason
// ---------------------------------------------------------------------------

describe("AZR-44 - a refused Defender read quotes Azure's message outside the banner too", () => {
  // ARM's AuthorizationFailed message carries the scope with no space in it;
  // defender-export quotes it as "<what>: HTTP 403 - <message>".
  const MESSAGE =
    "The client 'c1' with object id 'o1' does not have authorization to perform action " +
    `'Microsoft.Security/automations/read' over scope '${SCOPE}' or the scope is invalid.`;
  const QUOTED = `List Defender automations: HTTP 403 - ${MESSAGE}`;

  it("the item row's state label and Deploy's disabled reason both wrap", async () => {
    const refused = async (_r: AzureManagementRequest): Promise<PortHttpResponse> =>
      ({
        ok: false,
        status: 403,
        body: { error: { code: "AuthorizationFailed", message: MESSAGE } },
      }) as unknown as PortHttpResponse;
    const config = { tenantId: "t1", clientId: "c1", subscriptionId: "sub-1" } as unknown as AzureConfig;
    render(
      <PortsProvider
        ports={{ azure: { request: refused }, kvDocuments: new FakeKvDocumentStore() } as unknown as UiPorts}
        config={config}
      >
        <AzureOnboardingScreen />
      </PortsProvider>,
    );
    await waitFor(() => expect(screen.queryByText("Loading the saved selection...")).toBeNull());
    const tick = screen.getByRole("checkbox", { name: "Defender for Cloud alert export" }) as HTMLInputElement;
    if (!tick.checked) fireEvent.click(tick);
    expect(tick.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Read Defender state" }));
    await waitFor(() => expect(screen.getByText(`Deployment state could not be read - ${QUOTED}`)).toBeTruthy());

    const label = exactly(`Deployment state could not be read - ${QUOTED}`);
    expect(label.className).toBe("azure-onboarding-state azure-onboarding-state-unknown");
    expect(wrapOf(label)).toEqual({ cls: "azure-onboarding-state", value: "anywhere" });

    const reason = exactly(`The Defender state could not be read - ${QUOTED}`);
    expect(reason.parentElement?.className).toBe("panel-controls");
    expect(wrapOf(reason)).toEqual({ cls: "azure-onboarding-defender", value: "anywhere" });
  });
});

// ---------------------------------------------------------------------------
// Logging map
// ---------------------------------------------------------------------------

describe("AZR-44 - the logging map's failure line wraps", () => {
  it("'The map could not be read' quotes the error and wraps on lm-note-unknown", async () => {
    mapFailure.message = body("map-body");
    const config = { tenantId: "t1", clientId: "c1" } as unknown as AzureConfig;
    render(
      <PortsProvider ports={{ azure: {} } as unknown as UiPorts} config={config}>
        <AzureLoggingMapScreen />
      </PortsProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("map-body"));
    const line = carrier("map-body");
    expect(line.textContent).toBe(`The map could not be read: ${body("map-body")}`);
    expect(wrapOf(line)).toEqual({ cls: "lm-note-unknown", value: "anywhere" });
  });
});
