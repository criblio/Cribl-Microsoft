// @vitest-environment happy-dom
/**
 * Pins for the Cribl source panel (AZR-34, unit V2).
 *
 * The failures these exist to catch, each one a way this panel could write to
 * another admin's Cribl without meaning to, or leak a key:
 *   - one click creating the source (the confirm must come first);
 *   - a confirm that stays armed after the worker group or the pasted key
 *     changed, so the second click writes somewhere the confirm did not name;
 *   - mounting the panel listing worker groups (zero calls on mount);
 *   - the pasted connection string surviving the apply in the DOM or the ref;
 *   - the key shown back to the operator instead of only its descriptor;
 *   - a Send-only rule offered, or a Send-only paste allowed, for a source
 *     that must Listen;
 *   - a blob lane's confirm staying armed after its client secret changed or
 *     was cleared (it has no descriptor to change the arm key);
 *   - the attestation, the blob principal gate or the listKeys credential
 *     implemented in state but not wired into the panel;
 *   - an Event Hub lane defaulting to a SAS key instead of Entra ID, or the
 *     Entra ID client secret reaching state or the DOM (AZR-59, ADR 0008).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { defaultPlanValues, readRefused, streamWorkerGroups, toListing } from "@soc/core";
import type {
  ApplyCredential,
  ApplyCriblSourceOutcome,
  ListRead,
  NamespaceAuthRule,
  OnboardingCriblSide,
  PlanCredential,
  PlanCriblSourceResult,
  ReadyCriblSource,
} from "@soc/core";
import type { WorkerGroupsState } from "../../../components/worker-group-listing";
import { CriblSourcePanel } from "./cribl-source-panel";
import type { CriblSourcePanelProps } from "./cribl-source-panel";
import { sourceRows } from "./cribl-source-state";

afterEach(cleanup);

const KEY = "s3cr3tKeyValue0123456789==";
const PASTE = `Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=reader;SharedAccessKey=${KEY};EntityPath=h1`;
const PASTE_OTHER_RULE = `Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=reader2;SharedAccessKey=${KEY};EntityPath=h1`;
const PASTE_SEND = `Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=SendOnly;SharedAccessKey=${KEY};EntityPath=h1`;

const READY: ReadyCriblSource = {
  groupId: "g1",
  sourceId: "defenderExport",
  inputId: "azure_onb_eh_ns1_h1",
  inputType: "eventhub",
  secretId: "azure_onb_eh_ns1_h1_secret",
  keyNameOrPrincipal: "reader",
  credentialKind: "paste",
  attested: false,
  descriptor: { host: "ns1.servicebus.windows.net", keyName: "reader", entityPath: "h1" },
  commitFiles: ["groups/g1/cribl/inputs.yml", "groups/g1/cribl/secrets.yml"],
  dirtyAlready: [],
  scope: { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false },
  inputBody: {},
  namespace: { subscriptionId: "sub", resourceGroup: "rg", name: "ns1" },
  kvRecord: null,
  secretDescription: "",
  readsFrom: { hubs: ["h1"], consumerGroup: "cribl" },
  entraPrincipal: null,
};

const OUTCOME: ApplyCriblSourceOutcome = {
  kind: "created-running",
  record: { groupId: "g1", inputId: READY.inputId, inputType: "eventhub", secretId: READY.secretId },
  configVersion: "a1b2c3d",
} as ApplyCriblSourceOutcome;

const RULES: ListRead<NamespaceAuthRule> = {
  state: "read",
  rows: [
    { name: "reader", id: "", rights: ["Listen"] },
    { name: "reader2", id: "", rights: ["Listen"] },
    { name: "manager", id: "", rights: ["Manage", "Listen", "Send"] },
    { name: "SendOnly", id: "", rights: ["Send"] },
  ],
};

const GROUPS: WorkerGroupsState = {
  kind: "loaded",
  groups: streamWorkerGroups(toListing([{ id: "g1", product: "stream" }, { id: "g2", product: "stream" }])),
};

function props(over: Partial<CriblSourcePanelProps> = {}): CriblSourcePanelProps {
  return {
    rows: sourceRows(["defenderExport"], { criblSources: {} }),
    modes: { defenderExport: "manual" },
    values: { ...defaultPlanValues(null), namespace: "ns1", hubName: "h1" },
    readSeq: 1,
    workerGroups: GROUPS,
    onLoadGroups: vi.fn(),
    groupId: "g1",
    onGroupChange: vi.fn(),
    rules: RULES,
    topicsFor: () => ({ kind: "ok", topics: ["h1"] }),
    principal: null,
    onPlan: vi.fn(async (): Promise<PlanCriblSourceResult> => ({ kind: "ready", ready: READY })),
    onApply: vi.fn(async () => OUTCOME),
    ...over,
  };
}

/** Picks a credential radio by its label. */
function chooseCredential(label: RegExp): void {
  fireEvent.click(screen.getByLabelText(label));
}

