/**
 * Pins for the existing-destination path's pure decisions (GEN-21, DBT-200,
 * DBT-201). The screen that uses them cannot reach its build in a mount - it
 * needs an approved gap analysis - so what the picker, the gate and the route
 * say is pinned here, against the UAT's shapes.
 */

import { describe, expect, it } from "vitest";
import type { SentinelOutputRow } from "@soc/core";
import {
  captureGroupDefault,
  describeOutputRow,
  existingDestinationForArc,
  existingDestinationGateReason,
  existingDestinationRoute,
  existingPickerView,
  expectedPackId,
  ingestionClientIdHint,
  initialDestinationMode,
  sourceRouting,
  sourceRoutingNotice,
  tablePick,
} from "./existing-destination-state";
import type { ExistingPickerView } from "./existing-destination-state";

const GROUP = "TMNA_POV";
const STREAM = "Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream";
const SECRET_REF = "!{pan_csl_secret}";

/** The UAT's hand-built destination: ID mode, a custom stream, a secret reference. */
const PAN_CSL = {
  id: "PAN-CSL",
  type: "sentinel",
  endpointURLConfiguration: "ID",
  dcrID: "dcr-0123456789abcdef0123456789abcdef",
  dceEndpoint: "https://dce.eastus-1.ingest.monitor.azure.com",
  streamName: STREAM,
  client_id: "'11111111-2222-3333-4444-555555555555'",
  secret: SECRET_REF,
};

/** A destination whose stream IS CommonSecurityLog's. */
const CSL_NATIVE = {
  ...PAN_CSL,
  id: "CSL-native",
  streamName: "Microsoft-CommonSecurityLog",
};

const S3 = { id: "S3", type: "s3" };

function done(items: unknown[], status = 200): ExistingPickerView {
  return existingPickerView(
    { state: "done", groupId: GROUP, response: { status, body: { items } } },
    ["CommonSecurityLog"],
    GROUP,
  );
}

function rowOf(view: ExistingPickerView, id: string): SentinelOutputRow {
  const row = view.rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
}

describe("initialDestinationMode (GEN-21 F2-c)", () => {
  it("opens on the existing destination offline, and on create when connected", () => {
    expect(initialDestinationMode(true)).toBe("existing");
    expect(initialDestinationMode(false)).toBe("create");
  });
});

