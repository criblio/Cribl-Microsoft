/**
 * Pins for the per-log-type route discriminators (live flaw 2026-07-13: a
 * Zscaler pack shipped two match-all final routes - web-BLOCKED swallowed
 * everything and firewall was unreachable).
 */

import { describe, expect, it } from "vitest";
import { deriveRouteDiscriminator } from "./route-discriminator";

const others = (...fields: string[]): Array<ReadonlySet<string>> => [
  new Set(fields.map((f) => f.toLowerCase())),
];

describe("deriveRouteDiscriminator", () => {
  it("builds presence + raw-token terms from fields unique to this log type", () => {
    const filter = deriveRouteDiscriminator(
      ["act", "requestClientApplication", "src"],
      others("act", "src", "proto"),
      "cef",
    );
    expect(filter).toBe(
      "requestClientApplication !== undefined || " +
        "(typeof _raw === 'string' && _raw.indexOf('requestClientApplication=') !== -1)",
    );
  });

  it("quotes JSON keys in the raw token", () => {
    const filter = deriveRouteDiscriminator(["nwapp"], others("url"), "json");
    expect(filter).toContain(`_raw.indexOf('"nwapp"')`);
  });

  it("caps at two unique fields, longest first, deterministically", () => {
    const filter = deriveRouteDiscriminator(
      ["aa", "bb", "long_field_name", "cc"],
      others("shared"),
      "kv",
    );
    expect(filter).toContain("long_field_name !== undefined");
    // Ties broken alphabetically: aa is the second pick; bb/cc dropped by cap.
    expect(filter).toContain("aa !== undefined");
    expect(filter).not.toContain("bb");
    expect(filter).not.toContain("cc");
  });

  it("compares uniqueness case-insensitively and skips blank sources", () => {
    expect(
      deriveRouteDiscriminator(["ACT", ""], others("act"), "cef"),
    ).toBeNull();
  });

  it("emits only the raw term for a non-identifier field name", () => {
    const filter = deriveRouteDiscriminator(
      ["user.name"],
      others("other"),
      "kv",
    );
    expect(filter).toBe(
      "(typeof _raw === 'string' && _raw.indexOf('user.name=') !== -1)",
    );
  });

  it("returns null for CSV (positional rows carry no field names)", () => {
    expect(
      deriveRouteDiscriminator(["unique_col"], others("other"), "csv"),
    ).toBeNull();
  });

  /**
   * THE SAME RULE, THE OTHER COLUMN-ORDER FORMAT (GEN-6 fallout, 2026-09-03).
   *
   * `formatCanDiscriminate` tested only `!== "csv"`, so a whitespace-positional
   * plan came through here and got a filter. Measured on a two-log-type
   * positional plan built through the real chain, the emitted route read
   * `interface_id !== undefined || (typeof _raw === 'string' &&
   * _raw.indexOf('interface_id=') !== -1) || account_id ...`. Both names are
   * minted from a COLUMN POSITION by the pipeline's extract step, and the route
   * runs before it - so every disjunct is false for every event and the route
   * dead-ends. It was worse than the CSV case above rather than equal to it: a
   * filter existed, so the log type was neither a placeholder nor "unreachable"
   * and the pack previewed clean.
   */
  it("returns null for positional (whitespace columns carry no field names)", () => {
    expect(
      deriveRouteDiscriminator(
        ["interface_id", "account_id"],
        others("field1"),
        "positional",
      ),
    ).toBeNull();
  });

  it("...and the SAME fields on a routable format still produce a filter", () => {
    // The control, without which the null above would pass for any reason at
    // all - an empty unique set, a rejected name, a typo in the fixture.
    expect(
      deriveRouteDiscriminator(
        ["interface_id", "account_id"],
        others("field1"),
        "cef",
      ),
    ).toContain("interface_id !== undefined");
  });

  /**
   * SYSLOG, THE THIRD WHOLE FORMAT (GEN-8, 2026-09-04).
   *
   * parseSyslog names its fields from a regex capture, so Timestamp, Hostname,
   * Program, PID and Message appear nowhere in the line, and the only key it
   * copies verbatim - `_raw` - is carried by every syslog log type in the pack.
   * Both terms this function emits are therefore false for every event.
   */
  it("returns null for syslog (regex captures carry no field names)", () => {
    expect(
      deriveRouteDiscriminator(
        ["Program", "Hostname", "PID"],
        others("Message"),
        "syslog",
      ),
    ).toBeNull();
  });

  it("...and the SAME syslog field names on a routable format still produce a filter", () => {
    // The control. Without it the null above passes for any reason at all -
    // and these names are not CEF headers, so nothing but the format gate can
    // account for it.
    expect(
      deriveRouteDiscriminator(
        ["Program", "Hostname", "PID"],
        others("Message"),
        "kv",
      ),
    ).toContain("Hostname !== undefined");
  });

  it("escapes quotes and backslashes in the raw token", () => {
    const filter = deriveRouteDiscriminator(
      ["odd'field"],
      others("other"),
      "kv",
    );
    expect(filter).toContain("_raw.indexOf('odd\\'field=')");
  });
});

