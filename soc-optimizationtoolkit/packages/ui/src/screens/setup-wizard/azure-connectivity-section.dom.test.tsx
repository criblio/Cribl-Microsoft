// @vitest-environment happy-dom
/**
 * DOM pins for the Azure connectivity section (setup-pages plan, Option A).
 * The section is a pure view over AzureConfig; a stateful host feeds each
 * onChange back in so "the summary line updates" is observable.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { EMPTY_AZURE_CONFIG, checklistEntries } from "@soc/core";
import type { AzureConfig } from "@soc/core";
import { AzureConnectivitySection } from "./azure-connectivity-section";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureConnectSection } from "./azure-connect-section";

afterEach(cleanup);

function callArg(fn: { mock: { calls: unknown[][] } }, i: number): AzureConfig {
  return fn.mock.calls[i]?.[0] as AzureConfig;
}

const PARTIAL: AzureConfig = {
  ...EMPTY_AZURE_CONFIG,
  connectivity: "partial",
  allowedPermissions: ["Reader"],
};

function Host(props: {
  initial: AzureConfig;
  onChange?: (c: AzureConfig) => void;
  storedIdentity?: boolean;
  onClearIdentity?: () => void;
}) {
  const [config, setConfig] = useState(props.initial);
  return (
    <AzureConnectivitySection
      config={config}
      onChange={(next) => {
        props.onChange?.(next);
        setConfig(next);
      }}
      storedIdentity={props.storedIdentity ?? false}
      onClearIdentity={props.onClearIdentity ?? vi.fn()}
    />
  );
}

describe("AzureConnectivitySection", () => {
  it("renders a radiogroup of exactly three radios", () => {
    render(<Host initial={PARTIAL} />);
    const group = screen.getByRole("radiogroup", {
      name: "How will this app work with Azure?",
    });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "Fully Connected",
      "Partially Connected",
      "Disconnected",
    ]);
  });

  it("partial shows checked Read-only access, the Recommended badge and its one line", () => {
    render(<Host initial={PARTIAL} />);
    expect(
      (screen.getByLabelText("Read-only access") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(
      screen.getByText(
        "Fills the workspace, table and DCR pickers and the inventory views.",
      ),
    ).toBeTruthy();
  });

  it("lists one checkbox per other entry with an InfoTip carrying justification and withoutIt", () => {
    const { container } = render(<Host initial={PARTIAL} />);
    expect(screen.getByText("Also allow the app to")).toBeTruthy();
    const { others } = checklistEntries();
    expect(others.length).toBeGreaterThan(0);
    const rows = container.querySelectorAll(".connectivity-row");
    expect(rows.length).toBe(others.length);
    others.forEach((entry, i) => {
      const row = rows[i] as HTMLElement;
      expect(within(row).getByLabelText(entry.feature)).toBeTruthy();
      const tip = row.querySelector(".info-tip-pop")?.textContent ?? "";
      expect(tip).toContain(entry.justification);
      expect(tip).toContain(entry.withoutIt);
    });
  });

  it("ticking Deploy Data Collection Rules allows Monitoring Contributor and updates the summary", () => {
    const onChange = vi.fn();
    render(<Host initial={PARTIAL} onChange={onChange} />);
    expect(screen.getByText(/Requesting: 1 role - Reader/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Deploy Data Collection Rules"));
    const next = onChange.mock.calls[0]?.[0] as AzureConfig;
    expect(next.allowedPermissions).toEqual([
      "Reader",
      "Monitoring Contributor",
    ]);
    expect(
      screen.getByText(/Requesting: 2 roles - Reader, Monitoring Contributor/),
    ).toBeTruthy();
  });

  it("keeps checklist order when read-only is ticked back on", () => {
    const onChange = vi.fn();
    render(
      <Host
        initial={{ ...PARTIAL, allowedPermissions: ["Monitoring Contributor"] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("Read-only access"));
    expect(callArg(onChange, 0).allowedPermissions).toEqual([
      "Reader",
      "Monitoring Contributor",
    ]);
  });

  it("Full and Disconnected keep allowedPermissions so Partial round-trips", () => {
    const onChange = vi.fn();
    const keep = {
      ...PARTIAL,
      allowedPermissions: ["Reader", "Monitoring Contributor"],
    };
    render(<Host initial={keep} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Fully Connected"));
    fireEvent.click(screen.getByLabelText("Disconnected"));
    expect(onChange).toHaveBeenCalledTimes(2);
    for (const call of onChange.mock.calls) {
      expect((call[0] as AzureConfig).allowedPermissions).toEqual(
        keep.allowedPermissions,
      );
    }
    expect(callArg(onChange, 0).connectivity).toBe("full");
  });

  it("choosing Partial from a lab path switches to existing and says so", () => {
    const onChange = vi.fn();
    render(
      <Host
        initial={{
          ...EMPTY_AZURE_CONFIG,
          connectivity: "full",
          setupPath: "lab-new-rg",
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("Partially Connected"));
    const next = onChange.mock.calls[0]?.[0] as AzureConfig;
    expect(next.setupPath).toBe("existing");
    expect(next.connectivity).toBe("partial");
    expect(
      screen.getByText(
        "Lab setups need Fully Connected; switched to existing resources.",
      ),
    ).toBeTruthy();
  });

  it("disconnected with a stored identity offers Clear and Use Partially Connected", () => {
    const onClear = vi.fn();
    const onChange = vi.fn();
    render(
      <Host
        initial={{ ...EMPTY_AZURE_CONFIG, connectivity: "disconnected" }}
        storedIdentity
        onClearIdentity={onClear}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear stored identity" }),
    );
    expect(onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Use Partially Connected" }),
    );
    const next = onChange.mock.calls[0]?.[0] as AzureConfig;
    expect(next.connectivity).toBe("partial");
  });

  it("disconnected without a stored identity shows only the ARM-template line", () => {
    render(
      <Host
        initial={{ ...EMPTY_AZURE_CONFIG, connectivity: "disconnected" }}
      />,
    );
    expect(
      screen.getByText(
        "This app will produce ARM templates and deployment guides to hand to someone who can run them.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  describe("copy gate: exact sentence count outside InfoTips", () => {
    /** Sentences end in . ! or ? before whitespace, the end or a capital (adjacent blocks); decimals do not count. */
    function sentenceCount(container: HTMLElement): number {
      const copy = container.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".info-tip").forEach((n) => n.remove());
      const text = copy.textContent ?? "";
      return (text.match(/[.!?](?=\s|$|[A-Z])/g) ?? []).length;
    }

    it("partial default has 1", () => {
      const { container } = render(<Host initial={PARTIAL} />);
      expect(sentenceCount(container)).toBe(1);
    });

    it("full has 0", () => {
      const { container } = render(
        <Host initial={{ ...EMPTY_AZURE_CONFIG, connectivity: "full" }} />,
      );
      expect(sentenceCount(container)).toBe(0);
    });

    it("disconnected without a stored identity has 1", () => {
      const { container } = render(
        <Host
          initial={{ ...EMPTY_AZURE_CONFIG, connectivity: "disconnected" }}
        />,
      );
      expect(sentenceCount(container)).toBe(1);
    });

    it("disconnected with a stored identity has 1", () => {
      const { container } = render(
        <Host
          initial={{ ...EMPTY_AZURE_CONFIG, connectivity: "disconnected" }}
          storedIdentity
        />,
      );
      expect(sentenceCount(container)).toBe(1);
    });

    it("partial with the lab-switch notice has 2", () => {
      const { container } = render(
        <Host
          initial={{
            ...EMPTY_AZURE_CONFIG,
            connectivity: "full",
            setupPath: "lab-new-rg",
          }}
        />,
      );
      fireEvent.click(screen.getByLabelText("Partially Connected"));
      expect(sentenceCount(container)).toBe(2);
    });
  });

  it("gives every checklist InfoTip a distinct accessible name", () => {
    const { container } = render(<Host initial={PARTIAL} />);
    const names = Array.from(container.querySelectorAll(".info-tip-icon")).map(
      (n) => n.getAttribute("aria-label"),
    );
    expect(names.length).toBe(checklistEntries().others.length + 1);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("More information");
  });

  it("marks the lab-switch notice as a status", () => {
    render(
      <Host
        initial={{
          ...EMPTY_AZURE_CONFIG,
          connectivity: "full",
          setupPath: "lab-new-rg",
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Partially Connected"));
    expect(screen.getByRole("status").textContent).toBe(
      "Lab setups need Fully Connected; switched to existing resources.",
    );
  });
});

describe("AzureConnectSection by connectivity", () => {
  function connect(connectivity: AzureConfig["connectivity"]) {
    const config = { ...EMPTY_AZURE_CONFIG, connectivity };
    return render(
      <PortsProvider ports={{} as unknown as UiPorts} config={config}>
        <AzureConnectSection
          tenantId=""
          onTenantIdChange={vi.fn()}
          clientId=""
          onClientIdChange={vi.fn()}
          setupPath="existing"
          onSetupPathChange={vi.fn()}
          secretLive={false}
          ctx={{ appName: "test", config }}
          onConnect={vi.fn()}
          storageNote="note"
        />
      </PortsProvider>,
    );
  }

  it("renders nothing when disconnected", () => {
    expect(connect("disconnected").container.textContent).toBe("");
  });

  it("shows the setup-path radios under full only", () => {
    expect(
      connect("full").container.querySelectorAll('input[name="setup-path"]')
        .length,
    ).toBe(3);
    cleanup();
    expect(
      connect("partial").container.querySelectorAll('input[name="setup-path"]')
        .length,
    ).toBe(0);
  });
});
