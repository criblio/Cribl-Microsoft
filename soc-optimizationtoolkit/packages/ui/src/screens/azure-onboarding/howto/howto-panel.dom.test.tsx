// @vitest-environment happy-dom
/**
 * Pins for the How-to components (AZR-31): the chooser with its Automate |
 * How-to toggle (ChoosePanel, its own section on the screen), the plan values
 * form, the step list with its done ticks, and the step dialog (HowToPanel). The decisions are pinned in howto-state.test.ts; these pin
 * that the components show them and report clicks as intents.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  API_VERSION_COPY_ALLOWANCE,
  API_VERSION_MASK,
  PLAN_VALUE_KEYS,
  emptyProgress,
  encodeProgress,
  withEventHubSource,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
} from "@soc/core";
import type { CoverageSelection, OnboardingProgress } from "@soc/core";
import { describeViolations, findHistoryInCopy } from "../../../components/copy-rules";
import type { CopyEntry } from "../../../components/copy-rules";
import {
  AUTOMATE_LOCKED_REASON,
  EVENT_HUB_FOLLOWS_NOTE,
  EVENT_HUB_OWN_NOTE,
  FOLLOW_SECTION1_LABEL,
  USE_OWN_EVENT_HUB_LABEL,
  chooserRows,
  progressLoadStateFrom,
  stepDialogView,
  stepRows,
  toggleTick,
} from "./howto-state";
import type { ProgressLoadState } from "./howto-state";
import { HowToPanel, PROGRESS_UNAVAILABLE_TEXT } from "./howto-panel";
import type { HowToPanelProps } from "./howto-panel";
import { ChoosePanel } from "./choose-panel";
import type { ChoosePanelProps } from "./choose-panel";
import { CREDENTIAL_REFUSED_NOTE, UNAPPLIED_NOTE } from "./plan-values-form";
import { automateUnavailableNote, howtoUnavailableNote, selectionUnknownNote } from "./source-chooser";

const SELECTION_UNKNOWN_NOTE = selectionUnknownNote("not-read");
import { COPY_DONE, COPY_UNAVAILABLE } from "./step-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SELECTION: CoverageSelection = { mode: "Centralized", enabled: [], subSelections: {} };

/** A complete section 1 pick (AZR-102). */
const PICKED = {
  eventHubSubscriptionId: "sub-p",
  eventHubResourceGroup: "rg-p",
  namespace: "picked-ns",
  hubName: "picked-hub",
  sendRule: "send-p",
};

const VALUES = {
  ...emptyProgress().planValues,
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  namespace: "ns1",
  region: "eastus",
};

function ready(progress: OnboardingProgress): ProgressLoadState {
  return progressLoadStateFrom({ kind: "value", value: JSON.parse(encodeProgress(progress)) });
}

function manualEntra(): OnboardingProgress {
  return withPlanValues(
    withSourceChosen(withSourceMode(emptyProgress(), "entraId", "manual"), "entraId", true),
    VALUES,
  );
}

function renderPanel(overrides: Partial<HowToPanelProps> = {}) {
  const props: HowToPanelProps = {
    load: ready(manualEntra()),
    selection: SELECTION,
    onToggleTick: vi.fn(),
    onApplyPlanValues: vi.fn(),
    ...overrides,
  };
  const view = render(<HowToPanel {...props} />);
  return { ...view, props };
}

function renderChooser(overrides: Partial<ChoosePanelProps> = {}) {
  const props: ChoosePanelProps = {
    load: ready(manualEntra()),
    selection: SELECTION,
    onSetMode: vi.fn(),
    onSetChosen: vi.fn(),
    ...overrides,
  };
  const view = render(<ChoosePanel {...props} />);
  return { ...view, props };
}

function stepRow(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`.azo-step-row[data-step="${id}"]`);
  if (row === null) throw new Error(`no step row ${id}`);
  return row;
}