/**
 * The connection-string field. Entra ID is the Event Hub default (ADR 0008),
 * so the paste fallback is chosen first when its field is not showing.
 */
function pasteField(): HTMLInputElement {
  if (screen.queryByLabelText(/Connection string for/) === null) chooseCredential(/^Paste a connection string/);
  return screen.getByLabelText(/Connection string for/) as HTMLInputElement;
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Create the Cribl source|Confirm: create the source/ }) as HTMLButtonElement;
}

async function armWithPaste(p: CriblSourcePanelProps, value = PASTE): Promise<void> {
  fireEvent.change(pasteField(), { target: { value } });
  fireEvent.click(createButton());
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm: create the source" })).toBeTruthy());
  expect(p.onPlan).toHaveBeenCalledTimes(1);
}

describe("CriblSourcePanel", () => {
  it("makes no call on mount; only 'Load worker groups' lists them", () => {
    const onReadCriblSide = vi.fn();
    const onReadRules = vi.fn();
    const p = props({ workerGroups: { kind: "idle" }, onReadCriblSide, onReadRules });
    render(<CriblSourcePanel {...p} />);
    expect(p.onLoadGroups).not.toHaveBeenCalled();
    expect(p.onPlan).not.toHaveBeenCalled();
    expect(p.onApply).not.toHaveBeenCalled();
    expect(onReadCriblSide).not.toHaveBeenCalled();
    expect(onReadRules).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    expect(p.onLoadGroups).toHaveBeenCalledTimes(1);
  });

  it("plans on the first click and shows the confirm, and applies only on the second", async () => {
    const p = props();
    render(<CriblSourcePanel {...p} />);
    await armWithPaste(p);
    expect(p.onApply).not.toHaveBeenCalled();
    const credential = vi.mocked(p.onPlan).mock.calls[0]![1] as PlanCredential;
    expect(credential).toEqual({ kind: "paste", descriptor: READY.descriptor, attested: false });
    const confirm = screen.getByRole("alert").textContent ?? "";
    for (const named of ["g1", READY.inputId, READY.secretId, "reader", ...READY.commitFiles]) {
      expect(confirm, named).toContain(named);
    }
    expect(confirm).toContain("The commit can include at most these files");
    fireEvent.click(createButton());
    await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(1));
    expect(vi.mocked(p.onApply).mock.calls[0]![0]).toBe(READY);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Created and running"));
  });

  it("disarms when the worker group changes", async () => {
    const p = props();
    const { rerender } = render(<CriblSourcePanel {...p} />);
    await armWithPaste(p);
    rerender(<CriblSourcePanel {...p} groupId="g2" />);
    expect(screen.queryByRole("button", { name: "Confirm: create the source" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(createButton());
    // The click re-plans; it never applies against the old confirm.
    await waitFor(() => expect(p.onPlan).toHaveBeenCalledTimes(2));
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("disarms when the pasted string's descriptor changes", async () => {
    const p = props();
    render(<CriblSourcePanel {...p} />);
    await armWithPaste(p);
    fireEvent.change(pasteField(), { target: { value: PASTE_OTHER_RULE } });
    expect(screen.queryByRole("button", { name: "Confirm: create the source" })).toBeNull();
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("clears the paste from the DOM and the ref after the apply", async () => {
    let captured: ApplyCredential | null = null;
    let valueAtApply = "";
    const p = props({
      onApply: vi.fn(async (_ready: ReadyCriblSource, credential: ApplyCredential) => {
        captured = credential;
        valueAtApply = credential.kind === "paste" ? credential.value() : "";
        return OUTCOME;
      }),
    });
    const { container } = render(<CriblSourcePanel {...p} />);
    await armWithPaste(p);
    fireEvent.click(createButton());
    await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    // The closure read the real value at apply time...
    expect(valueAtApply).toBe(PASTE);
    // ...and nothing holds it afterwards.
    expect(captured).not.toBeNull();
    const c = captured as unknown as ApplyCredential;
    expect(c.kind === "paste" ? c.value() : "x").toBe("");
    expect(pasteField().value).toBe("");
    expect(container.innerHTML).not.toContain(KEY);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value, attr.name).not.toContain(KEY);
      }
    }
  });

  it("shows the descriptor's key name and never the key", () => {
    const p = props();
    const { container } = render(<CriblSourcePanel {...p} />);
    fireEvent.change(pasteField(), { target: { value: PASTE } });
    const dl = screen.getByLabelText("Pasted connection string");
    expect(dl.textContent).toContain("reader");
    expect(dl.textContent).toContain("ns1.servicebus.windows.net");
    expect(container.innerHTML).not.toContain(KEY);
  });

  it("refuses a Send-only paste with 'cannot listen' before any call", () => {
    const p = props();
    render(<CriblSourcePanel {...p} />);
    fireEvent.change(pasteField(), { target: { value: PASTE_SEND } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/cannot listen/)).toBeTruthy();
    fireEvent.click(createButton());
    expect(p.onPlan).not.toHaveBeenCalled();
  });

  // AZR-58: the Manage rule is never offered; Send-only never was.
  it("offers only Listen rules without Manage for listKeys, none preselected", () => {
    const p = props({ modes: { defenderExport: "automate" } });
    render(<CriblSourcePanel {...p} />);
    chooseCredential(/^Let the app read the key/);
    const picker = screen.getByRole("button", { name: /Listen rule for/ });
    expect(picker.textContent).toBe("Choose a rule with Listen rights");
    fireEvent.click(picker);
    const names = Array.from(document.querySelectorAll(".searchable-select-option-label")).map(
      (o) => o.textContent,
    );
    expect(names).toEqual(["reader (Listen)", "reader2 (Listen)"]);
    expect(createButton().disabled).toBe(true);
  });

  it("says no hub has appeared yet when the lane's topics refused", () => {
    const p = props({ topicsFor: () => ({ kind: "refused", reason: "no-hub-measured", detail: "" }) });
    render(<CriblSourcePanel {...p} />);
    fireEvent.change(pasteField(), { target: { value: PASTE } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/No hub has appeared yet/)).toBeTruthy();
  });

  it("puts an (i) on every lane row", () => {
    const p = props({ rows: sourceRows(["defenderExport", "vnetFlowLogs"], { criblSources: {} }) });
    const { container } = render(<CriblSourcePanel {...p} />);
    const rows = container.querySelectorAll(".azo-cribl-row");
    expect(rows.length).toBe(2);
    for (const row of Array.from(rows)) {
      expect(row.querySelector("h4 .info-tip-icon")).not.toBeNull();
    }
  });
});

const BLOB_SECRET = "blobClientSecretValue-9876";
const PRINCIPAL = { tenantId: "tenant-1", clientId: "client-1" };
const READY_BLOB: ReadyCriblSource = {
  ...READY,
  sourceId: "vnetFlowLogs",
  inputId: "azure_onb_blob_acct_q1",
  inputType: "azure_blob",
  secretId: "azure_onb_blob_acct_q1_secret",
  keyNameOrPrincipal: "client-1",
  credentialKind: "client-secret",
  descriptor: null,
  readsFrom: null,
} as ReadyCriblSource;

function blobProps(over: Partial<CriblSourcePanelProps> = {}): CriblSourcePanelProps {
  return props({
    rows: sourceRows(["vnetFlowLogs"], { criblSources: {} }),
    modes: { vnetFlowLogs: "manual" },
    principal: PRINCIPAL,
    onPlan: vi.fn(async (): Promise<PlanCriblSourceResult> => ({ kind: "ready", ready: READY_BLOB })),
    ...over,
  });
}

function blobSecretField(): HTMLInputElement {
  return screen.getByLabelText(/Client secret for/) as HTMLInputElement;
}

async function armBlob(p: CriblSourcePanelProps): Promise<void> {
  fireEvent.change(blobSecretField(), { target: { value: BLOB_SECRET } });
  fireEvent.click(createButton());
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm: create the source" })).toBeTruthy());
  expect(p.onPlan).toHaveBeenCalledTimes(1);
}

describe("CriblSourcePanel - blob lane", () => {
  it("keeps Create disabled with the principal reason while no principal is set up", () => {
    const p = blobProps({ principal: null });
    render(<CriblSourcePanel {...p} />);
    fireEvent.change(blobSecretField(), { target: { value: BLOB_SECRET } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/service principal's tenant and client id are not set up/)).toBeTruthy();
    fireEvent.click(createButton());
    expect(p.onPlan).not.toHaveBeenCalled();
  });

  it("plans as the principal and applies with a closure that is empty after the apply", async () => {
    let valueAtApply = "";
    let captured: ApplyCredential | null = null;
    const p = blobProps({
      onApply: vi.fn(async (_ready: ReadyCriblSource, credential: ApplyCredential) => {
        captured = credential;
        valueAtApply = credential.kind === "paste" ? credential.value() : "";
        return OUTCOME;
      }),
    });
    const { container } = render(<CriblSourcePanel {...p} />);
    await armBlob(p);
    expect(vi.mocked(p.onPlan).mock.calls[0]![1]).toEqual({ kind: "client-secret", ...PRINCIPAL });
    fireEvent.click(createButton());
    await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(valueAtApply).toBe(BLOB_SECRET);
    const c = captured as unknown as ApplyCredential;
    expect(c.kind).toBe("paste");
    expect(c.kind === "paste" ? c.value() : "x").toBe("");
    expect(blobSecretField().value).toBe("");
    expect(container.innerHTML).not.toContain(BLOB_SECRET);
  });

  it("disarms when the client secret is cleared after arming, and never applies", async () => {
    const p = blobProps();
    render(<CriblSourcePanel {...p} />);
    await armBlob(p);
    fireEvent.change(blobSecretField(), { target: { value: "" } });
    expect(screen.queryByRole("button", { name: "Confirm: create the source" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(createButton().disabled).toBe(true);
    fireEvent.click(createButton());
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("disarms when the client secret changes after arming", async () => {
    const p = blobProps();
    render(<CriblSourcePanel {...p} />);
    await armBlob(p);
    fireEvent.change(blobSecretField(), { target: { value: `${BLOB_SECRET}-edited` } });
    expect(screen.queryByRole("button", { name: "Confirm: create the source" })).toBeNull();
    fireEvent.click(createButton());
    // The click re-plans against what is on screen; it never applies the old confirm.
    await waitFor(() => expect(p.onPlan).toHaveBeenCalledTimes(2));
    expect(p.onApply).not.toHaveBeenCalled();
  });
});

describe("CriblSourcePanel - attestation and listKeys wiring", () => {
  const DENIED: ListRead<NamespaceAuthRule> = readRefused<NamespaceAuthRule>({
    request: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns1/authorizationRules",
    status: 403,
    code: "AuthorizationFailed",
    text: "denied",
    reason: "http",
  });

  it("offers the attestation only when the rules could not be read, and plans with attested:true once ticked", async () => {
    const p = props({ rules: DENIED });
    render(<CriblSourcePanel {...p} />);
    expect(screen.queryByLabelText("This key has Listen rights")).toBeNull();
    fireEvent.change(pasteField(), { target: { value: PASTE } });
    const box = screen.getByLabelText("This key has Listen rights") as HTMLInputElement;
    expect(createButton().disabled).toBe(true);
    fireEvent.click(createButton());
    expect(p.onPlan).not.toHaveBeenCalled();
    fireEvent.click(box);
    expect(createButton().disabled).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(p.onPlan).toHaveBeenCalledTimes(1));
    expect(vi.mocked(p.onPlan).mock.calls[0]![1]).toEqual({
      kind: "paste",
      descriptor: READY.descriptor,
      attested: true,
    });
  });

  it("does not offer the attestation when the rules were read", () => {
    const p = props();
    render(<CriblSourcePanel {...p} />);
    fireEvent.change(pasteField(), { target: { value: PASTE } });
    expect(screen.queryByLabelText("This key has Listen rights")).toBeNull();
  });

  it("with the listKeys fallback chosen, plans with the chosen rule and applies with the listKeys credential", async () => {
    const readyListKeys = { ...READY, credentialKind: "listKeys", descriptor: null } as ReadyCriblSource;
    const p = props({
      modes: { defenderExport: "automate" },
      onPlan: vi.fn(async (): Promise<PlanCriblSourceResult> => ({ kind: "ready", ready: readyListKeys })),
    });
    render(<CriblSourcePanel {...p} />);
    chooseCredential(/^Let the app read the key/);
    fireEvent.click(screen.getByRole("button", { name: /Listen rule for/ }));
    const reader = Array.from(document.querySelectorAll(".searchable-select-option")).find(
      (o) => o.querySelector(".searchable-select-option-label")?.textContent === "reader (Listen)",
    );
    fireEvent.click(reader!);
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm: create the source" })).toBeTruthy());
    expect(vi.mocked(p.onPlan).mock.calls[0]![1]).toEqual({ kind: "listKeys", rule: "reader" });
    fireEvent.click(createButton());
    await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(1));
    expect(vi.mocked(p.onApply).mock.calls[0]![1]).toEqual({ kind: "listKeys" });
  });
});

describe("CriblSourcePanel - Cribl side line", () => {
  const record = { groupId: "g1", inputId: READY.inputId, inputType: "eventhub" as const, secretId: READY.secretId };
  const side = (legacy: boolean): OnboardingCriblSide => ({
    groupId: "g1",
    requests: [],
    inputs: [
      {
        inputId: record.inputId,
        inputType: "eventhub",
        input: { kind: "present", type: "eventhub", disabled: false, sendToRoutes: true, connections: [] },
        route: {
          kind: "consumes",
          routes: [
            { id: "w", name: "wired", filter: "", output: "sentinel_out", final: true, ...(legacy ? { legacyBareMatch: true as const } : {}) },
          ],
        },
      },
    ],
  });
  const rows = sourceRows(["defenderExport"], { criblSources: { defenderExport: record } });

  // DBT-162: a route that names the input only by its bare id still shows,
  // but the line never presents it as a confirmed route.
  it("marks a bare-id route as unconfirmed and leaves a typed route plain", () => {
    render(<CriblSourcePanel {...props({ rows, criblSide: side(true) })} />);
    expect(
      screen.getByText(/routed by wired to sentinel_out \(unconfirmed: its filter names the bare input id\)\.$/),
    ).toBeTruthy();
    cleanup();
    render(<CriblSourcePanel {...props({ rows, criblSide: side(false) })} />);
    expect(screen.getByText(/routed by wired to sentinel_out\.$/)).toBeTruthy();
  });
});

// AZR-59, ADR 0008: Entra ID is the Event Hub lane's default credential.
describe("CriblSourcePanel - Entra ID", () => {
  const CLIENT_SECRET = "entraClientSecretValue-4242";
  const READY_ENTRA = {
    ...READY,
    credentialKind: "entra-id",
    keyNameOrPrincipal: "cribl-client",
    descriptor: null,
    namespace: null,
    entraPrincipal: {
      tenantId: "cribl-tenant",
      clientId: "cribl-client",
      objectId: "obj-1",
      role: "Azure Event Hubs Data Receiver",
      roleScope: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns1",
      principalCheck: "not-cross-checked",
    },
  } as ReadyCriblSource;

  function entraProps(over: Partial<CriblSourcePanelProps> = {}): CriblSourcePanelProps {
    return props({
      values: {
        ...defaultPlanValues(null),
        namespace: "ns1",
        hubName: "h1",
        criblPrincipalObjectId: "obj-1",
        criblTenantId: "cribl-tenant",
        criblClientId: "cribl-client",
      },
      onPlan: vi.fn(async (): Promise<PlanCriblSourceResult> => ({ kind: "ready", ready: READY_ENTRA })),
      ...over,
    });
  }

  const secretField = () => screen.getByLabelText(/Cribl principal client secret for/) as HTMLInputElement;
  const clientField = () => screen.getByLabelText(/Cribl principal client ID for/) as HTMLInputElement;
  const tenantField = () => screen.getByLabelText(/Cribl principal tenant ID for/) as HTMLInputElement;

  async function armEntra(p: CriblSourcePanelProps): Promise<void> {
    fireEvent.change(secretField(), { target: { value: CLIENT_SECRET } });
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm: create the source" })).toBeTruthy());
    expect(p.onPlan).toHaveBeenCalledTimes(1);
  }

  it("is offered first and chosen by default in both modes, before the SAS fallbacks", () => {
    for (const mode of ["manual", "automate"] as const) {
      render(<CriblSourcePanel {...entraProps({ modes: { defenderExport: mode } })} />);
      const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
      const labels = radios.map((r) => r.closest("label")?.textContent);
      expect(labels, mode).toEqual([
        "Entra ID - a Cribl service principal (recommended)",
        "Let the app read the key of the chosen Listen rule when you confirm",
        "Paste a connection string for a Listen rule",
      ]);
      expect(radios[0]!.checked, mode).toBe(true);
      expect(screen.queryByLabelText(/Connection string for/), mode).toBeNull();
      cleanup();
    }
  });

  it("prefills the tenant and client id from the plan values, each control with an (i)", () => {
    render(<CriblSourcePanel {...entraProps()} />);
    expect(tenantField().value).toBe("cribl-tenant");
    expect(clientField().value).toBe("cribl-client");
    expect(secretField().type).toBe("password");
    for (const field of [tenantField(), clientField(), secretField()]) {
      expect(field.closest("label")?.querySelector(".info-tip-icon"), field.getAttribute("aria-label") ?? "").not.toBeNull();
    }
  });

  it("plans as the Cribl principal and applies with the client secret through a closure emptied afterwards", async () => {
    let captured: ApplyCredential | null = null;
    let valueAtApply = "";
    const p = entraProps({
      onApply: vi.fn(async (_ready: ReadyCriblSource, credential: ApplyCredential) => {
        captured = credential;
        valueAtApply = credential.kind === "paste" ? credential.value() : "";
        return OUTCOME;
      }),
    });
    const { container } = render(<CriblSourcePanel {...p} />);
    await armEntra(p);
    expect(vi.mocked(p.onPlan).mock.calls[0]![1]).toEqual({ kind: "entra-id", tenantId: "cribl-tenant", clientId: "cribl-client" });
    const confirm = screen.getByRole("alert").textContent ?? "";
    expect(confirm).toContain("cribl-client");
    expect(confirm).toContain("No SAS key is used.");
    fireEvent.click(createButton());
    await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(valueAtApply).toBe(CLIENT_SECRET);
    const c = captured as unknown as ApplyCredential;
    expect(c.kind === "paste" ? c.value() : "x").toBe("");
    expect(secretField().value).toBe("");
    expect(container.innerHTML).not.toContain(CLIENT_SECRET);
  });

  it("keeps Create disabled without the client secret, and without the principal's object id", () => {
    render(<CriblSourcePanel {...entraProps()} />);
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Paste the Cribl service principal's client secret.")).toBeTruthy();
    cleanup();
    const p = entraProps({ values: { ...defaultPlanValues(null), namespace: "ns1", hubName: "h1", criblTenantId: "t", criblClientId: "c" } });
    render(<CriblSourcePanel {...p} />);
    fireEvent.change(secretField(), { target: { value: CLIENT_SECRET } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Enter the Cribl service principal's object ID.")).toBeTruthy();
    fireEvent.click(createButton());
    expect(p.onPlan).not.toHaveBeenCalled();
  });

  it("refuses this app's own registration as the Cribl principal before any call", () => {
    const p = entraProps({ principal: { tenantId: "cribl-tenant", clientId: "CRIBL-CLIENT" } });
    render(<CriblSourcePanel {...p} />);
    fireEvent.change(secretField(), { target: { value: CLIENT_SECRET } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/^That client ID is this app's own registration/)).toBeTruthy();
    fireEvent.click(createButton());
    expect(p.onPlan).not.toHaveBeenCalled();
  });

  // Review finding 4: the ids follow the plan values until the operator edits
  // them, and never fall back to this app's own tenant.
  it("syncs untouched tenant and client fields from later plan values, keeps an edited one, and never borrows the app's tenant", () => {
    const blank = { ...defaultPlanValues(null), namespace: "ns1", hubName: "h1", criblPrincipalObjectId: "obj-1" };
    const p = entraProps({ values: blank, principal: { tenantId: "app-tenant", clientId: "app-client" } });
    const { rerender } = render(<CriblSourcePanel {...p} />);
    expect(tenantField().value).toBe("");
    expect(clientField().value).toBe("");
    rerender(<CriblSourcePanel {...p} values={{ ...blank, criblTenantId: "cribl-tenant", criblClientId: "cribl-client" }} />);
    expect(tenantField().value).toBe("cribl-tenant");
    expect(clientField().value).toBe("cribl-client");
    fireEvent.change(clientField(), { target: { value: "typed-client" } });
    rerender(<CriblSourcePanel {...p} values={{ ...blank, criblTenantId: "tenant-2", criblClientId: "client-2" }} />);
    expect(tenantField().value).toBe("tenant-2");
    expect(clientField().value).toBe("typed-client");
  });

  // Review finding 8: a key never goes into the client secret's Cribl secret.
  it("keeps Create disabled when a connection string is pasted as the client secret, and never shows it", () => {
    const p = entraProps();
    const { container } = render(<CriblSourcePanel {...p} />);
    fireEvent.change(secretField(), { target: { value: PASTE } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/^That is a connection string, not a client secret/)).toBeTruthy();
    fireEvent.click(createButton());
    expect(p.onPlan).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(KEY);
  });

  it("disarms when the client id or the client secret changes after arming", async () => {
    for (const change of ["client", "secret"] as const) {
      const p = entraProps();
      render(<CriblSourcePanel {...p} />);
      await armEntra(p);
      if (change === "client") fireEvent.change(clientField(), { target: { value: "other-client" } });
      else fireEvent.change(secretField(), { target: { value: "different" } });
      expect(screen.queryByRole("button", { name: "Confirm: create the source" }), change).toBeNull();
      expect(p.onApply).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
