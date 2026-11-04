// @vitest-environment happy-dom
/**
 * DBT-256: opening a folded section takes ONE click.
 *
 * Reported 2026-11-04 on Sentinel Integration: clicking a folded section's
 * header closed the open section and left the clicked one shut. NumberedSection
 * fired the move on pointer DOWN, the move folded the open section above at
 * once, the clicked header shifted up before the pointer came up, and the
 * click landed elsewhere. happy-dom has no layout, so the shift cannot be
 * replayed here; what is pinned is the contract that removes it: nothing in
 * the header folds anything (opening is not a move, DBT-248), one click opens,
 * and the others fold once the operator works in the opened section.
 */

import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_AZURE_CONFIG } from "@soc/core";
import type { SectionStatus } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { NumberedSection } from "../numbered-section";
import { useSectionFolding } from "./use-section-folding";

afterEach(cleanup);

const IDS = ["first", "second"];

const ports = {
  contentCache: { get: async () => null, set: async () => undefined },
  user: {
    current: async () => {
      throw new Error("no identity");
    },
  },
} as unknown as UiPorts;

function Page(): ReactElement {
  const f = useSectionFolding({ ids: IDS, currentId: "first", pinPrefix: "fixture" });
  return (
    <div>
      {IDS.map((id, i) => (
        <NumberedSection
          key={id}
          number={i + 1}
          title={`Section ${id}`}
          status={"available" as SectionStatus}
          infoTip="tip"
          collapsed={f.collapsed.has(id)}
          onCollapsedChange={(c) => f.setCollapsed(id, c)}
          onActivate={() => f.moveTo(id)}
        >
          <input aria-label={`field in ${id}`} />
        </NumberedSection>
      ))}
    </div>
  );
}

function mount() {
  render(
    <PortsProvider ports={ports} config={EMPTY_AZURE_CONFIG}>
      <Page />
    </PortsProvider>,
  );
}

const sectionOf = (id: string): HTMLElement =>
  screen.getByRole("heading", { name: `Section ${id}` }).closest("section")!;
const isOpen = (id: string): boolean =>
  !sectionOf(id).classList.contains("numbered-section-collapsed");
const head = (id: string): HTMLElement =>
  sectionOf(id).querySelector<HTMLElement>(".numbered-section-head")!;

describe("NumberedSection under useSectionFolding - one click opens (DBT-256)", () => {
  it("starts with only the current section open", () => {
    mount();
    expect([isOpen("first"), isOpen("second")]).toEqual([true, false]);
  });

  it("pointer down on a folded header folds nothing: the layout holds until the click", () => {
    mount();
    fireEvent.pointerDown(head("second"));
    expect([isOpen("first"), isOpen("second")]).toEqual([true, false]);
  });

  it("one header click opens the clicked section; working in it folds the other", () => {
    mount();
    fireEvent.pointerDown(head("second"));
    fireEvent.click(head("second"));
    expect([isOpen("first"), isOpen("second")]).toEqual([true, true]);
    fireEvent.pointerDown(screen.getByLabelText("field in second"));
    expect([isOpen("first"), isOpen("second")]).toEqual([false, true]);
  });

  it("the header's Expand button opens in one press too, focus included", () => {
    mount();
    const expand = screen.getByRole("button", { name: "Expand Section second" });
    fireEvent.pointerDown(expand);
    fireEvent.focus(expand);
    fireEvent.click(expand);
    expect([isOpen("first"), isOpen("second")]).toEqual([true, true]);
  });

  it("a header click on the open section only closes it", () => {
    mount();
    fireEvent.click(head("first"));
    expect([isOpen("first"), isOpen("second")]).toEqual([false, false]);
  });
});

describe("NumberedSection - when it reports a move (DBT-256)", () => {
  function one(collapsed: boolean) {
    const onActivate = vi.fn();
    render(
      <NumberedSection
        number={1}
        title="Solo"
        status={"available" as SectionStatus}
        infoTip="tip"
        collapsed={collapsed}
        onCollapsedChange={() => undefined}
        onActivate={onActivate}
      >
        <input aria-label="solo field" />
      </NumberedSection>,
    );
    const h = document.querySelector<HTMLElement>(".numbered-section-head")!;
    return { onActivate, h };
  }

  it("pointer down or focus in the BODY still reports a move", () => {
    const { onActivate } = one(false);
    fireEvent.pointerDown(screen.getByLabelText("solo field"));
    fireEvent.focus(screen.getByLabelText("solo field"));
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("nothing in the header reports a move: pointer down, focus or click", () => {
    const folded = one(true);
    fireEvent.pointerDown(folded.h);
    fireEvent.click(folded.h);
    const expand = screen.getByRole("button", { name: "Expand Solo" });
    fireEvent.pointerDown(expand);
    fireEvent.focus(expand);
    fireEvent.click(expand);
    expect(folded.onActivate).not.toHaveBeenCalled();
  });
});
