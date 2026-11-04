// @vitest-environment happy-dom
/**
 * AZR-62: the Setup tenant list (ADR 0009 decision 1). Paste tenant ids, get
 * a connection per new tenant and a change request per tenant to download.
 *
 * What these pins protect, each one a way the section could quietly do harm:
 *   - mount makes no call and downloads nothing;
 *   - an invalid entry is NAMED on screen, never silently dropped, and the
 *     collapsed duplicates are said;
 *   - only tenants with no connection are handed to the shell to create, so
 *     an existing connection (and the secret saved for it) is never replaced;
 *   - each download is exactly the core ticket for that tenant, as Markdown,
 *     through the ArtifactSink - and a refused download says so;
 *   - the panel has its (i) and the textarea has a label;
 *   - the combined file is offered as the requester's own copy, never as
 *     something to send;
 *   - a tenant two connections carry gets a request per connection, each
 *     labelled with the connection it covers;
 *   - a tenant that a domain-named connection might already carry is said to
 *     be UNKNOWN and is not created.
 */

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EMPTY_AZURE_CONFIG,
  FakeArtifactSink,
  FakeLogger,
  addTenantProfiles,
  tenantChangeRequests,
  tenantTicketTargets,
} from "@soc/core";
import type { AzureConfig, ConnectionProfile, ProfileStore } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { TenantListSection } from "./tenant-list-section";

afterEach(cleanup);

const TA = "aaaaaaaa-1111-4111-8111-111111111111";
const TB = "bbbbbbbb-2222-4222-8222-222222222222";
const TC = "cccccccc-3333-4333-8333-333333333333";
const APP = "Cribl SOC Optimization Toolkit";

const EXISTING: ConnectionProfile[] = [
  {
    id: "p-a",
    name: "Contoso prod",
    config: { ...EMPTY_AZURE_CONFIG, tenantId: TA.toUpperCase(), clientId: "11111111-1111-4111-8111-111111111111" },
  },
];

class RefusingSink extends FakeArtifactSink {
  override async save(): Promise<void> {
    throw new Error("download blocked");
  }
}