function sourceRow(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`.azo-howto-row[data-source="${id}"]`);
  if (row === null) throw new Error(`no source row ${id}`);
  return row;
}

describe("done checkbox", () => {
  it("calls onToggleTick with the step id and the new state", () => {
    const { container, props } = renderPanel();
    const box = within(stepRow(container, "eh-namespace")).getByRole("checkbox");
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    expect(props.onToggleTick).toHaveBeenCalledTimes(1);
    expect(props.onToggleTick).toHaveBeenCalledWith("eh-namespace", true);
  });

  it("a ticked step shows checked; unticking reports false", () => {
    const ticked = toggleTick(ready(manualEntra()), "eh-namespace", true)!;
    const { container, props } = renderPanel({ load: ready(ticked) });
    const box = within(stepRow(container, "eh-namespace")).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(props.onToggleTick).toHaveBeenCalledWith("eh-namespace", false);
  });

  it("a screen-blocked panel disables every checkbox and shows the reason", () => {
    const reason = "Saving your progress.";
    const { container, props } = renderPanel({ writesBlockedReason: reason });
    const boxes = container.querySelectorAll<HTMLInputElement>(".azo-step-row input[type=checkbox]");
    expect(boxes.length).toBe(stepRows(manualEntra(), SELECTION, { canWrite: true }).length);
    for (const b of boxes) expect(b.disabled).toBe(true);
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    fireEvent.click(boxes[0]);
    expect(props.onToggleTick).not.toHaveBeenCalled();
  });

  it("a failed progress load shows the banner in the chooser and offers no control anywhere", () => {
    const failed = progressLoadStateFrom({ kind: "unknown", reason: "HTTP 403" });
    const chooser = renderChooser({ load: failed });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("HTTP 403");
    expect(alert.textContent).toContain("turned off");
    // No chooser drawn from an empty progress that would claim "nothing
    // chosen" about a document that may exist.
    expect(chooser.container.querySelectorAll("input").length).toBe(0);
    cleanup();
    // The steps say they cannot be shown, and point at the chooser.
    const { container } = renderPanel({ load: failed });
    expect(container.textContent).toContain(PROGRESS_UNAVAILABLE_TEXT);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelector(".azo-step-row")).toBeNull();
  });
});

describe("step dialog", () => {
  it("opens with the computed CLI, closes on Escape, and returns focus", () => {
    const { container } = renderPanel();
    const button = within(stepRow(container, "eh-namespace")).getByRole("button", { name: /Instructions/ });
    button.focus();
    fireEvent.click(button);
    const dialog = container.querySelector("dialog.azo-step-dialog") as HTMLDialogElement;
    expect(dialog).not.toBeNull();
    expect(dialog.open).toBe(true);
    const expected = stepDialogView("eh-namespace", manualEntra(), SELECTION, { canWrite: true })!;
    const cli = dialog.querySelector(".azo-step-cli")!.textContent;
    expect(cli).toBe(expected.rendered.cli);
    expect(cli).toContain("--name ns1");
    expect(cli).toContain("--location eastus");
    // Focus moved into the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(container.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("keeps Tab inside the dialog", () => {
    const { container } = renderPanel();
    fireEvent.click(within(stepRow(container, "eh-namespace")).getByRole("button", { name: /Instructions/ }));
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1].focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("shows placeholders for unset values and Mark as done ticks the step", () => {
    const blank = withSourceChosen(withSourceMode(emptyProgress(), "entraId", "manual"), "entraId", true);
    const onToggleTick = vi.fn();
    const { container } = renderPanel({ load: ready(blank), onToggleTick });
    fireEvent.click(within(stepRow(container, "eh-namespace")).getByRole("button", { name: /Instructions/ }));
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.querySelector(".azo-step-cli")!.textContent).toContain("<namespace>");
    expect(dialog.textContent).not.toContain("undefined");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Mark as done" }));
    expect(onToggleTick).toHaveBeenCalledWith("eh-namespace", true);
  });

  it("Copy writes the CLI when the clipboard exists, and says so when it does not", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container } = renderPanel();
    fireEvent.click(within(stepRow(container, "eh-namespace")).getByRole("button", { name: /Instructions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(
      stepDialogView("eh-namespace", manualEntra(), SELECTION, { canWrite: true })!.rendered.cli,
    );
    expect(await screen.findByText(COPY_DONE)).toBeTruthy();

    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByText(COPY_UNAVAILABLE)).toBeTruthy();
  });
});

