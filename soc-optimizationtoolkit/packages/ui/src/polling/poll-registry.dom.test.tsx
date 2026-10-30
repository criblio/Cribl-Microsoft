// @vitest-environment happy-dom
/**
 * Pins for the poll registry (AZR-33).
 *
 * The one that matters most is the INTEGRATION pin: a host calling the real
 * useConsolidatedPolling with useMergedPolls must actually RUN a poll that a
 * sibling screen registered. Every other pin could pass on a registry whose
 * list never reaches the scheduler.
 *
 * The rest pin: register/unregister on null and unmount (a poll left behind
 * would keep spending the proxy budget after the screen is gone), the
 * no-provider fallback, that registering starts no timer of its own, that the
 * latest run() is called without re-registering, and duplicate detection.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  OUTSIDE_PROVIDER_MESSAGE,
  PollRegistryProvider,
  duplicatePollMessage,
  useMergedPolls,
  useRegisterPoll,
} from "./poll-registry";
import type { ConsolidatedPoll } from "./use-consolidated-polling";
import { useConsolidatedPolling } from "./use-consolidated-polling";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function poll(id: string, run: () => void = () => undefined): ConsolidatedPoll {
  return { id, intervalMs: 60_000, priority: 5, run };
}

function Registrar(props: { poll: ConsolidatedPoll | null }): ReactNode {
  useRegisterPoll(props.poll);
  return null;
}

const STATIC: readonly ConsolidatedPoll[] = [poll("static")];

function Reader(props: {
  staticPolls?: readonly ConsolidatedPoll[];
  onPolls: (polls: readonly ConsolidatedPoll[]) => void;
}): ReactNode {
  const merged = useMergedPolls(props.staticPolls ?? STATIC);
  props.onPolls(merged);
  return null;
}

function idsOf(polls: readonly ConsolidatedPoll[]): string[] {
  return polls.map((p) => p.id);
}

describe("PollRegistry", () => {
  it("shows a sibling's registration in useMergedPolls, and drops it on null and on unmount", () => {
    let seen: readonly ConsolidatedPoll[] = [];
    const onPolls = (p: readonly ConsolidatedPoll[]) => {
      seen = p;
    };
    const screen = poll("screen");
    const view = render(
      <PollRegistryProvider>
        <Reader onPolls={onPolls} />
        <Registrar poll={screen} />
      </PollRegistryProvider>,
    );
    expect(idsOf(seen)).toEqual(["static", "screen"]);

    view.rerender(
      <PollRegistryProvider>
        <Reader onPolls={onPolls} />
        <Registrar poll={null} />
      </PollRegistryProvider>,
    );
    expect(idsOf(seen)).toEqual(["static"]);

    view.rerender(
      <PollRegistryProvider>
        <Reader onPolls={onPolls} />
        <Registrar poll={screen} />
      </PollRegistryProvider>,
    );
    expect(idsOf(seen)).toEqual(["static", "screen"]);

    view.rerender(
      <PollRegistryProvider>
        <Reader onPolls={onPolls} />
      </PollRegistryProvider>,
    );
    expect(idsOf(seen)).toEqual(["static"]);
  });

  it("calls the caller's LATEST run without re-registering on a fresh object", async () => {
    let seen: readonly ConsolidatedPoll[] = [];
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <PollRegistryProvider>
        <Reader onPolls={(p) => (seen = p)} />
        <Registrar poll={poll("screen", first)} />
      </PollRegistryProvider>,
    );
    const registeredBefore = seen[1];
    view.rerender(
      <PollRegistryProvider>
        <Reader onPolls={(p) => (seen = p)} />
        <Registrar poll={poll("screen", second)} />
      </PollRegistryProvider>,
    );
    // Same stored wrapper: a fresh literal does not churn the registry.
    expect(seen[1]).toBe(registeredBefore);
    await seen[1]?.run();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("runs both the static and the registered poll through the one useConsolidatedPolling", async () => {
    vi.useFakeTimers();
    const staticRun = vi.fn();
    const screenRun = vi.fn();
    const staticPolls: readonly ConsolidatedPoll[] = [
      { id: "connection", intervalMs: 30_000, priority: 10, run: staticRun },
    ];
    let clock = 1_000_000;
    function Host(): ReactNode {
      useConsolidatedPolling({
        polls: useMergedPolls(staticPolls),
        maxPerMinute: 30,
        now: () => clock,
      });
      return null;
    }
    render(
      <PollRegistryProvider>
        <Host />
        <Registrar poll={poll("azure-onboarding-flow", screenRun)} />
      </PollRegistryProvider>,
    );
    // The host's first tick fires on mount; the registration lands in the
    // same commit, so the next tick must see it.
    await act(async () => {
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(staticRun).toHaveBeenCalled();
    expect(screenRun).toHaveBeenCalled();
  });

  it("returns the static array itself outside a provider, and a registration only logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let seen: readonly ConsolidatedPoll[] | undefined;
    const staticPolls: readonly ConsolidatedPoll[] = [poll("static")];
    render(
      <>
        <Reader staticPolls={staticPolls} onPolls={(p) => (seen = p)} />
        <Registrar poll={poll("screen")} />
      </>,
    );
    expect(seen).toBe(staticPolls);
    expect(warn).toHaveBeenCalledWith(OUTSIDE_PROVIDER_MESSAGE);
  });

  it("starts no timer while registering", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const view = render(
      <PollRegistryProvider>
        <Reader onPolls={() => undefined} />
        <Registrar poll={poll("screen")} />
      </PollRegistryProvider>,
    );
    view.rerender(
      <PollRegistryProvider>
        <Reader onPolls={() => undefined} />
        <Registrar poll={null} />
      </PollRegistryProvider>,
    );
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("detects a duplicate id: throws under duplicates='throw'", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <PollRegistryProvider duplicates="throw">
          <Registrar poll={poll("same")} />
          <Registrar poll={poll("same")} />
        </PollRegistryProvider>,
      ),
    ).toThrow(duplicatePollMessage("same"));
  });

  it("detects a duplicate id: logs and keeps the first under duplicates='log'", () => {
    const log = vi.fn();
    let seen: readonly ConsolidatedPoll[] = [];
    const firstRun = vi.fn();
    render(
      <PollRegistryProvider duplicates="log" log={log}>
        <Reader onPolls={(p) => (seen = p)} />
        <Registrar poll={poll("same", firstRun)} />
        <Registrar poll={poll("same")} />
      </PollRegistryProvider>,
    );
    expect(log).toHaveBeenCalledWith(duplicatePollMessage("same"));
    expect(idsOf(seen)).toEqual(["static", "same"]);
    void seen[1]?.run();
    expect(firstRun).toHaveBeenCalledTimes(1);
  });

  it("defaults to logging a duplicate id, never throwing (production-safe)", () => {
    const log = vi.fn();
    let seen: readonly ConsolidatedPoll[] = [];
    expect(() =>
      render(
        <PollRegistryProvider log={log}>
          <Reader onPolls={(p) => (seen = p)} />
          <Registrar poll={poll("same")} />
          <Registrar poll={poll("same")} />
        </PollRegistryProvider>,
      ),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(duplicatePollMessage("same"));
    expect(idsOf(seen)).toEqual(["static", "same"]);
  });
});
