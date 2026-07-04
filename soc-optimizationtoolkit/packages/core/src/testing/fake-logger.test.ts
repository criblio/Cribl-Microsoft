import { describe, expect, it } from "vitest";

import { FakeLogger } from "./fake-logger";

function tickingClock(): () => string {
  let tick = 0;
  return () => `2026-07-03T10:00:0${tick++}.000Z`;
}

describe("FakeLogger", () => {
  it("records full entries in call order with injected-clock timestamps", () => {
    const logger = new FakeLogger(tickingClock());

    logger.debug("first");
    logger.info("second", { table: "SecurityEvent" });
    logger.warn("third", undefined, "job-1");
    logger.error("fourth", { code: 403 }, "job-1");

    expect(logger.entries).toEqual([
      { timestamp: "2026-07-03T10:00:00.000Z", level: "debug", message: "first" },
      {
        timestamp: "2026-07-03T10:00:01.000Z",
        level: "info",
        message: "second",
        context: { table: "SecurityEvent" },
      },
      {
        timestamp: "2026-07-03T10:00:02.000Z",
        level: "warn",
        message: "third",
        jobId: "job-1",
      },
      {
        timestamp: "2026-07-03T10:00:03.000Z",
        level: "error",
        message: "fourth",
        context: { code: 403 },
        jobId: "job-1",
      },
    ]);
  });

  it("copies context defensively: later mutation does not rewrite history", () => {
    const logger = new FakeLogger(tickingClock());
    const context = { count: 1 };

    logger.info("counted", context);
    context.count = 99;

    expect(logger.entries[0].context).toEqual({ count: 1 });
  });

  it("messagesAt returns the messages of one level only", () => {
    const logger = new FakeLogger(tickingClock());
    logger.info("a");
    logger.error("b");
    logger.info("c");

    expect(logger.messagesAt("info")).toEqual(["a", "c"]);
    expect(logger.messagesAt("error")).toEqual(["b"]);
    expect(logger.messagesAt("warn")).toEqual([]);
  });

  it("defaults to a real ISO timestamp when no clock is injected", () => {
    const logger = new FakeLogger();
    logger.info("now");
    const timestamp = logger.entries[0].timestamp;
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });
});
