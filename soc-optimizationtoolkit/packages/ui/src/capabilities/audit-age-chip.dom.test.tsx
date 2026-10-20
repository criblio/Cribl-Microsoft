// @vitest-environment happy-dom
/**
 * Pins for the connection bar's audit-age chip (HON-6).
 *
 * The one that matters most is the TICK. The hook computes its view at the
 * shell's render and nothing re-renders the shell as time passes, so without
 * the chip's own interval the age freezes at whatever it read on mount - which
 * is "just now", the most reassuring wrong answer available. Every other pin
 * here could pass on a chip that never moves.
 *
 * The rest pin the three statuses' exact text and tone, that the (i) carries
 * the domain's full line, and that the re-check cannot fire while an audit is
 * already spending the request budget.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyCapabilitySet } from "@soc/core";
import type { CapabilitySet } from "@soc/core";
import { findHistoryInCopy } from "../components/copy-rules";
import { AUDIT_AGE_TICK_MS, AuditAgeChip } from "./audit-age-chip";
import {
  AUDIT_CHIP_HINT,
  auditChipText,
  auditChipTip,
} from "./capability-audit-state";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const KEY = "tenant-a|client-a|sub-a|rg-a|ws-a";
const AUDITED_AT = "2026-08-06T12:00:00.000Z";

function setFor(connectionId: string | null, auditedAt: string | null): CapabilitySet {
  return { ...emptyCapabilitySet(), connectionId, auditedAt };
}

const CURRENT = setFor(KEY, AUDITED_AT);
const OTHER = setFor("tenant-b|client-b|sub-b|rg-b|ws-b", AUDITED_AT);
const NEVER = emptyCapabilitySet();

/** A clock the test moves by hand. */
function clockAt(iso: string): { now: () => string; set: (next: string) => void } {
  let current = iso;
  return { now: () => current, set: (next) => (current = next) };
}

function renderChip(
  capabilities: CapabilitySet,
  overrides: { now?: () => string; running?: boolean; onRecheck?: () => void } = {},
) {
  const onRecheck = overrides.onRecheck ?? vi.fn();
  const utils = render(
    <AuditAgeChip
      capabilities={capabilities}
      auditKey={KEY}
      now={overrides.now ?? (() => "2026-08-06T12:05:30.000Z")}
      running={overrides.running ?? false}
      onRecheck={onRecheck}
    />,
  );
  const chip = utils.container.querySelector(".audit-chip");
  if (chip === null) {
    throw new Error("no .audit-chip rendered");
  }
  return { ...utils, chip, onRecheck };
}

describe("AuditAgeChip text and tone", () => {
  it("shows the age, in the ok tone, for an audit of THIS connection", () => {
    const { chip } = renderChip(CURRENT);
    expect(chip.textContent).toBe("permissions: checked 5 minutes ago");
    expect(chip.className).toBe("audit-chip audit-chip-ok");
  });

  it("says never checked, muted, when nothing was measured", () => {
    const { chip } = renderChip(NEVER);
    expect(chip.textContent).toBe("permissions: not checked");
    expect(chip.className).toBe("audit-chip audit-chip-muted");
  });

  it("flags another connection's audit for attention instead of showing its age", () => {
    // The set HAS an age, and it is five minutes - showing it would be telling
    // the operator about a measurement of something else.
    const { chip } = renderChip(OTHER);
    expect(chip.textContent).toBe("permissions: not checked for this connection");
    expect(chip.className).toBe("audit-chip audit-chip-attention");
  });

  it("puts the domain's full line and the age's meaning behind the (i)", () => {
    renderChip(OTHER);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "The last permission check was for a different connection or scope. " +
        "Re-run it to see what this one can do.\n\n" +
        AUDIT_CHIP_HINT,
    );
  });

  it("keeps project history out of every string an operator reads", () => {
    const entries = [
      ...(["current", "never-run", "other-connection"] as const).map((status) => ({
        where: `chip:${status}`,
        text: auditChipText(status, "5 minutes ago"),
      })),
      { where: "tip", text: auditChipTip("Permissions checked just now.") },
    ];
    expect(findHistoryInCopy(entries)).toEqual([]);
  });
});

describe("AuditAgeChip tick", () => {
  it("re-reads the clock on its own, with nothing re-rendering it from outside", () => {
    vi.useFakeTimers();
    const clock = clockAt("2026-08-06T12:00:10.000Z");
    const { chip } = renderChip(CURRENT, { now: clock.now });
    expect(chip.textContent).toBe("permissions: checked just now");

    clock.set("2026-08-06T12:03:10.000Z");
    act(() => {
      vi.advanceTimersByTime(AUDIT_AGE_TICK_MS);
    });
    expect(chip.textContent).toBe("permissions: checked 3 minutes ago");
  });

  it("ticks once a minute, the age's own resolution", () => {
    expect(AUDIT_AGE_TICK_MS).toBe(60_000);
  });

  it("does not tick when the text cannot change", () => {
    vi.useFakeTimers();
    renderChip(NEVER);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("AuditAgeChip re-check", () => {
  it("re-audits exactly once per click when idle", () => {
    const { onRecheck } = renderChip(CURRENT);
    const button = screen.getByRole("button", { name: "Re-check permissions" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("is disabled and says so while an audit is running, and a click does nothing", () => {
    const { onRecheck } = renderChip(CURRENT, { running: true });
    const button = screen.getByRole("button", { name: "Checking..." });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onRecheck).not.toHaveBeenCalled();
  });
});
