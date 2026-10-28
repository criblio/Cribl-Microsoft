import { describe, expect, it } from "vitest";
import { DEFAULT_APP_OPTIONS, serializeAppOptions } from "@soc/core";
import type { AppOptions } from "@soc/core";
import {
  OPTIONS_SAVE_FAILED_NOTICE,
  OPTIONS_UNREADABLE_NOTICE,
  OPTIONS_LOADING,
  beginOptionsRetry,
  optionsReadFailureLine,
  optionsReadFromSettled,
  optionsReadFromSave,
  planOptionsSave,
  settleOptionsSave,
} from "./options-read";
import type { OptionsRead } from "./options-read";

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

  it("a fulfilled record is LOADED with the parsed operator options and the raw record", () => {
    expect(optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW })).toEqual({
      state: "loaded",
      options: SAVED,
      raw: SAVED_RAW,
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
      failures: 1,
    });
  });

  it("a non-Error rejection still becomes a string detail", () => {
    const read = optionsReadFromSettled({ status: "rejected", reason: "bridge closed" });
    expect(read).toEqual({
      state: "unreadable",
      options: DEFAULT_APP_OPTIONS,
      detail: "bridge closed",
      failures: 1,
    });
  });
});

describe("planOptionsSave (DBT-158)", () => {
  // The inline edit as the shell sends it: the Integrate toggle hands over
  // the whole operation section with one field changed.
  const edit = (o: AppOptions): AppOptions => ({
    ...o,
    operation: { ...o.operation, createDCE: true },
  });
  const patchOver = (o: AppOptions) => ({ operation: edit(o).operation });

  it("absent: the save is allowed and writes the edit over the defaults", () => {
    const plan = planOptionsSave(
      optionsReadFromSettled({ status: "fulfilled", value: null }),
      patchOver(DEFAULT_APP_OPTIONS),
    );
    expect(plan).toEqual({
      kind: "write",
      serialized: serializeAppOptions(edit(DEFAULT_APP_OPTIONS)),
    });
  });

  it("loaded: the save is allowed and writes the edit over the OPERATOR's options", () => {
    const plan = planOptionsSave(
      optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW }),
      patchOver(SAVED),
    );
    expect(plan).toEqual({ kind: "write", serialized: serializeAppOptions(edit(SAVED)) });
  });

  it("unreadable: the save is REFUSED with the plain-words reason and nothing to write", () => {
    const plan = planOptionsSave(optionsReadFromSettled(REFUSED), patchOver(SAVED));
    expect(plan).toEqual({ kind: "refused", reason: OPTIONS_UNREADABLE_NOTICE });
    expect(Object.keys(plan)).toEqual(["kind", "reason"]);
  });

  it("loading: the save is refused too - the read has not answered yet", () => {
    const plan = planOptionsSave(OPTIONS_LOADING, patchOver(SAVED));
    expect(plan).toEqual({
      kind: "refused",
      reason: "Your saved deployment options are still loading; try again in a moment.",
    });
  });

  it("a later successful read lifts the block", () => {
    expect(planOptionsSave(optionsReadFromSettled(REFUSED), patchOver(SAVED)).kind).toBe("refused");
    const retried = optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW });
    expect(planOptionsSave(retried, patchOver(SAVED))).toEqual({
      kind: "write",
      serialized: serializeAppOptions(edit(SAVED)),
    });
  });

  it("a successful save is itself a loaded read of what was written", () => {
    const written = serializeAppOptions(edit(SAVED));
    expect(optionsReadFromSave(written)).toEqual({ state: "loaded", options: edit(SAVED), raw: written });
  });
});

