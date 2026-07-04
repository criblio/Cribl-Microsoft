import { describe, expect, it } from "vitest";
import { filterLogEntries, formatLogLine } from "@soc/core";
import type { LogEntry } from "@soc/core";
import {
  LEVEL_FILTER_OPTIONS,
  RECENT_JOBS_LIMIT,
  SUPPORT_BUNDLE_FILENAME,
  buildLogFilter,
  logLineToEntry,
  parseLogLine,
} from "./logs-state";

// Input lines are built with the REAL @soc/core formatLogLine so any drift
// in the pinned line format fails HERE, not silently in the viewer.

describe("parseLogLine", () => {
  it("round-trips a plain entry: parse then re-format reproduces the line", () => {
    const entry: LogEntry = {
      timestamp: "2026-07-03T10:00:00.000Z",
      level: "info",
      message: "host started",
    };
    const line = formatLogLine(entry);
    const parsed = parseLogLine(line);
    expect(parsed).toEqual(entry);
    expect(formatLogLine(parsed as LogEntry)).toBe(line);
  });

  it("round-trips the job tag", () => {
    const entry: LogEntry = {
      timestamp: "2026-07-03T10:00:01.000Z",
      level: "error",
      message: "deploy failed",
      jobId: "3f2b6c1e-aaaa-bbbb-cccc-000000000001",
    };
    const line = formatLogLine(entry);
    const parsed = parseLogLine(line);
    expect(parsed).toEqual(entry);
  });

  it("folds rendered k=v context into the message and still round-trips the exact line", () => {
    const line = formatLogLine({
      timestamp: "2026-07-03T10:00:02.000Z",
      level: "warn",
      message: "arm request retried",
      context: { path: "/subscriptions", status: 401, quoted: "two words" },
    });
    const parsed = parseLogLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.level).toBe("warn");
    expect(parsed?.message).toBe(
      'arm request retried path=/subscriptions status=401 quoted="two words"',
    );
    expect(parsed?.context).toBeUndefined();
    expect(formatLogLine(parsed as LogEntry)).toBe(line);
  });

  it("round-trips an escaped-newline message", () => {
    const line = formatLogLine({
      timestamp: "2026-07-03T10:00:03.000Z",
      level: "debug",
      message: "first\nsecond",
    });
    const parsed = parseLogLine(line);
    // The escape is one-way by design: the parsed message keeps the literal
    // \n so re-formatting reproduces the stored line byte for byte.
    expect(parsed?.message).toBe("first\\nsecond");
    expect(formatLogLine(parsed as LogEntry)).toBe(line);
  });

  it("returns null for lines outside the pinned format", () => {
    expect(parseLogLine("SOC toolkit host listening on 127.0.0.1")).toBeNull();
    expect(parseLogLine("")).toBeNull();
    expect(
      parseLogLine("2026-07-03T10:00:00.000Z [NOPE ] not a level"),
    ).toBeNull();
  });
});

describe("logLineToEntry", () => {
  it("keeps unparseable lines visible as info entries carrying the raw line", () => {
    const entry = logLineToEntry("some banner line");
    expect(entry).toEqual({
      timestamp: "",
      level: "info",
      message: "some banner line",
    });
  });
});

describe("buildLogFilter", () => {
  it("'all' (and unknown values) means no level filter; blanks do not filter", () => {
    expect(buildLogFilter({ level: "all", jobId: "", text: "" })).toEqual({});
    expect(buildLogFilter({ level: "bogus", jobId: "  ", text: " " })).toEqual(
      {},
    );
  });

  it("maps set inputs onto the core LogFilter, trimming jobId and text", () => {
    expect(
      buildLogFilter({ level: "warn", jobId: " job-1 ", text: " dcr " }),
    ).toEqual({ level: "warn", jobId: "job-1", text: "dcr" });
  });

  it("integrates with core filterLogEntries over re-parsed host lines", () => {
    const lines = [
      formatLogLine({
        timestamp: "2026-07-03T10:00:00.000Z",
        level: "info",
        message: "api request",
        context: { path: "/api/config", status: 200 },
      }),
      formatLogLine({
        timestamp: "2026-07-03T10:00:01.000Z",
        level: "warn",
        message: "api request rejected",
        context: { path: "/api/jobs", status: 404 },
      }),
      "startup banner outside the format",
    ];
    const entries = lines.map(logLineToEntry);
    const warnPlus = filterLogEntries(
      entries,
      buildLogFilter({ level: "warn", jobId: "", text: "" }),
    );
    expect(warnPlus).toHaveLength(1);
    expect(warnPlus[0].message).toContain("api request rejected");
    const textMatch = filterLogEntries(
      entries,
      buildLogFilter({ level: "all", jobId: "", text: "BANNER" }),
    );
    expect(textMatch).toHaveLength(1);
  });
});

describe("constants", () => {
  it("exposes the bundle name, jobs limit, and level options", () => {
    expect(SUPPORT_BUNDLE_FILENAME).toBe("support-bundle.txt");
    expect(RECENT_JOBS_LIMIT).toBeGreaterThan(0);
    expect(LEVEL_FILTER_OPTIONS).toEqual([
      "all",
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });
});
