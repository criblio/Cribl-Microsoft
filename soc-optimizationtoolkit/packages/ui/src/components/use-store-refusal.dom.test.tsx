// @vitest-environment happy-dom
/**
 * useStoreRefusal (DBT-181 review): the ONE place that decides which store
 * answer still describes what is on screen, and when a refusal note goes away.
 *
 *  - "latest": every tracked call writes the same slot, so only the newest
 *    call's answer counts, and its success clears any note.
 *  - "scope": answers count until reset() (the scope moved); a success clears
 *    only the refusals it is declared to cover.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useStoreRefusal } from "./use-store-refusal";
import type { StoreRefusalState } from "./use-store-refusal";

afterEach(cleanup);

type Action = "save" | "clear" | "read";

function mount(mode: "latest" | "scope") {
  const seen: { current: StoreRefusalState<Action> | null } = { current: null };
  function Probe() {
    seen.current = useStoreRefusal<Action>(mode);
    return null;
  }
  render(<Probe />);
  return seen;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useStoreRefusal - latest", () => {
  it("keeps a refusal, and the next success clears it", async () => {
    const seen = mount("latest");
    let landed: boolean | undefined;
    await act(async () => {
      landed = await seen.current!.track(Promise.reject(new Error("403")), "save");
    });
    expect(landed).toBe(false);
    expect(seen.current!.refusal).toEqual({ action: "save", reason: "Error: 403" });
    await act(async () => {
      landed = await seen.current!.track(Promise.resolve(), "clear");
    });
    expect(landed).toBe(true);
    expect(seen.current!.refusal).toBeNull();
  });

  it("an older call answering late is ignored either way", async () => {
    const seen = mount("latest");
    const first = deferred();
    let firstLanded: boolean | undefined;
    act(() => {
      void seen.current!.track(first.promise, "save").then((v) => {
        firstLanded = v;
      });
    });
    await act(async () => {
      await seen.current!.track(Promise.resolve(), "save");
    });
    first.reject(new Error("late"));
    await flush();
    expect(firstLanded).toBe(false);
    expect(seen.current!.refusal).toBeNull();
  });
});

describe("useStoreRefusal - scope", () => {
  it("a success clears only the refusals it covers", async () => {
    const seen = mount("scope");
    act(() => seen.current!.refuse("read", new Error("R")));
    await act(async () => {
      await seen.current!.track(Promise.resolve(), "save");
    });
    expect(seen.current!.refusal?.action).toBe("read");
    await act(async () => {
      await seen.current!.track(Promise.resolve(), "save", ["read"]);
    });
    expect(seen.current!.refusal).toBeNull();
  });

  it("does not let one call outrank another in the same scope", async () => {
    const seen = mount("scope");
    const first = deferred();
    act(() => {
      void seen.current!.track(first.promise, "save");
    });
    await act(async () => {
      await seen.current!.track(Promise.resolve(), "clear");
    });
    first.reject(new Error("still this scope"));
    await flush();
    expect(seen.current!.refusal).toEqual({
      action: "save",
      reason: "Error: still this scope",
    });
  });

  it("drops an answer from before reset(), and reset clears the note", async () => {
    const seen = mount("scope");
    act(() => seen.current!.refuse("read", new Error("R")));
    const first = deferred();
    act(() => {
      void seen.current!.track(first.promise, "save");
    });
    act(() => seen.current!.reset());
    expect(seen.current!.refusal).toBeNull();
    first.reject(new Error("old scope"));
    await flush();
    expect(seen.current!.refusal).toBeNull();
  });

  it("isCurrent says whether the scope it was taken in still holds", () => {
    const seen = mount("scope");
    const isCurrent = seen.current!.pin();
    expect(isCurrent()).toBe(true);
    act(() => seen.current!.reset());
    expect(isCurrent()).toBe(false);
  });
});