// DBT-172: an inline save is a PATCH of the stored document, not a rewrite of
// it. The canonical serializer drops every key the codec does not manage, so
// a save through it deleted legacy _comments and any section a newer version
// wrote, every time the DCE toggle was clicked.
describe("planOptionsSave keeps what the codec does not manage (DBT-172)", () => {
  const STORED_WITH_UNMANAGED = JSON.stringify({
    _comments: { operation: "written by the PowerShell era; keep" },
    futureSection: { addedBy: "1.99.0", flags: [1, 2] },
    operation: {
      ...DEFAULT_APP_OPTIONS.operation,
      createDCE: false,
      futureOperationKey: "from a newer version",
    },
    cribl: { ...DEFAULT_APP_OPTIONS.cribl, destinationPrefix: "acme_", futureCriblKey: 7 },
  });
  const loaded = optionsReadFromSettled({ status: "fulfilled", value: STORED_WITH_UNMANAGED });
  const toggleOn = { operation: { ...loaded.options.operation, createDCE: true } };

  it("an unknown top-level key and an unknown nested key survive a DCE toggle", () => {
    const plan = planOptionsSave(loaded, toggleOn);
    if (plan.kind !== "write") throw new Error("expected a write");
    const written = JSON.parse(plan.serialized) as Record<string, Record<string, unknown>>;
    const before = JSON.parse(STORED_WITH_UNMANAGED) as Record<string, Record<string, unknown>>;
    // The toggled value changed, and NOTHING else did: the whole written
    // document is the stored one with exactly that one field flipped.
    expect(written).toEqual({
      ...before,
      operation: { ...before["operation"], createDCE: true },
    });
    expect(Object.keys(written).sort()).toEqual(["_comments", "cribl", "futureSection", "operation"]);
    expect(written["operation"]?.["futureOperationKey"]).toBe("from a newer version");
    expect(written["cribl"]?.["futureCriblKey"]).toBe(7);
    expect(before["operation"]?.["createDCE"]).toBe(false);
    expect(written["operation"]?.["createDCE"]).toBe(true);
  });

  it("the read after that save patches the WRITTEN document, so the keys survive every save", () => {
    const plan = planOptionsSave(loaded, toggleOn);
    if (plan.kind !== "write") throw new Error("expected a write");
    const after = optionsReadFromSave(plan.serialized);
    expect(after).toEqual({
      state: "loaded",
      options: { ...loaded.options, operation: { ...loaded.options.operation, createDCE: true } },
      raw: plan.serialized,
    });
    const second = planOptionsSave(after, {
      operation: { ...after.options.operation, createDCE: false },
    });
    if (second.kind !== "write") throw new Error("expected a write");
    expect(JSON.parse(second.serialized)).toEqual(JSON.parse(STORED_WITH_UNMANAGED));
  });

  it("a record an older version wrote gains ONLY the toggled field, not the screen's defaults", () => {
    // The toggle hands over the whole operation section as the screen shows
    // it: parsed, so a field the record never held, or held as junk, arrives
    // as its DEFAULT. Writing those would freeze today's defaults into the
    // record and overwrite the junk the operator never touched; only the
    // field that changed may be written.
    const older = JSON.stringify({
      _comments: "keep",
      operation: { createDCE: false, deploymentTimeoutSeconds: "soon" },
    });
    const read = optionsReadFromSettled({ status: "fulfilled", value: older });
    const plan = planOptionsSave(read, {
      operation: { ...read.options.operation, createDCE: true },
    });
    expect(plan).toEqual({
      kind: "write",
      serialized: JSON.stringify({
        _comments: "keep",
        operation: { createDCE: true, deploymentTimeoutSeconds: "soon" },
      }),
    });
    // The cribl section narrows the same way.
    const criblPlan = planOptionsSave(read, {
      cribl: { ...read.options.cribl, workerGroup: "prod" },
    });
    expect(criblPlan).toEqual({
      kind: "write",
      serialized: JSON.stringify({
        _comments: "keep",
        operation: { createDCE: false, deploymentTimeoutSeconds: "soon" },
        cribl: { workerGroup: "prod" },
      }),
    });
  });

  it("absent: the patch applies over the complete defaults, so every managed field is written", () => {
    const absent = optionsReadFromSettled({ status: "fulfilled", value: null });
    const plan = planOptionsSave(absent, { operation: { createDCE: true } });
    expect(plan).toEqual({
      kind: "write",
      serialized: JSON.stringify({
        operation: { ...DEFAULT_APP_OPTIONS.operation, createDCE: true },
        cribl: DEFAULT_APP_OPTIONS.cribl,
      }),
    });
  });

  it("a loaded record that is not a JSON object is patched over the defaults it parsed to", () => {
    const junk = optionsReadFromSettled({ status: "fulfilled", value: "not json" });
    expect(junk.state).toBe("loaded");
    const plan = planOptionsSave(junk, { operation: { createDCE: true } });
    expect(plan).toEqual({
      kind: "write",
      serialized: JSON.stringify({
        operation: { ...DEFAULT_APP_OPTIONS.operation, createDCE: true },
        cribl: DEFAULT_APP_OPTIONS.cribl,
      }),
    });
  });
});