describe("chooser and mode toggle", () => {
  it("a locked toggle is disabled and its reason is visible text", () => {
    const { container } = renderChooser();
    const entra = sourceRow(container, "xdrStreaming");
    const automate = within(entra).getByRole("radio", { name: /Automate/ }) as HTMLInputElement;
    expect(automate.disabled).toBe(true);
    expect(entra.textContent).toContain(AUTOMATE_LOCKED_REASON);
    // The automatable source is not locked and says nothing of the kind.
    const defender = sourceRow(container, "defenderExport");
    expect((within(defender).getByRole("radio", { name: /Automate/ }) as HTMLInputElement).disabled).toBe(false);
    expect(defender.textContent).not.toContain(AUTOMATE_LOCKED_REASON);
  });

  it("reports choose and mode clicks as intents", () => {
    const { container, props } = renderChooser();
    fireEvent.click(within(sourceRow(container, "entraId")).getByRole("checkbox"));
    expect(props.onSetChosen).toHaveBeenCalledWith("entraId", false);
    fireEvent.click(within(sourceRow(container, "defenderExport")).getByRole("radio", { name: /How-to/ }));
    expect(props.onSetMode).toHaveBeenCalledWith("defenderExport", "manual");
  });

  it("an unread selection makes an Automated row's choice unknown, not unchecked", () => {
    const { container, props } = renderChooser({ selection: null });
    const defender = sourceRow(container, "defenderExport");
    expect(defender.dataset.mode).toBe("automate");
    const box = within(defender).getByRole("checkbox") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.indeterminate).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(defender.dataset.chosen).toBe("unknown");
    expect(defender.textContent).toContain(SELECTION_UNKNOWN_NOTE);
    // Its How-to option is off too: moving would write the unknown choice as "not chosen".
    const howto = within(defender).getByRole("radio", { name: /How-to/ }) as HTMLInputElement;
    expect(howto.disabled).toBe(true);
    expect(defender.textContent).toContain(howtoUnavailableNote("not-read"));
    fireEvent.click(howto);
    expect(props.onSetMode).not.toHaveBeenCalled();
    fireEvent.click(box);
    expect(props.onSetChosen).not.toHaveBeenCalled();
    // A How-to row reads its choice from progress, which did load.
    const entra = sourceRow(container, "entraId");
    const entraBox = within(entra).getByRole("checkbox") as HTMLInputElement;
    expect(entraBox.disabled).toBe(false);
    expect(entraBox.indeterminate).toBe(false);
    expect(entra.textContent).not.toContain(SELECTION_UNKNOWN_NOTE);
  });

  it("an unread selection disables a How-to row's Automate option and says why", () => {
    const manualLog = withSourceMode(manualEntra(), "activityLog", "manual");
    const { container, props } = renderChooser({ load: ready(manualLog), selection: null, selectionCause: "loading" });
    const log = sourceRow(container, "activityLog");
    const automate = within(log).getByRole("radio", { name: /Automate/ }) as HTMLInputElement;
    expect(automate.disabled).toBe(true);
    expect(log.textContent).toContain(automateUnavailableNote("loading"));
    expect(automateUnavailableNote("loading")).toBe("Automate is not available while the saved selection is still loading.");
    fireEvent.click(automate);
    expect(props.onSetMode).not.toHaveBeenCalled();
    // The Automated row's unknown note uses the method row's words for the same cause.
    expect(sourceRow(container, "defenderExport").textContent).toContain(
      "Choice not loaded yet - the saved selection is still loading.",
    );
    // With the selection loaded the option is back.
    cleanup();
    const again = renderChooser({ load: ready(manualLog) });
    expect((within(sourceRow(again.container, "activityLog")).getByRole("radio", { name: /Automate/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it("a loaded selection shows no unknown note", () => {
    const { container } = renderChooser();
    const defender = sourceRow(container, "defenderExport");
    expect((within(defender).getByRole("checkbox") as HTMLInputElement).indeterminate).toBe(false);
    expect(defender.textContent).not.toContain(SELECTION_UNKNOWN_NOTE);
  });
});

describe("write-blocked panel", () => {
  it("disables every chooser control and reports no click", () => {
    const { container, props } = renderChooser({ writesBlockedReason: "Saving your progress." });
    const chooserInputs = container.querySelectorAll<HTMLInputElement>(".azo-howto-chooser input");
    expect(chooserInputs.length).toBe(chooserRows(manualEntra(), SELECTION).length * 3);
    for (const i of chooserInputs) expect(i.disabled).toBe(true);
    expect(screen.getByText("Saving your progress.")).toBeTruthy();
    fireEvent.click(within(sourceRow(container, "entraId")).getByRole("checkbox"));
    fireEvent.click(within(sourceRow(container, "defenderExport")).getByRole("checkbox"));
    fireEvent.click(within(sourceRow(container, "defenderExport")).getByRole("radio", { name: /How-to/ }));
    fireEvent.click(within(sourceRow(container, "entraId")).getByRole("radio", { name: /How-to/ }));
    expect(props.onSetChosen).not.toHaveBeenCalled();
    expect(props.onSetMode).not.toHaveBeenCalled();
  });

  it("disables every plan control", () => {
    const { container } = renderPanel({
      writesBlockedReason: "Saving your progress.",
      pickedEventHub: PICKED,
      onChooseEventHubSource: vi.fn(),
    });
    // The chooser is not part of the How-to panel any more.
    expect(container.querySelector(".azo-howto-chooser")).toBeNull();
    const planInputs = container.querySelectorAll<HTMLInputElement>(".azo-plan-form input");
    expect(planInputs.length).toBe(PLAN_VALUE_KEYS.length);
    for (const i of planInputs) expect(i.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: FOLLOW_SECTION1_LABEL }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("plan values form", () => {
  it("edits are a draft: nothing is reported until Apply", () => {
    const { props } = renderPanel();
    const field = screen.getByRole("textbox", { name: "Event Hub namespace" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "ns9" } });
    expect(props.onApplyPlanValues).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApplyPlanValues).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onApplyPlanValues).mock.calls[0][0]).toEqual({ ...VALUES, namespace: "ns9" });
  });

  it("names a credential-shaped value instead of dropping it silently", () => {
    renderPanel();
    const field = screen.getByRole("textbox", { name: "Event Hub namespace" });
    fireEvent.change(field, { target: { value: "Endpoint=sb://x/;SharedAccessKey=abc" } });
    expect(screen.getByText(CREDENTIAL_REFUSED_NOTE)).toBeTruthy();
  });

  it("Apply empties a pasted connection string and leaves no unapplied note", () => {
    const { props } = renderPanel();
    const field = screen.getByRole("textbox", { name: "Event Hub name" }) as HTMLInputElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "Endpoint=sb://x/;SharedAccessKeyName=r;SharedAccessKey=abc" } });
    expect(screen.getByText(UNAPPLIED_NOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(field.value).toBe("");
    expect(screen.queryByText(UNAPPLIED_NOTE)).toBeNull();
    expect(screen.queryByText(CREDENTIAL_REFUSED_NOTE)).toBeNull();
    // Nothing changed after sanitizing, so nothing is reported.
    expect(props.onApplyPlanValues).not.toHaveBeenCalled();
  });

  it("Apply with a credential beside a real edit reports the edit only", () => {
    const { props } = renderPanel();
    fireEvent.change(screen.getByRole("textbox", { name: "Event Hub name" }), {
      target: { value: "Endpoint=sb://x/;SharedAccessKeyName=r;SharedAccessKey=abc" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Event Hub namespace" }), { target: { value: "ns9" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApplyPlanValues).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(props.onApplyPlanValues).mock.calls[0][0];
    expect(sent).toEqual({ ...VALUES, namespace: "ns9" });
    expect(JSON.stringify(sent)).not.toContain("SharedAccessKey");
  });

});

// AZR-102: one Event Hub. The plan's Event Hub names follow the section 1
// picker (read-only here) unless the operator keeps their own.
describe("plan values form - the Event Hub names", () => {
  const EH_FIELDS = ["Event Hub subscription ID", "Event Hub resource group", "Event Hub namespace", "Event Hub name", "Send rule"];

  function following(): OnboardingProgress {
    return withEventHubSource(withPlanValues(manualEntra(), { ...VALUES, ...PICKED }), "section1");
  }

  it("while they follow section 1, exactly the five Event Hub fields are read-only and show the stored names", () => {
    const onChoose = vi.fn();
    const { container } = renderPanel({ load: ready(following()), pickedEventHub: PICKED, onChooseEventHubSource: onChoose });
    const locked = Array.from(container.querySelectorAll<HTMLInputElement>(".azo-plan-form input[data-locked]"));
    expect(locked.map((i) => i.getAttribute("aria-label"))).toEqual(EH_FIELDS);
    for (const i of locked) expect(i.readOnly).toBe(true);
    expect((screen.getByRole("textbox", { name: "Event Hub name" }) as HTMLInputElement).value).toBe("picked-hub");
    expect((screen.getByRole("textbox", { name: "Region" }) as HTMLInputElement).readOnly).toBe(false);
    // The shared subscription and resource group stay the operator's.
    expect((screen.getByRole("textbox", { name: "Subscription ID" }) as HTMLInputElement).readOnly).toBe(false);
    expect((screen.getByRole("textbox", { name: "Resource group" }) as HTMLInputElement).value).toBe("rg-1");
    expect(screen.getByTestId("azo-plan-eventhub").textContent).toBe(EVENT_HUB_FOLLOWS_NOTE + USE_OWN_EVENT_HUB_LABEL);
    expect(screen.queryByRole("button", { name: FOLLOW_SECTION1_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: USE_OWN_EVENT_HUB_LABEL }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("own");
  });

  it("a typed change to a locked field is ignored, so Apply has nothing to send", () => {
    const { props } = renderPanel({ load: ready(following()), pickedEventHub: PICKED });
    fireEvent.change(screen.getByRole("textbox", { name: "Event Hub name" }), { target: { value: "typed" } });
    expect((screen.getByRole("textbox", { name: "Event Hub name" }) as HTMLInputElement).value).toBe("picked-hub");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    expect(props.onApplyPlanValues).not.toHaveBeenCalled();
  });

  it("the operator's own names are editable, and a different section 1 hub is named as a warning", () => {
    const onChoose = vi.fn();
    // manualEntra names ns1 and has no eventHubSource: a plan saved before
    // AZR-102, kept as the operator's own.
    renderPanel({ pickedEventHub: PICKED, onChooseEventHubSource: onChoose });
    expect((screen.getByRole("textbox", { name: "Event Hub namespace" }) as HTMLInputElement).readOnly).toBe(false);
    const block = screen.getByTestId("azo-plan-eventhub");
    expect(block.dataset.follows).toBe("own");
    expect(block.textContent).toContain(EVENT_HUB_OWN_NOTE);
    expect(block.textContent).toContain(
      "Section 1 and these names differ (Event Hub subscription ID, Event Hub resource group, Event Hub namespace, Event Hub name, Send rule): a deploy on this page writes to section 1's Event Hub, picked-ns/picked-hub, while the How-to steps, Validate and the Cribl source use ns1/(no hub).",
    );
    fireEvent.click(screen.getByRole("button", { name: FOLLOW_SECTION1_LABEL }));
    expect(onChoose).toHaveBeenCalledWith("section1");
  });

  it("a stored change (section 1 picked another hub) keeps an edit in progress in another field", () => {
    const { rerender, props } = renderPanel({ load: ready(following()), pickedEventHub: PICKED });
    fireEvent.change(screen.getByRole("textbox", { name: "Region" }), { target: { value: "westus" } });
    const moved = { ...PICKED, hubName: "hub-2" };
    const next = withPlanValues(following(), { ...following().planValues, ...moved });
    rerender(<HowToPanel {...props} load={ready(next)} pickedEventHub={moved} />);
    expect((screen.getByRole("textbox", { name: "Event Hub name" }) as HTMLInputElement).value).toBe("hub-2");
    expect((screen.getByRole("textbox", { name: "Region" }) as HTMLInputElement).value).toBe("westus");
  });
});

describe("info affordances", () => {
  it("every chooser row, plan field and step row carries one (i)", () => {
    const chooserView = renderChooser();
    const chooser = chooserView.container.querySelector(".azo-howto-chooser")!;
    expect(chooser.querySelectorAll(".info-tip").length).toBe(chooserRows(manualEntra(), SELECTION).length);
    cleanup();
    const { container } = renderPanel();
    const form = container.querySelector(".azo-plan-form")!;
    expect(form.querySelectorAll(".info-tip").length).toBe(PLAN_VALUE_KEYS.length);
    const steps = container.querySelector("ol.azo-step-list")!;
    const rows = stepRows(manualEntra(), SELECTION, { canWrite: true });
    expect(rows.length).toBeGreaterThan(0);
    expect(steps.querySelectorAll(".info-tip").length).toBe(rows.length);
  });
});

describe("stale tick", () => {
  it("the note names the changed values and the box shows not done", () => {
    const ticked = toggleTick(ready(manualEntra()), "eh-namespace", true)!;
    const changed = withPlanValues(ticked, { ...ticked.planValues, namespace: "ns2" });
    const { container } = renderPanel({ load: ready(changed) });
    const row = stepRow(container, "eh-namespace");
    const note = row.querySelector(".azo-step-stale");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Event Hub namespace");
    expect(note!.textContent).not.toContain("Region");
    expect((within(row).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });
});

describe("visible copy", () => {
  it("carries no project history, the panel and every step dialog", () => {
    const ticked = toggleTick(ready(manualEntra()), "eh-namespace", true)!;
    const stale = withPlanValues(ticked, { ...ticked.planValues, namespace: "ns2" });
    const entries: CopyEntry[] = [];
    const mask = (t: string) => t.replace(API_VERSION_COPY_ALLOWANCE, `$1${API_VERSION_MASK}`);
    const chooser = renderChooser({ load: ready(stale) });
    entries.push({ where: "chooser", text: mask(chooser.container.textContent ?? "") });
    cleanup();
    const { container } = renderPanel({ load: ready(stale) });
    entries.push({ where: "panel", text: mask(container.textContent ?? "") });
    const ids = Array.from(container.querySelectorAll<HTMLElement>(".azo-step-row")).map((r) => r.dataset.step!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      fireEvent.click(within(stepRow(container, id)).getByRole("button", { name: /Instructions/ }));
      const dialog = container.querySelector("dialog")!;
      entries.push({ where: `dialog ${id}`, text: mask(dialog.textContent ?? "") });
      fireEvent.keyDown(dialog, { key: "Escape" });
    }
    const violations = findHistoryInCopy(entries);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