/**
 * A unique field is not automatically a CHARACTERISTIC field.
 *
 * Measured live on PaloAlto-PAN-OS (2026-08-17). The Cortex XDR alert sample
 * carries per-event ids as column names - base64 blobs like
 * `MTE5MDE2NDc3NjI4OTI4MjgwMw`, one per event across 106 events. Every one was
 * unique to that log type, and every one was longer than any real field name,
 * so the length-first sort preferred them. The emitted route tested
 * `MTE5MDE2NDc3NjI4OTI4MjgwMw !== undefined`: it matches the single sampled
 * event and nothing whatsoever in live traffic, so the route builds, validates,
 * installs, and silently receives nothing.
 *
 * The value discriminator has always rejected per-event data (its "constant
 * within the log type" guard). The presence path could not, because it only
 * ever saw field NAMES. These pin it now that it sees the evidence too.
 */
describe("deriveRouteDiscriminator - unique is not the same as characteristic", () => {
  /** Two events; the ids appear once each, the real field in both. */
  const XDR_EVIDENCE = {
    logType: "Palo Alto_Cortex XDR_AlertEvent",
    eventCount: 2,
    values: {
      alert_source: ["XDR", "XDR"],
      MTE5MDE2NDc3NjI4OTI4MjgwMw: ["1"],
      MTYwMDg5MzM3ODI2NjEzMzI5MA: ["1"],
    },
  };
  const FIELDS = [
    "alert_source",
    "MTE5MDE2NDc3NjI4OTI4MjgwMw",
    "MTYwMDg5MzM3ODI2NjEzMzI5MA",
  ];

  it("refuses a field that only ONE event carried", () => {
    // The live defect. Both ids are unique to this log type and both are
    // longer than alert_source, so without the evidence they win outright.
    const filter =
      deriveRouteDiscriminator(FIELDS, [new Set(["dst"])], "json", XDR_EVIDENCE) ?? "";
    expect(filter).toContain("alert_source");
    expect(filter).not.toContain("MTE5MDE2NDc3NjI4OTI4MjgwMw");
    expect(filter).not.toContain("MTYwMDg5MzM3ODI2NjEzMzI5MA");
  });

  it("returns null when EVERY unique field is per-event", () => {
    // Nothing characteristic is left, so the caller placeholders the log type
    // rather than shipping a route that matches one sampled event.
    const idsOnly = {
      logType: "Palo Alto_Cortex XDR_AlertEvent",
      eventCount: 2,
      values: {
        MTE5MDE2NDc3NjI4OTI4MjgwMw: ["1"],
        MTYwMDg5MzM3ODI2NjEzMzI5MA: ["1"],
      },
    };
    expect(
      deriveRouteDiscriminator(
        ["MTE5MDE2NDc3NjI4OTI4MjgwMw", "MTYwMDg5MzM3ODI2NjEzMzI5MA"],
        [new Set(["dst"])],
        "json",
        idsOnly,
      ),
    ).toBeNull();
  });

  it("keeps a field present in every event, however ordinary its name", () => {
    // The guard must not become a name heuristic - short, plain names are
    // exactly what a real discriminator looks like.
    const evidence = {
      logType: "TRAFFIC",
      eventCount: 3,
      values: { chunks_received: ["1", "2", "3"], sid: ["a"] },
    };
    const filter =
      deriveRouteDiscriminator(
        ["chunks_received", "sid"],
        [new Set(["dst"])],
        "json",
        evidence,
      ) ?? "";
    expect(filter).toContain("chunks_received");
    expect(filter).not.toContain("sid !== undefined");
  });

  it("still works when the caller supplies NO evidence", () => {
    // Callers without sample values keep the older presence-only behaviour;
    // losing routing entirely would be a worse trade than the weaker check.
    const filter =
      deriveRouteDiscriminator(["alert_source"], [new Set(["dst"])], "json") ?? "";
    expect(filter).toContain("alert_source");
  });
});