/** The shell's half: hold the store and add profiles the way App.tsx does. */
function mount(opts: { sink?: FakeArtifactSink; profiles?: ConnectionProfile[] } = {}) {
  const sink = opts.sink ?? new FakeArtifactSink();
  const added: string[][] = [];
  const ports = { artifacts: sink, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  let current: ProfileStore = { profiles: opts.profiles ?? EXISTING, activeProfileId: "p-a" };
  function Shell() {
    const [store, setStore] = useState<ProfileStore>(current);
    current = store;
    return (
      <TenantListSection
        appName={APP}
        profiles={store.profiles}
        onAddTenants={(tenants) => {
          added.push([...tenants]);
          setStore((s) => addTenantProfiles(s, tenants, (t) => `id-${t.slice(0, 8)}`));
        }}
      />
    );
  }
  render(
    <PortsProvider ports={ports} config={{ tenantId: TA } as unknown as AzureConfig}>
      <Shell />
    </PortsProvider>,
  );
  return { sink, added, store: () => current };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Tenant ids") as HTMLTextAreaElement;
}
function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
const ADD = "Add connections and prepare change requests";

describe("TenantListSection", () => {
  it("mounts with nothing to do: no download, the add button disabled, the (i) present", () => {
    const { sink, added } = mount();
    expect(textarea().value).toBe("");
    expect(button(ADD).disabled).toBe(true);
    expect(sink.saves).toEqual([]);
    expect(added).toEqual([]);
    expect(screen.getAllByRole("button", { name: "More information" }).length).toBeGreaterThan(0);
  });

  it("names every invalid entry and the collapsed duplicates, and counts the valid tenants", () => {
    mount();
    fireEvent.change(textarea(), { target: { value: `${TA}, contoso.onmicrosoft.com\n${TB},${TB.toUpperCase()}\nnope` } });
    expect(screen.getByText("Not a tenant id (ignored): contoso.onmicrosoft.com, nope")).toBeTruthy();
    expect(screen.getByText(`Listed more than once (counted once): ${TB}`)).toBeTruthy();
    expect(screen.getByText("2 tenants: 1 new, 1 already has a connection.")).toBeTruthy();
    expect(button(ADD).disabled).toBe(false);
  });

  it("keeps the add button disabled when nothing pasted is a tenant id", () => {
    mount();
    fireEvent.change(textarea(), { target: { value: "contoso.onmicrosoft.com" } });
    expect(button(ADD).disabled).toBe(true);
    expect(screen.getByText("Not a tenant id (ignored): contoso.onmicrosoft.com")).toBeTruthy();
  });

  it("hands the shell ONLY the new tenants, and leaves the existing connection exactly as it was", () => {
    const { added, store } = mount();
    fireEvent.change(textarea(), { target: { value: `${TB}\n${TA}\n${TC}` } });
    fireEvent.click(button(ADD));
    expect(added).toEqual([[TB, TC]]);
    expect(store().profiles[0]).toEqual(EXISTING[0]);
    expect(store().activeProfileId).toBe("p-a");
    expect(store().profiles.map((p) => p.name)).toEqual(["Contoso prod", "Tenant bbbbbbbb", "Tenant cccccccc"]);
    expect(screen.getByText("Added 2 connections. 1 tenant already had one and was left unchanged.")).toBeTruthy();
  });

  it("downloads exactly the core ticket per tenant, as Markdown, and the combined file", async () => {
    const { sink, store } = mount();
    fireEvent.change(textarea(), { target: { value: `${TB}, ${TA}` } });
    fireEvent.click(button(ADD));
    const expected = tenantChangeRequests(APP, tenantTicketTargets(store(), [TB, TA]));

    fireEvent.click(button(`Download the change request for ${TA}`));
    await waitFor(() => expect(sink.saves.length).toBe(1));
    expect(sink.saves[0]).toEqual({
      name: `app-registration-request-${TA}.md`,
      mimeType: "text/markdown",
      data: expected.perTenant[1]?.body,
    });
    // Tenant A's ticket carries the client id its existing connection holds.
    expect(String(sink.saves[0]?.data)).toContain("Service principal (client id): 11111111-1111-4111-8111-111111111111");

    fireEvent.click(button("Download all as one file"));
    await waitFor(() => expect(sink.saves.length).toBe(2));
    expect(sink.saves[1]).toEqual({
      name: "app-registration-requests-2-tenants.md",
      mimeType: "text/markdown",
      data: expected.combined?.body,
    });
    expect(screen.getByText("Download dispatched (app-registration-requests-2-tenants.md).")).toBeTruthy();
  });

  it("says which connection each tenant's ticket belongs to", () => {
    mount();
    fireEvent.change(textarea(), { target: { value: `${TA}\n${TB}` } });
    fireEvent.click(button(ADD));
    expect(screen.getByText(`${TA} - connection: Contoso prod`)).toBeTruthy();
    expect(screen.getByText(`${TB} - connection: Tenant bbbbbbbb`)).toBeTruthy();
  });

  it("offers the combined file as the requester's own copy, never as something to send", () => {
    mount();
    fireEvent.change(textarea(), { target: { value: `${TA}\n${TB}` } });
    fireEvent.click(button(ADD));
    expect(
      screen.getByText(
        "Your own copy: it holds every tenant's request, so never send it to a tenant. Send each tenant only its own file.",
      ),
    ).toBeTruthy();
  });

  it("a tenant two connections carry gets a request per connection, each labelled and downloadable", async () => {
    const two: ConnectionProfile[] = [
      { id: "p-1", name: "X lab", config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, subscriptionId: "sub-one" } },
      { id: "p-2", name: "X prod", config: { ...EMPTY_AZURE_CONFIG, tenantId: TA, subscriptionId: "sub-two" } },
    ];
    const { sink } = mount({ profiles: two });
    fireEvent.change(textarea(), { target: { value: TA } });
    fireEvent.click(button(ADD));
    expect(screen.getByText(`${TA} - connection: X lab`)).toBeTruthy();
    expect(screen.getByText(`${TA} - connection: X prod`)).toBeTruthy();
    fireEvent.click(button(`Download the change request for ${TA} (connection X prod)`));
    await waitFor(() => expect(sink.saves.length).toBe(1));
    expect(sink.saves[0]?.name).toBe(`app-registration-request-${TA}-2.md`);
    expect(String(sink.saves[0]?.data)).toContain("/subscriptions/sub-two");
    expect(String(sink.saves[0]?.data)).not.toContain("sub-one");
  });

  it("a tenant a domain-named connection might carry is UNKNOWN: said so, and not created", () => {
    const withDomain: ConnectionProfile[] = [
      ...EXISTING,
      { id: "p-d", name: "Fabrikam", config: { ...EMPTY_AZURE_CONFIG, tenantId: "fabrikam.onmicrosoft.com" } },
    ];
    const { added } = mount({ profiles: withDomain });
    fireEvent.change(textarea(), { target: { value: `${TA}\n${TB}` } });
    expect(screen.getByText("2 tenants: 0 new, 1 already has a connection, 1 unknown.")).toBeTruthy();
    expect(
      screen.getByText(
        `Cannot tell whether a connection already carries ${TB}: connection Fabrikam holds its tenant as ` +
          "'fabrikam.onmicrosoft.com', not a tenant id, so no connection is added for it. Set that connection's " +
          "tenant to its tenant id (a GUID) to decide.",
      ),
    ).toBeTruthy();
    fireEvent.click(button(ADD));
    expect(added).toEqual([]);
    expect(screen.getByText(`${TB} - unknown whether a connection already carries it`)).toBeTruthy();
  });

  it("a refused download is reported as failed, never as dispatched", async () => {
    mount({ sink: new RefusingSink() });
    fireEvent.change(textarea(), { target: { value: TB } });
    fireEvent.click(button(ADD));
    fireEvent.click(button(`Download the change request for ${TB}`));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(
      `Download failed (app-registration-request-${TB}.md) - download blocked`,
    ));
    expect(screen.queryByText(/Download dispatched/)).toBeNull();
  });
});