describe("existingPickerView - every listing state has its own sentence", () => {
  it("not read yet", () => {
    const view = existingPickerView({ state: "idle" }, [], GROUP);
    expect(view.kind).toBe("idle");
    expect(view.text).toBe(
      "Not read yet - select a worker group in this section to read its destinations.",
    );
  });

  it("reading", () => {
    const view = existingPickerView({ state: "loading", groupId: GROUP }, [], GROUP);
    expect(view.kind).toBe("loading");
    expect(view.text).toBe("Reading TMNA_POV's destinations...");
  });

  it("a read held from the PREVIOUS group is never this group's listing", () => {
    // The render between a group change and the effect that re-reads still
    // holds the old group's rows; they must not satisfy this group's picker.
    const old = {
      state: "done" as const,
      groupId: "default",
      response: { status: 200, body: { items: [PAN_CSL] } },
    };
    const view = existingPickerView(old, ["CommonSecurityLog"], GROUP);
    expect(view.kind).toBe("loading");
    expect(view.text).toBe("Reading TMNA_POV's destinations...");
    expect(view.rows).toEqual([]);
    expect(view.outputIds).toEqual([]);
    // No group selected now: not read, rather than reading nothing.
    expect(existingPickerView(old, [], "").kind).toBe("idle");
  });

  it("a non-2xx is FAILED, never an empty group", () => {
    const view = done([], 403);
    expect(view.kind).toBe("failed");
    expect(view.text).toBe(
      "Could not read TMNA_POV's destinations: The outputs listing returned HTTP 403. " +
        "Nothing is known about which Sentinel destinations it has - read again before deciding there are none.",
    );
    expect(view.rows).toEqual([]);
  });

  it("a thrown request is FAILED with its reason", () => {
    const view = existingPickerView(
      { state: "error", groupId: GROUP, error: "network down" },
      [],
      GROUP,
    );
    expect(view.kind).toBe("failed");
    expect(view.text).toMatch(/^Could not read TMNA_POV's destinations: network down /);
  });

  it("an empty listing is UNVERIFIED, not none", () => {
    const view = done([]);
    expect(view.kind).toBe("empty");
    expect(view.text).toBe(
      "TMNA_POV listed no destinations this app could read. A Cribl role that cannot " +
        "see a group's destinations receives exactly this, so it is not confirmation " +
        "that TMNA_POV has none.",
    );
  });

  it("outputs read and none Sentinel is a MEASURED none, with the count read", () => {
    const view = done([S3]);
    expect(view.kind).toBe("none");
    expect(view.text).toBe(
      "TMNA_POV has 1 destination, and none is a Microsoft Sentinel destination. " +
        "Create one in Cribl and read again, or let Deploy create one.",
    );
    expect(view.outputIds).toEqual(["S3"]);
  });

  it("rows: only the Sentinel destinations, every output id kept for the check", () => {
    const view = done([S3, PAN_CSL]);
    expect(view.kind).toBe("rows");
    expect(view.text).toBe("1 Microsoft Sentinel destination in TMNA_POV.");
    expect(view.rows.map((r) => r.id)).toEqual(["PAN-CSL"]);
    expect(view.outputIds).toEqual(["S3", "PAN-CSL"]);
  });
});

describe("describeOutputRow - id, stream, DCR; never a credential", () => {
  it("shows the UAT destination's stream and DCR", () => {
    const text = describeOutputRow(rowOf(done([PAN_CSL]), "PAN-CSL"));
    expect(text).toBe(
      `PAN-CSL - stream ${STREAM}, DCR dcr-0123456789abcdef0123456789abcdef`,
    );
    expect(text).not.toContain(SECRET_REF);
    expect(text).not.toContain("11111111-2222");
  });

  it("names a variable-bound stream instead of showing a literal it overrides", () => {
    const view = done([{ ...PAN_CSL, __template_streamName: "pan_stream" }]);
    expect(describeOutputRow(rowOf(view, "PAN-CSL"))).toBe(
      "PAN-CSL - stream (set by a Cribl variable), DCR dcr-0123456789abcdef0123456789abcdef",
    );
  });
});

describe("tablePick - the operator confirms what the stream cannot say", () => {
  const view = done([PAN_CSL, CSL_NATIVE]);

  it("a custom stream needs a confirmation that names the stream", () => {
    const pick = tablePick("CommonSecurityLog", "PAN-CSL", "", view.rows);
    expect(pick.needsConfirm).toBe(true);
    expect(pick.confirmed).toBe(false);
    expect(pick.prompt).toBe(
      `PAN-CSL sends to stream ${STREAM}, which does not name a table, so the app ` +
        "cannot tell which table it feeds. Confirm that its Data Collection Rule " +
        "writes CommonSecurityLog.",
    );
  });

  it("the confirmation counts only for the destination it was given for", () => {
    expect(tablePick("CommonSecurityLog", "PAN-CSL", "PAN-CSL", view.rows).confirmed).toBe(true);
    expect(tablePick("CommonSecurityLog", "PAN-CSL", "CSL-native", view.rows).confirmed).toBe(false);
  });

  it("a stream that IS the table's needs no confirmation", () => {
    const pick = tablePick("CommonSecurityLog", "CSL-native", "", view.rows);
    expect(pick.needsConfirm).toBe(false);
    expect(pick.confirmed).toBe(true);
    expect(pick.prompt).toBeNull();
  });

  it("another table's stream asks, and says whose stream it is", () => {
    const pick = tablePick("Syslog", "CSL-native", "", view.rows);
    expect(pick.needsConfirm).toBe(true);
    expect(pick.prompt).toBe(
      "CSL-native sends to stream Microsoft-CommonSecurityLog, which is " +
        "CommonSecurityLog's stream, not Syslog's. Confirm only if its Data " +
        "Collection Rule turns it into Syslog.",
    );
  });

  it("no pick, or a pick the listing no longer has, is no row", () => {
    expect(tablePick("CommonSecurityLog", "", "", view.rows).row).toBeNull();
    expect(tablePick("CommonSecurityLog", "gone", "", view.rows).row).toBeNull();
  });
});

describe("existingDestinationGateReason - one unlock condition, never Azure's", () => {
  const view = done([S3, PAN_CSL, CSL_NATIVE]);
  const base = {
    groupId: GROUP,
    tables: ["CommonSecurityLog"],
    view,
    chosen: {},
    confirmed: {},
  };
  const reasons: Array<string | null> = [];
  const gate = (over: Partial<typeof base> & Record<string, unknown>) => {
    const reason = existingDestinationGateReason({ ...base, ...over });
    reasons.push(reason);
    return reason;
  };

  it("walks the path in order and opens once the pick is confirmed", () => {
    expect(gate({ groupId: "" })).toBe(
      "Select a worker group in Configure Cribl - the existing destination is read from it.",
    );
    expect(gate({ tables: [] })).toBe(
      "Run the DCR Gap Analysis (section 3) - its tables decide what the existing destination must feed.",
    );
    expect(gate({ view: done([], 500) })).toMatch(
      /^No Sentinel destination to pick in TMNA_POV yet: Could not read TMNA_POV's destinations/,
    );
    expect(gate({})).toBe(
      "Pick an existing Sentinel destination for CommonSecurityLog in Configure Cribl.",
    );
    expect(gate({ chosen: { CommonSecurityLog: "PAN-CSL" } })).toBe(
      "Confirm in Configure Cribl that PAN-CSL feeds CommonSecurityLog.",
    );
    expect(
      gate({
        chosen: { CommonSecurityLog: "PAN-CSL" },
        confirmed: { CommonSecurityLog: "PAN-CSL" },
      }),
    ).toBeNull();
    expect(gate({ chosen: { CommonSecurityLog: "CSL-native" } })).toBeNull();
  });

  it("refuses two destinations for one routable pack", () => {
    expect(
      gate({
        tables: ["CommonSecurityLog", "Syslog"],
        chosen: { CommonSecurityLog: "CSL-native", Syslog: "PAN-CSL" },
        confirmed: { Syslog: "PAN-CSL" },
      }),
    ).toBe(
      "Pick the same destination for every table: the routable pack hands all its " +
        "events back to one group route, and one route sends to one destination.",
    );
  });

  it("reports a pick the latest listing no longer has", () => {
    expect(gate({ chosen: { CommonSecurityLog: "PAN-CSL-old" } })).toBe(
      "PAN-CSL-old, chosen for CommonSecurityLog, is not in TMNA_POV's latest listing - pick again in Configure Cribl.",
    );
  });

  it("never asks for a client id, a scope or a directory", () => {
    // Every reason the three tests above produced (they run first, in order).
    const said = reasons.filter((r): r is string => r !== null);
    expect(said).toHaveLength(7);
    for (const reason of said) {
      expect(reason).not.toMatch(/client id|scope|directory|subscription/i);
    }
  });
});

describe("existingDestinationForArc", () => {
  it("is set only on the existing path with every table picked", () => {
    const chosen = { CommonSecurityLog: "PAN-CSL" };
    expect(existingDestinationForArc("create", ["CommonSecurityLog"], chosen)).toBeUndefined();
    expect(existingDestinationForArc("existing", [], chosen)).toBeUndefined();
    expect(
      existingDestinationForArc("existing", ["CommonSecurityLog", "Syslog"], chosen),
    ).toBeUndefined();
    expect(existingDestinationForArc("existing", ["CommonSecurityLog"], chosen)).toBe("PAN-CSL");
  });
});

describe("existingDestinationRoute - the route to copy", () => {
  it("sends the syslog source through the pack to the picked destination", () => {
    expect(
      existingDestinationRoute({
        source: { type: "syslog", id: "in_syslog" },
        packId: "uat-panos-offline",
        destinationId: "PAN-CSL",
      }),
    ).toEqual({
      id: "uat-panos-offline_in_syslog",
      name: "in_syslog to PAN-CSL via uat-panos-offline",
      filter: "__inputId.startsWith('syslog:in_syslog:')",
      pipeline: "pack:uat-panos-offline",
      output: "PAN-CSL",
      final: true,
      description:
        "Sends in_syslog through pack uat-panos-offline to the existing Sentinel destination PAN-CSL.",
    });
  });
});

describe("expectedPackId - the id the route names before install", () => {
  it("is the id the install pins, not the typed name", () => {
    expect(expectedPackId("uat-panos-offline")).toBe("uat-panos-offline");
    // Cribl's id does not keep a space or a slash: the build writes "-".
    expect(expectedPackId(" Palo Alto/PAN-OS ")).toBe("Palo-Alto-PAN-OS");
    // A name that itself ends in a version-like suffix keeps it.
    expect(expectedPackId("pan_2")).toBe("pan_2");
  });
});

describe("sourceRouting - a QuickConnected source never reaches a route", () => {
  it("reads the UAT shape: in_syslog QuickConnected to S3", () => {
    const routing = sourceRouting({
      status: 200,
      body: {
        items: [
          {
            id: "in_syslog",
            type: "syslog",
            sendToRoutes: false,
            connections: [{ output: "S3", pipeline: "passthru" }],
          },
        ],
      },
    });
    expect(routing).toEqual({ kind: "quickconnect", outputs: ["S3"] });
    expect(sourceRoutingNotice("in_syslog", routing)).toBe(
      "in_syslog is QuickConnected (to S3), so it does not send to routes: this " +
        "route will not fire until the source is switched to send to routes. The " +
        "app does not change the source's QuickConnect flow.",
    );
  });

  it("a source that sends to routes needs no warning", () => {
    const routing = sourceRouting({
      status: 200,
      body: { items: [{ id: "in_syslog", type: "syslog" }] },
    });
    expect(routing).toEqual({ kind: "routes" });
    expect(sourceRoutingNotice("in_syslog", routing)).toBeNull();
  });

  it("a failed read is unknown, and says so rather than staying silent", () => {
    const routing = sourceRouting({ status: 403, body: {} });
    expect(routing).toEqual({
      kind: "unknown",
      reason: "Cribl returned HTTP 403 reading the source.",
    });
    expect(sourceRoutingNotice("in_syslog", routing)).toBe(
      "Could not tell whether in_syslog sends to routes (Cribl returned HTTP 403 " +
        "reading the source.) - check that it is not QuickConnected before relying on this route.",
    );
  });

  it("a 200 that holds no source is unknown, not a source that sends to routes (GEN-28)", () => {
    expect(sourceRouting({ status: 200, body: { items: [] } })).toEqual({
      kind: "unknown",
      reason: "The source read did not hold a source.",
    });
  });
});

describe("ingestionClientIdHint (DBT-200)", () => {
  it("promises a default only when an identity is connected", () => {
    expect(ingestionClientIdHint(true)).toBe("Defaults to the active connection.");
    expect(ingestionClientIdHint(false)).toBe(
      "No Azure identity is connected, so there is no default - enter the app registration's client id.",
    );
  });
});

describe("captureGroupDefault (DBT-201)", () => {
  const live = ["default", "TMNA_POV"];

  it("moves the pack to the capture group when it is listed and untouched", () => {
    expect(
      captureGroupDefault({ liveGroupIds: live, captureGroup: "TMNA_POV", current: "default", touched: false }),
    ).toBe("TMNA_POV");
  });

  it("never over the operator's pick, an unlisted group, or no capture", () => {
    expect(
      captureGroupDefault({ liveGroupIds: live, captureGroup: "TMNA_POV", current: "default", touched: true }),
    ).toBeNull();
    expect(
      captureGroupDefault({ liveGroupIds: ["default"], captureGroup: "TMNA_POV", current: "default", touched: false }),
    ).toBeNull();
    expect(
      captureGroupDefault({ liveGroupIds: live, captureGroup: undefined, current: "default", touched: false }),
    ).toBeNull();
    expect(
      captureGroupDefault({ liveGroupIds: live, captureGroup: "default", current: "default", touched: false }),
    ).toBeNull();
  });
});
