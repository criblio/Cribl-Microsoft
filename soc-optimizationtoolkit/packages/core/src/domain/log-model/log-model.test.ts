import { describe, expect, it } from "vitest";

import {
  LOG_LEVELS,
  appendLogEntry,
  buildSupportBundle,
  filterLogEntries,
  formatJobLine,
  formatLogLine,
} from "./log-model";
import { redactedLength } from "../../ports/logger";
import type { LogContext, LogEntry } from "../../ports/logger";
import type { JobRecord } from "../../ports/job-store";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-07-03T10:00:00.000Z",
    level: "info",
    message: "hello",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

describe("appendLogEntry", () => {
  it("appends below the bound and never mutates the input array", () => {
    const first = entry({ message: "one" });
    const initial: LogEntry[] = [];

    const one = appendLogEntry(initial, first, 3);
    const two = appendLogEntry(one, entry({ message: "two" }), 3);

    expect(initial).toEqual([]);
    expect(one.map((e) => e.message)).toEqual(["one"]);
    expect(two.map((e) => e.message)).toEqual(["one", "two"]);
    expect(two).not.toBe(one);
  });

  it("drops the OLDEST entries once maxEntries is exceeded (ring bound)", () => {
    let entries: LogEntry[] = [];
    for (const message of ["a", "b", "c", "d", "e"]) {
      entries = appendLogEntry(entries, entry({ message }), 3);
    }
    expect(entries.map((e) => e.message)).toEqual(["c", "d", "e"]);
  });

  it("keeps exactly maxEntries at the boundary", () => {
    let entries: LogEntry[] = [];
    for (const message of ["a", "b", "c"]) {
      entries = appendLogEntry(entries, entry({ message }), 3);
    }
    expect(entries.map((e) => e.message)).toEqual(["a", "b", "c"]);
  });

  it("yields an empty buffer for a bound of zero or less", () => {
    expect(appendLogEntry([entry()], entry(), 0)).toEqual([]);
    expect(appendLogEntry([entry()], entry(), -5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Line format (PINNED - this is what users grep and bundles carry)
// ---------------------------------------------------------------------------

describe("formatLogLine", () => {
  it("pins the plain line: ISO time, level padded to 5, message", () => {
    expect(formatLogLine(entry())).toBe(
      "2026-07-03T10:00:00.000Z [INFO ] hello",
    );
  });

  it("pins the full line: job tag and k=v context pairs in insertion order", () => {
    const line = formatLogLine(
      entry({
        level: "error",
        message: "deploy DCR failed",
        jobId: "job-7",
        context: {
          table: "SecurityEvent",
          columns: 42,
          retried: false,
          location: null,
        },
      }),
    );
    expect(line).toBe(
      "2026-07-03T10:00:00.000Z [ERROR] [job:job-7] deploy DCR failed" +
        " table=SecurityEvent columns=42 retried=false location=null",
    );
  });

  it("pads every level to the same 5-char column", () => {
    expect(formatLogLine(entry({ level: "debug" }))).toContain("[DEBUG]");
    expect(formatLogLine(entry({ level: "info" }))).toContain("[INFO ]");
    expect(formatLogLine(entry({ level: "warn" }))).toContain("[WARN ]");
    expect(formatLogLine(entry({ level: "error" }))).toContain("[ERROR]");
  });

  it("JSON-quotes context strings that would break k=v parsing", () => {
    const line = formatLogLine(
      entry({
        context: {
          spaced: "HTTP 403 denied",
          equals: "a=b",
          empty: "",
          plain: "law-prod",
        },
      }),
    );
    expect(line).toBe(
      '2026-07-03T10:00:00.000Z [INFO ] hello spaced="HTTP 403 denied"' +
        ' equals="a=b" empty="" plain=law-prod',
    );
  });

  it("keeps a record on ONE line even when message or context spans lines", () => {
    const line = formatLogLine(
      entry({
        message: "first\nsecond",
        context: { body: "line1\nline2" },
      }),
    );
    expect(line).not.toContain("\n");
    expect(line).toBe(
      '2026-07-03T10:00:00.000Z [INFO ] first\\nsecond body="line1\\nline2"',
    );
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("filterLogEntries", () => {
  const entries: LogEntry[] = [
    entry({ level: "debug", message: "poll attempt", jobId: "job-1" }),
    entry({ level: "info", message: "step succeeded", jobId: "job-1" }),
    entry({ level: "warn", message: "fallback used" }),
    entry({
      level: "error",
      message: "deploy failed",
      jobId: "job-2",
      context: { table: "SecurityEvent" },
    }),
  ];

  it("level is a MINIMUM severity, in LOG_LEVELS order", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
    expect(filterLogEntries(entries, { level: "warn" }).map((e) => e.message))
      .toEqual(["fallback used", "deploy failed"]);
    expect(filterLogEntries(entries, { level: "debug" })).toHaveLength(4);
  });

  it("jobId is an exact match", () => {
    expect(filterLogEntries(entries, { jobId: "job-1" })).toHaveLength(2);
    expect(filterLogEntries(entries, { jobId: "job" })).toHaveLength(0);
  });

  it("text matches the FORMATTED line case-insensitively (message, context, job tag)", () => {
    expect(filterLogEntries(entries, { text: "SECURITYEVENT" })).toHaveLength(1);
    expect(filterLogEntries(entries, { text: "job:job-2" })).toHaveLength(1);
    expect(filterLogEntries(entries, { text: "no such text" })).toHaveLength(0);
  });

  it("combines criteria and treats absent/empty ones as no filter", () => {
    expect(filterLogEntries(entries, {})).toHaveLength(4);
    expect(filterLogEntries(entries, { text: "" })).toHaveLength(4);
    expect(
      filterLogEntries(entries, { level: "info", jobId: "job-1", text: "step" }),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Support bundle
// ---------------------------------------------------------------------------

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    kind: "onboard-table",
    status: "succeeded",
    input: { table: "SecurityEvent" },
    steps: [
      { name: "fetch-workspace", status: "succeeded" },
      { name: "deploy-dcr", status: "succeeded" },
    ],
    createdAt: "2026-07-03T09:00:00.000Z",
    updatedAt: "2026-07-03T09:05:00.000Z",
    ...overrides,
  };
}

describe("formatJobLine", () => {
  it("pins the compact job line and EXCLUDES input/result payloads", () => {
    const line = formatJobLine(job());
    expect(line).toBe(
      "job-1 kind=onboard-table status=succeeded" +
        " createdAt=2026-07-03T09:00:00.000Z updatedAt=2026-07-03T09:05:00.000Z" +
        " steps=[fetch-workspace:succeeded,deploy-dcr:succeeded]",
    );
    expect(line).not.toContain("SecurityEvent");
  });

  it("appends quoted error text for failed jobs", () => {
    const line = formatJobLine(
      job({ status: "failed", error: "HTTP 403 denied" }),
    );
    expect(line).toContain('steps=[fetch-workspace:succeeded,deploy-dcr:succeeded]');
    expect(line).toContain('error="HTTP 403 denied"');
  });
});

describe("buildSupportBundle", () => {
  it("renders the three sections with counts, platform k=v, job lines, and log lines", () => {
    const bundle = buildSupportBundle({
      entries: [
        entry({ message: "step succeeded", jobId: "job-1" }),
        entry({ level: "error", message: "deploy failed", jobId: "job-2" }),
      ],
      jobs: [job()],
      platformInfo: { shell: "cloud", version: "0.1.0", proxyBudget: 100 },
    });

    expect(bundle).toContain("=== SOC Optimization Toolkit support bundle ===");
    expect(bundle).toContain("--- Platform ---\nshell=cloud\nversion=0.1.0\nproxyBudget=100");
    expect(bundle).toContain("--- Recent jobs (1) ---\njob-1 kind=onboard-table");
    expect(bundle).toContain("--- Log entries (2) ---");
    expect(bundle).toContain(
      "2026-07-03T10:00:00.000Z [ERROR] [job:job-2] deploy failed",
    );
  });

  it("is deterministic: identical inputs produce identical bytes", () => {
    const input = {
      entries: [entry()],
      jobs: [job()],
      platformInfo: { shell: "local" },
    };
    expect(buildSupportBundle(input)).toBe(buildSupportBundle(input));
  });

  it("marks empty sections '(none)' instead of omitting them", () => {
    const bundle = buildSupportBundle({ entries: [], jobs: [], platformInfo: {} });
    expect(bundle).toContain("--- Platform ---\n(none)");
    expect(bundle).toContain("--- Recent jobs (0) ---\n(none)");
    expect(bundle).toContain("--- Log entries (0) ---\n(none)");
  });
});

// ---------------------------------------------------------------------------
// The hard rule, structurally: LogContext admits primitives ONLY
// ---------------------------------------------------------------------------

describe("LogContext secret-exclusion by construction", () => {
  it("accepts primitive values and rejects objects/arrays/undefined at compile time", () => {
    const good: LogContext = {
      table: "SecurityEvent",
      count: 3,
      enabled: true,
      cleared: null,
    };

    // @ts-expect-error - objects are not loggable context values (no config/credential passthrough)
    const objectContext: LogContext = { config: { clientSecret: "s3cret" } };
    // @ts-expect-error - arrays are not loggable context values
    const arrayContext: LogContext = { items: ["a", "b"] };
    // @ts-expect-error - undefined is not a loggable value; omit the key instead
    const undefinedContext: LogContext = { missing: undefined };
    // @ts-expect-error - functions are not loggable context values
    const functionContext: LogContext = { fn: () => "x" };

    expect(good.table).toBe("SecurityEvent");
    expect([objectContext, arrayContext, undefinedContext, functionContext])
      .toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// redactedLength (the one sanctioned reference to sensitive values)
// ---------------------------------------------------------------------------

describe("redactedLength", () => {
  it("returns the shape marker, never the value", () => {
    expect(redactedLength("hunter2secret")).toBe("<redacted:13chars>");
    expect(redactedLength("")).toBe("<redacted:0chars>");
    expect(redactedLength("xyzzy")).not.toContain("xyzzy");
  });
});