/**
 * GEN-8, per-field half: a CEF or LEEF HEADER name is not a candidate, while
 * the extension pairs beside it still are.
 *
 * THE SORT IS WHY THIS WAS SILENT RATHER THAN RARE. This function ranks longest
 * name first, and every CEF header name is longer than the `src` / `dst` / `act`
 * a firewall event actually carries. The character counts are stated once, on
 * the sort itself in route-discriminator.ts, and are not repeated here: three
 * copies of them had already drifted apart by 2026-09-04, one of them calling
 * `_syslogHeader` 14 characters. So on any CEF plan where a header was unique
 * to one log type, the header WON, and the filter it produced was false for
 * every event. Measured through the real chain on 2026-09-04: a two-log-type
 * CEF plan where only one type's lines had a syslog prefix emitted
 * `_syslogHeader !== undefined || (typeof _raw === 'string' &&
 * _raw.indexOf('_syslogHeader=') !== -1)` and matched 0 of that type's 2 own
 * events, while its sibling's `fwrule` - a real extension pair - matched 2 of 2.
 */
describe("deriveRouteDiscriminator - CEF and LEEF header names are not candidates", () => {
  it("prefers a SHORT extension field over the long header names", () => {
    const filter =
      deriveRouteDiscriminator(
        ["DeviceEventClassID", "_syslogHeader", "act"],
        [new Set(["src"])],
        "cef",
      ) ?? "";

    expect(filter).toContain("act !== undefined");
    expect(filter).not.toContain("DeviceEventClassID");
    expect(filter).not.toContain("_syslogHeader");
  });

  it("returns null when the ONLY unique fields are CEF headers", () => {
    // The log type then placeholders and is reported, instead of shipping a
    // route that reads clean and receives nothing.
    expect(
      deriveRouteDiscriminator(
        ["DeviceEventClassID", "Name", "Severity", "_syslogHeader"],
        [new Set(["src"])],
        "cef",
      ),
    ).toBeNull();
  });

  it("...and the SAME names on a format with no CEF header still route", () => {
    // The control that makes the null above about the exclusion rather than
    // about the fixture. A kv event that really sends `DeviceEventClassID=...`
    // carries that name in its text, so the term can fire and is kept.
    expect(
      deriveRouteDiscriminator(
        ["DeviceEventClassID", "Name", "Severity", "_syslogHeader"],
        [new Set(["src"])],
        "kv",
      ),
    ).toContain("DeviceEventClassID !== undefined");
  });

  it("does the same for LEEF, whose header list differs from CEF's", () => {
    const filter =
      deriveRouteDiscriminator(
        ["EventID", "LEEFVersion", "usrName"],
        [new Set(["src"])],
        "leef",
      ) ?? "";

    expect(filter).toContain("usrName !== undefined");
    expect(filter).not.toContain("EventID");
    expect(filter).not.toContain("LEEFVersion");
  });

  it("keeps _syslogHeader for LEEF, which never mints one", () => {
    // parseLeef assigns no syslog-prefix key, so excluding the name there would
    // cost a vendor who genuinely sends `_syslogHeader=` as a tab-delimited
    // pair - a name that IS in their raw text.
    expect(
      deriveRouteDiscriminator(["_syslogHeader"], [new Set(["src"])], "leef"),
    ).toContain("_syslogHeader !== undefined");
  });

  it("leaves every ordinary CEF extension field alone", () => {
    // The exclusion must not become "CEF cannot route". These are the fields
    // real CEF packs discriminate on, and all of them are in the raw text.
    for (const field of ["act", "suser", "requestClientApplication", "cs6"]) {
      expect(
        deriveRouteDiscriminator([field], [new Set(["src"])], "cef"),
        field,
      ).toContain(`${field} !== undefined`);
    }
  });
});
