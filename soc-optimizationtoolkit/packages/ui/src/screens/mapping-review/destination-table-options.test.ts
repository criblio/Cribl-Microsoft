/**
 * Pins for the Destination table override's options (DBT-250): the schema
 * repository and bundled tables are offered whether or not Azure can be read,
 * and "not in workspace" is said only when the workspace was actually read.
 */

import { describe, expect, it } from "vitest";
import {
  NOT_IN_WORKSPACE_HINT,
  absentTableNote,
  destinationTableOptions,
  workspacePresence,
  type DestinationTableSources,
} from "./destination-table-options";

const COMMON = ["CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent"];

function sources(over: Partial<DestinationTableSources>): DestinationTableSources {
  return {
    resolved: [],
    reported: [],
    common: COMMON,
    repo: [],
    bundled: [],
    workspace: [],
    workspaceVerified: false,
    ...over,
  };
}

describe("destinationTableOptions", () => {
  it("offers the schema-repo and bundled tables with NO workspace read (the four-table regression)", () => {
    const options = destinationTableOptions(
      sources({
        repo: ["Cloudflare_CL", "ASimDnsActivityLogs"],
        bundled: ["SecurityEvent", "AzureDiagnostics"],
      }),
    );
    expect(options.map((o) => o.value)).toEqual([
      "ASimDnsActivityLogs",
      "AzureDiagnostics",
      "Cloudflare_CL",
      "CommonSecurityLog",
      "SecurityEvent",
      "Syslog",
      "WindowsEvent",
    ]);
    // Unreadable workspace: nothing is flagged, everything stays selectable.
    expect(options.every((o) => o.presence === "unknown")).toBe(true);
    expect(options.filter((o) => o.hint !== undefined)).toHaveLength(0);
  });

  it("flags exactly the tables a READ workspace does not contain", () => {
    const options = destinationTableOptions(
      sources({
        repo: ["Cloudflare_CL", "ASimDnsActivityLogs"],
        workspace: ["CommonSecurityLog", "syslog", "Cloudflare_CL"],
        workspaceVerified: true,
      }),
    );
    const absent = options.filter((o) => o.presence === "absent").map((o) => o.value);
    expect(absent).toEqual(["ASimDnsActivityLogs", "SecurityEvent", "WindowsEvent"]);
    expect(options.filter((o) => o.hint === NOT_IN_WORKSPACE_HINT)).toHaveLength(3);
    expect(options.filter((o) => o.presence === "present")).toHaveLength(3);
  });

  it("dedupes case-insensitively and keeps the workspace's spelling", () => {
    const options = destinationTableOptions(
      sources({
        common: ["Syslog"],
        repo: ["SYSLOG"],
        workspace: ["syslog"],
        workspaceVerified: true,
      }),
    );
    expect(options.map((o) => o.value)).toEqual(["syslog"]);
  });

  it("treats an empty verified listing as unknown, never as 'everything missing'", () => {
    const options = destinationTableOptions(
      sources({ repo: ["Cloudflare_CL"], workspace: [], workspaceVerified: true }),
    );
    expect(options.every((o) => o.presence === "unknown")).toBe(true);
  });

  it("drops blank names", () => {
    const options = destinationTableOptions(sources({ common: [], repo: ["", "A"] }));
    expect(options.map((o) => o.value)).toEqual(["A"]);
  });
});

describe("workspacePresence", () => {
  it("is unknown until the workspace was read", () => {
    expect(workspacePresence("Syslog", ["Syslog"], false)).toBe("unknown");
    expect(workspacePresence("Syslog", ["SYSLOG"], true)).toBe("present");
    expect(workspacePresence("Foo_CL", ["Syslog"], true)).toBe("absent");
  });
});

describe("absentTableNote", () => {
  it("names the table and says the pack can still be built", () => {
    const note = absentTableNote("Foo_CL");
    expect(note).toContain("Foo_CL is not in this workspace");
    expect(note).toContain("pack can still be built");
  });
});
