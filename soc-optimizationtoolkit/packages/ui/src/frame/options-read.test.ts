import { describe, expect, it } from "vitest";
import { DEFAULT_APP_OPTIONS, serializeAppOptions } from "@soc/core";
import type { AppOptions } from "@soc/core";
import {
  OPTIONS_UNREADABLE_NOTICE,
  OPTIONS_LOADING,
  optionsReadFromSettled,
  optionsReadFromSave,
  planOptionsSave,
} from "./options-read";

// An operator's saved options that differ from the defaults in every section,
// so a defaults-over-real-options write would be visible in the payload.
const SAVED: AppOptions = {
  operation: { ...DEFAULT_APP_OPTIONS.operation, createDCE: !DEFAULT_APP_OPTIONS.operation.createDCE },
  cribl: { ...DEFAULT_APP_OPTIONS.cribl, destinationPrefix: "acme_", workerGroup: "prod" },
};
const SAVED_RAW = serializeAppOptions(SAVED);

const REFUSED: PromiseSettledResult<string | null> = {
  status: "rejected",
  reason: new Error('GET kvstore/appOptions: HTTP 403\n{"message":"Forbidden"}'),
};

describe("optionsReadFromSettled (DBT-158)", () => {
  it("a fulfilled null is ABSENT - never written, so the defaults are the truth", () => {
    const read = optionsReadFromSettled({ status: "fulfilled", value: null });
    expect(read).toEqual({ state: "absent", options: DEFAULT_APP_OPTIONS });
  });

  it("a fulfilled blank string is absent too", () => {
    expect(optionsReadFromSettled({ status: "fulfilled", value: "  " }).state).toBe("absent");
  });

  it("a fulfilled record is LOADED with the parsed operator options", () => {
    expect(optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW })).toEqual({
      state: "loaded",
      options: SAVED,
    });
  });

  it("a rejected read is UNREADABLE, carrying the reason - unknown, never none", () => {
    const read = optionsReadFromSettled(REFUSED);
    expect(read.state).toBe("unreadable");
    // The screen still needs something to render, so it carries the defaults,
    // but the state says they are NOT the operator's options.
    expect(read.options).toEqual(DEFAULT_APP_OPTIONS);
    expect(read).toEqual({
      state: "unreadable",
      options: DEFAULT_APP_OPTIONS,
      detail: 'GET kvstore/appOptions: HTTP 403\n{"message":"Forbidden"}',
    });
  });

  it("a non-Error rejection still becomes a string detail", () => {
    const read = optionsReadFromSettled({ status: "rejected", reason: "bridge closed" });
    expect(read).toEqual({ state: "unreadable", options: DEFAULT_APP_OPTIONS, detail: "bridge closed" });
  });
});

describe("planOptionsSave (DBT-158)", () => {
  const edit = (o: AppOptions): AppOptions => ({
    ...o,
    operation: { ...o.operation, createDCE: true },
  });

  it("absent: the save is allowed and writes the edit over the defaults", () => {
    const plan = planOptionsSave(optionsReadFromSettled({ status: "fulfilled", value: null }), edit);
    expect(plan).toEqual({
      kind: "write",
      serialized: serializeAppOptions(edit(DEFAULT_APP_OPTIONS)),
    });
  });

  it("loaded: the save is allowed and writes the edit over the OPERATOR's options", () => {
    const plan = planOptionsSave(optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW }), edit);
    expect(plan).toEqual({ kind: "write", serialized: serializeAppOptions(edit(SAVED)) });
  });

  it("unreadable: the save is REFUSED with the plain-words reason and nothing to write", () => {
    const plan = planOptionsSave(optionsReadFromSettled(REFUSED), edit);
    expect(plan).toEqual({ kind: "refused", reason: OPTIONS_UNREADABLE_NOTICE });
    expect(Object.keys(plan)).toEqual(["kind", "reason"]);
  });

  it("loading: the save is refused too - the read has not answered yet", () => {
    const plan = planOptionsSave(OPTIONS_LOADING, edit);
    expect(plan.kind).toBe("refused");
  });

  it("a later successful read lifts the block", () => {
    expect(planOptionsSave(optionsReadFromSettled(REFUSED), edit).kind).toBe("refused");
    const retried = optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW });
    expect(planOptionsSave(retried, edit)).toEqual({
      kind: "write",
      serialized: serializeAppOptions(edit(SAVED)),
    });
  });

  it("a successful save is itself a loaded read of what was written", () => {
    const written = serializeAppOptions(edit(SAVED));
    expect(optionsReadFromSave(written)).toEqual({ state: "loaded", options: edit(SAVED) });
  });
});