// DBT-173: a PUT that fails must not look saved. The stored record is still
// what it was, so the read stays what it was and the operator is told.
describe("settleOptionsSave (DBT-173)", () => {
  const flip = (o: AppOptions): AppOptions => ({
    ...o,
    operation: { ...o.operation, createDCE: !o.operation.createDCE },
  });
  const before = optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW });
  const written = serializeAppOptions(flip(SAVED));

  it("a fulfilled PUT makes the written document the loaded read, with no notice", () => {
    expect(settleOptionsSave(before, written, { status: "fulfilled", value: undefined })).toEqual({
      read: { state: "loaded", options: flip(SAVED), raw: written },
      notice: null,
    });
  });

  it("a rejected PUT keeps the read EXACTLY as it was - never loaded with the unsaved edit", () => {
    const settled = settleOptionsSave(before, written, {
      status: "rejected",
      reason: new Error("PUT kvstore/appOptions: HTTP 503"),
    });
    expect(settled.read).toBe(before);
    expect(settled.read.options.operation.createDCE).toBe(SAVED.operation.createDCE);
    expect(settled.notice).toBe(`${OPTIONS_SAVE_FAILED_NOTICE} (PUT kvstore/appOptions: HTTP 503)`);
  });

  it("a non-Error rejection still names what failed", () => {
    const settled = settleOptionsSave(before, written, { status: "rejected", reason: "bridge closed" });
    expect(settled.notice).toBe(`${OPTIONS_SAVE_FAILED_NOTICE} (bridge closed)`);
  });

  it("the failure notice says, in plain words, that the change was not saved", () => {
    expect(OPTIONS_SAVE_FAILED_NOTICE).toBe(
      "Could not save your deployment option: the app key-value store refused or did not answer, " +
        "so the change was NOT saved. The value shown is still your saved option. Try the change " +
        "again when the leader is reachable.",
    );
  });
});

// The DBT-158 review minors: a retry has an in-flight state, so a double
// click cannot fire two reads, and a failed retry is visibly a NEW failure.
describe("options read retry (DBT-173)", () => {
  const unreadable = optionsReadFromSettled(REFUSED);
  const retry = (read: OptionsRead): OptionsRead => {
    const next = beginOptionsRetry(read);
    if (next === null) throw new Error("expected a retry to start");
    return next;
  };

  it("beginOptionsRetry turns an unreadable read into retrying, keeping what it knew", () => {
    expect(beginOptionsRetry(unreadable)).toEqual({
      state: "retrying",
      options: DEFAULT_APP_OPTIONS,
      detail: 'GET kvstore/appOptions: HTTP 403\n{"message":"Forbidden"}',
      failures: 1,
    });
  });

  it("a second click while retrying starts nothing (null), nor does a read that answered", () => {
    expect(beginOptionsRetry(retry(unreadable))).toBeNull();
    expect(beginOptionsRetry(OPTIONS_LOADING)).toBeNull();
    expect(beginOptionsRetry(optionsReadFromSettled({ status: "fulfilled", value: null }))).toBeNull();
    expect(beginOptionsRetry(optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW }))).toBeNull();
  });

  it("saving is refused while retrying, with the unreadable reason", () => {
    expect(planOptionsSave(retry(unreadable), { operation: { createDCE: true } })).toEqual({
      kind: "refused",
      reason: OPTIONS_UNREADABLE_NOTICE,
    });
  });

  it("a failed retry counts as a new failure and carries the NEW reason", () => {
    const again = optionsReadFromSettled(
      { status: "rejected", reason: new Error("GET kvstore/appOptions: timed out after 15000 ms") },
      retry(unreadable),
    );
    expect(again).toEqual({
      state: "unreadable",
      options: DEFAULT_APP_OPTIONS,
      detail: "GET kvstore/appOptions: timed out after 15000 ms",
      failures: 2,
    });
    expect(optionsReadFromSettled(REFUSED, retry(again))).toMatchObject({ failures: 3 });
  });

  it("a prior read that was not a retry does not inflate the count", () => {
    expect(optionsReadFromSettled(REFUSED, unreadable)).toMatchObject({ failures: 1 });
    expect(optionsReadFromSettled(REFUSED, OPTIONS_LOADING)).toMatchObject({ failures: 1 });
  });

  it("a successful retry is loaded, the failures forgotten", () => {
    expect(optionsReadFromSettled({ status: "fulfilled", value: SAVED_RAW }, retry(unreadable))).toEqual({
      state: "loaded",
      options: SAVED,
      raw: SAVED_RAW,
    });
  });

  it("optionsReadFailureLine: nothing on the first failure, the retry's own failure after", () => {
    expect(optionsReadFailureLine(unreadable)).toBeNull();
    expect(optionsReadFailureLine(retry(unreadable))).toBeNull();
    expect(optionsReadFailureLine(OPTIONS_LOADING)).toBeNull();
    const again = optionsReadFromSettled(
      { status: "rejected", reason: new Error("GET kvstore/appOptions: HTTP 502") },
      retry(unreadable),
    );
    expect(optionsReadFailureLine(again)).toBe(
      "The retry failed too (2 failed reads in a row): GET kvstore/appOptions: HTTP 502",
    );
    // While that failure is itself being retried, the line stays up.
    expect(optionsReadFailureLine(retry(again))).toBe(
      "The retry failed too (2 failed reads in a row): GET kvstore/appOptions: HTTP 502",
    );
  });
});
