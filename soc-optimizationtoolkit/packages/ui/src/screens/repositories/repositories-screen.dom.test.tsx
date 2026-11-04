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
import { patPolicyFor } from "@soc/core";
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
      // A complete section wears the check (its number is in the label), so
      // read the accessible label rather than the glyph.
      head.querySelector(".numbered-section-badge")?.getAttribute("aria-label") ?? "",
      head.querySelector(".numbered-section-title")?.textContent?.trim() ?? "",
    ]);
    expect(heads).toEqual([
      ["Section 1, complete", "GitHub personal access token"],
      ["Section 2", "Sentinel content"],
      ["Section 3", "Schema tables (KQL validation)"],
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

/**
 * A REFUSED PAT STATUS READ (DBT-159).
 *
 * Since DBT-145 the KV store throws on a non-encrypted 403, and the mount's
 * status read swallowed the throw and left the form in its no-PAT default. On
 * the hosted app that rendered "A token is required" and "Not connected" - a
 * confident NONE about a token that may well be saved, with the actual reason
 * thrown away. Not knowing is a third state, and it carries its reason.
 */
describe("Repositories screen - a refused PAT status read (DBT-159)", () => {
  async function mountRefused(): Promise<HTMLElement> {
    const { ports } = makePorts();
    (ports.githubPat as unknown as { status: () => Promise<never> }).status =
      vi.fn(async () => {
        throw new Error("KV read refused (403)");
      });
    return mount(ports);
  }

  it("says the token status is UNKNOWN, with the reason", async () => {
    const container = await mountRefused();
    const unknown = container.querySelectorAll(".repositories-pat-unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].textContent).toContain("KV read refused (403)");
    expect(container.querySelector(".reachability-label")?.textContent).toBe(
      "Token status unknown",
    );
  });

  it("never reads as 'no token'", async () => {
    const text = (await mountRefused()).textContent ?? "";
    expect(countOccurrences(text, "A token is required on this hosted app")).toBe(0);
    expect(countOccurrences(text, "Not connected")).toBe(0);
    expect(countOccurrences(text, "GitHub token saved")).toBe(0);
  });

  it("still offers to CLEAR a token that may be stored (DBT-175)", async () => {
    // Unknown is not none: with Clear hasPat-only, an operator whose status
    // read was refused had no way to remove a token this screen could not see.
    const { ports } = makePorts();
    const githubPat = ports.githubPat as unknown as {
      status: () => Promise<never>;
      clear: ReturnType<typeof vi.fn>;
    };
    githubPat.status = vi.fn(async () => {
      throw new Error("KV read refused (403)");
    });
    githubPat.clear = vi.fn(async () => undefined);
    await mount(ports);
    const clears = screen.getAllByRole("button", { name: "Clear token" });
    expect(clears).toHaveLength(1);
    await act(async () => {
      fireEvent.click(clears[0]);
    });
    expect(githubPat.clear).toHaveBeenCalledTimes(1);
  });
});

describe("Repositories screen - onTokenStatusChange (DBT-246)", () => {
  async function mountWith(
    githubPat: {
      status: ReturnType<typeof vi.fn>;
      validateAndStore: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    },
    cb: (present: boolean) => void,
  ) {
    const ports = {
      githubPat,
      content: { getCommitSha: vi.fn(), listSolutions: vi.fn(async () => []) },
    } as unknown as UiPorts;
    await act(async () => {
      render(
        <PortsProvider ports={ports} config={CONFIG}>
          <RepositoriesScreen platform="cloud" onTokenStatusChange={cb} />
        </PortsProvider>,
      );
    });
  }

  async function typeAndSave() {
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "github_pat_abcdefghijklmnop" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save|Validate|Store|Connect|Replace token/i }));
    });
  }

  it("fires true after a save and false after a clear", async () => {
    const cb = vi.fn();
    await mountWith(
      {
        status: vi.fn(async () => ({ hasPat: false })),
        validateAndStore: vi.fn(async () => ({ hasPat: true, login: "octo" })),
        clear: vi.fn(async () => undefined),
      },
      cb,
    );
    expect(cb).not.toHaveBeenCalled();
    await typeAndSave();
    expect(cb.mock.calls).toEqual([[true]]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
    });
    expect(cb.mock.calls).toEqual([[true], [false]]);
  });

  it("does not fire when the port rejects (status, save, clear) or the token is invalid", async () => {
    const cb = vi.fn();
    await mountWith(
      {
        status: vi.fn(async () => {
          throw new Error("refused");
        }),
        validateAndStore: vi.fn(async () => {
          throw new Error("boom");
        }),
        clear: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
      cb,
    );
    await typeAndSave();
    expect(cb).not.toHaveBeenCalled();
  });

  // Re-pinned for I7: a rejected save now re-reads the stored status and
  // reports it, because the adapter stores before validating and rolls back on
  // rejection. With no token before or after, that report is false.
  it("reports the re-read status when GitHub rejects the token (hasPat false)", async () => {
    const cb = vi.fn();
    const status = vi.fn(async () => ({ hasPat: false }));
    await mountWith(
      {
        status,
        validateAndStore: vi.fn(async () => ({ hasPat: false, error: "bad" })),
        clear: vi.fn(),
      },
      cb,
    );
    await typeAndSave();
    expect(status).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls).toEqual([[false]]);
  });

  it("reports false when a rejected REPLACEMENT rolled the previous token back (I7)", async () => {
    const cb = vi.fn();
    const status = vi
      .fn()
      .mockResolvedValueOnce({ hasPat: true, login: "octo" })
      .mockResolvedValue({ hasPat: false });
    await mountWith(
      {
        status,
        validateAndStore: vi.fn(async () => ({ hasPat: false, error: "HTTP 401" })),
        clear: vi.fn(),
      },
      cb,
    );
    await typeAndSave();
    expect(cb.mock.calls).toEqual([[false]]);
    // The badge follows the re-read status too, not the stale "saved".
    expect(screen.queryByText(/GitHub token saved/)).toBeNull();
  });

  it("reports false when the validation call failed in transport and rolled back (I7)", async () => {
    const cb = vi.fn();
    const status = vi
      .fn()
      .mockResolvedValueOnce({ hasPat: true, login: "octo" })
      .mockResolvedValue({ hasPat: false });
    await mountWith(
      {
        status,
        validateAndStore: vi.fn(async () => {
          throw new Error("network down");
        }),
        clear: vi.fn(),
      },
      cb,
    );
    await typeAndSave();
    expect(cb.mock.calls).toEqual([[false]]);
  });

  it("never reports false for a rejection that returned before storing (I7)", async () => {
    const cb = vi.fn();
    // A format rejection stores nothing, so the previous token is still there.
    const status = vi.fn(async () => ({ hasPat: true, login: "octo" }));
    await mountWith(
      {
        status,
        validateAndStore: vi.fn(async () => ({ hasPat: false, error: "format" })),
        clear: vi.fn(),
      },
      cb,
    );
    await typeAndSave();
    expect(cb.mock.calls).not.toContainEqual([false]);
    expect(screen.getByText(/GitHub token saved/)).toBeTruthy();
  });

  it("does not fire when clear rejects", async () => {
    const cb = vi.fn();
    await mountWith(
      {
        status: vi.fn(async () => ({ hasPat: true, login: "octo" })),
        validateAndStore: vi.fn(),
        clear: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
      cb,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

/**
 * ONE TOKEN-SCOPE STATEMENT (DBT-245). The screen used to say a classic token
 * needs only public_repo while pat-policy said it needs no scopes at all.
 */
describe("Repositories screen - token scope (DBT-245)", () => {
  it("never names public_repo as a requirement", async () => {
    const container = await mount(makePorts().ports);
    fireEvent.click(
      screen.getByRole("button", { name: /instructions for creating a token/i }),
    );
    expect(container.textContent ?? "").not.toContain("public_repo");
  });

  it("states the shared scope guidance exactly once", async () => {
    const container = await mount(makePorts().ports);
    fireEvent.click(
      screen.getByRole("button", { name: /instructions for creating a token/i }),
    );
    const text = container.textContent ?? "";
    expect(countOccurrences(text, "no scopes are required")).toBe(1);
  });
});

/**
 * L2 (live check 2026-11-02): the rationale and scope paragraphs rendered on
 * screen. They move VERBATIM behind one InfoTip; one requirement line stays.
 */
describe("Repositories screen - the why sits behind one InfoTip (L2)", () => {
  it("keeps one requirement line on screen and moves rationale and scope guidance into the tip verbatim", async () => {
    const container = await mount(makePorts().ports);
    const policy = patPolicyFor("cloud");
    const section = container.querySelector(".numbered-section") as HTMLElement;
    const tips = Array.from(section.querySelectorAll(".info-tip-pop")).map(
      (n) => n.textContent ?? "",
    );
    const whyTip = tips.find((t) => t.includes(policy.rationale));
    expect(whyTip).toBeDefined();
    expect(whyTip).toContain(policy.scopeGuidance);

    const onScreen = section.cloneNode(true) as HTMLElement;
    onScreen.querySelectorAll(".info-tip").forEach((n) => n.remove());
    const visible = onScreen.textContent ?? "";
    expect(visible).not.toContain(policy.rationale);
    expect(visible).not.toContain(policy.scopeGuidance);
    expect(visible).toContain(
      "A GitHub token is required to browse solutions and fetch content.",
    );
  });
});
