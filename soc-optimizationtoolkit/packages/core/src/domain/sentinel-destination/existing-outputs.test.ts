/**
 * Pins for the existing-Sentinel-destination read (GEN-21).
 *
 * The PAN-CSL fixture is the UAT group's one Sentinel destination, with every
 * identifying value replaced: ID endpoint configuration, a CUSTOM DCR stream
 * that names no table, a client id, and a secret held as a reference.
 */
import { describe, expect, it } from "vitest";
import { parseSentinelOutputs } from "./existing-outputs";

const KNOWN = ["CommonSecurityLog", "SecurityEvent", "MyApp_CL"];

const SECRET_VALUE = "s3cr3t-Value-That-Must-Not-Leak";
const SECRET_REF_NAME = "PAN-CSL_sentinel_secret_text";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const PAN_CSL = {
  id: "PAN-CSL",
  type: "sentinel",
  endpointURLConfiguration: "ID",
  dceEndpoint: "https://dce-example-eastus2.eastus2-1.ingest.monitor.azure.com",
  dcrID: "dcr-00000000000000000000000000000001",
  streamName: "Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream",
  client_id: `'${CLIENT_ID}'`,
  secret: `!{${SECRET_REF_NAME}}`,
  loginUrl: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
  scope: "https://monitor.azure.com/.default",
};

const S3 = { id: "Cribl_POV_S3_destination", type: "s3", bucket: "b" };
const DEVNULL = { id: "devnull", type: "devnull" };

function ok(items: unknown[]) {
  return { status: 200, body: { items, count: items.length } };
}

function rowsOf(result: ReturnType<typeof parseSentinelOutputs>) {
  if (result.status !== "read") throw new Error(`not read: ${result.reason}`);
  if (result.sentinel.kind !== "rows") {
    throw new Error(`listing kind ${result.sentinel.kind}`);
  }
  return result.sentinel.rows;
}

describe("parseSentinelOutputs - rows", () => {
  it("reads the ID-mode PAN-CSL shape exactly, with no table inferred from its custom stream", () => {
    expect(rowsOf(parseSentinelOutputs(ok([PAN_CSL]), KNOWN))).toEqual([
      {
        id: "PAN-CSL",
        mode: "ID",
        dcrID: "dcr-00000000000000000000000000000001",
        dceEndpoint:
          "https://dce-example-eastus2.eastus2-1.ingest.monitor.azure.com",
        streamName: "Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream",
        inferredTable: null,
        clientIdPresent: true,
        secretKind: "reference",
        status: null,
        variableBound: [],
      },
    ]);
  });

  it("reads a URL-mode destination's DCR, stream and endpoint out of the URL", () => {
    const urlMode = {
      id: "url-dest",
      type: "sentinel",
      endpointURLConfiguration: "url",
      url:
        "https://dcr-x.eastus-1.ingest.monitor.azure.com/dataCollectionRules/" +
        "dcr-0000000000000000000000000000000a/streams/Custom-SecurityEvent" +
        "?api-version=2021-11-01-preview",
      client_id: "''",
      secret: "<replace me>",
    };
    expect(rowsOf(parseSentinelOutputs(ok([urlMode]), KNOWN))).toEqual([
      {
        id: "url-dest",
        mode: "url",
        dcrID: "dcr-0000000000000000000000000000000a",
        dceEndpoint: "https://dcr-x.eastus-1.ingest.monitor.azure.com",
        streamName: "Custom-SecurityEvent",
        inferredTable: "SecurityEvent",
        clientIdPresent: false,
        secretKind: "placeholder",
        status: null,
        variableBound: [],
      },
    ]);
  });

  it("reads only the configured mode's half, never a leftover from the other", () => {
    // Cribl keeps the other mode's fields when the mode is switched, so a
    // URL-mode destination can still carry an old dcrID / streamName / DCE.
    const leftovers = {
      dcrID: "dcr-stale",
      streamName: "Custom-CommonSecurityLog",
      dceEndpoint: "https://stale.eastus-1.ingest.monitor.azure.com",
    };
    const url =
      "https://now.eastus-1.ingest.monitor.azure.com/dataCollectionRules/" +
      "dcr-now/streams/Custom-SecurityEvent";
    const rows = rowsOf(
      parseSentinelOutputs(
        ok([
          { id: "u", type: "sentinel", endpointURLConfiguration: "url", url, ...leftovers },
          { id: "i", type: "sentinel", endpointURLConfiguration: "ID", url },
          { id: "x", type: "sentinel", url },
        ]),
        KNOWN,
      ),
    );
    expect(
      rows.map((r) => [r.id, r.dcrID, r.streamName, r.dceEndpoint, r.inferredTable]),
    ).toEqual([
      ["u", "dcr-now", "Custom-SecurityEvent", "https://now.eastus-1.ingest.monitor.azure.com", "SecurityEvent"],
      // ID mode with only a URL: its own fields are missing, so nothing.
      ["i", null, null, null, null],
      // Unknown mode falls back to the URL.
      ["x", "dcr-now", "Custom-SecurityEvent", "https://now.eastus-1.ingest.monitor.azure.com", "SecurityEvent"],
    ]);
  });

  it("treats a variable-bound field as unknown, never as its literal", () => {
    const row = rowsOf(
      parseSentinelOutputs(
        ok([
          {
            ...PAN_CSL,
            id: "bound",
            streamName: "Custom-CommonSecurityLog",
            __template_streamName: "cribl.stream_var",
            __template_dcrID: "cribl.dcr_var",
            client_id: "''",
            __template_client_id: "cribl.client_var",
            secret: undefined,
            __template_secret: "cribl.secret_var",
          },
        ]),
        KNOWN,
      ),
    )[0];
    expect(row).toEqual({
      id: "bound",
      mode: "ID",
      dcrID: null,
      dceEndpoint:
        "https://dce-example-eastus2.eastus2-1.ingest.monitor.azure.com",
      streamName: null,
      inferredTable: null,
      clientIdPresent: true,
      secretKind: "reference",
      status: null,
      variableBound: ["dcrID", "streamName", "client_id", "secret"],
    });
    expect(JSON.stringify(row)).not.toContain("cribl.secret_var");
  });

  it("infers a table only from an exact known-table stream shape", () => {
    const dest = (id: string, streamName: string) => ({
      id,
      type: "sentinel",
      endpointURLConfiguration: "ID",
      streamName,
    });
    const rows = rowsOf(
      parseSentinelOutputs(
        ok([
          dest("a", "Custom-CommonSecurityLog"),
          dest("b", "Microsoft-CommonSecurityLog"),
          dest("c", "Custom-MyApp"),
          dest("d", "Custom-MyApp_CL"),
          dest("e", "Custom-commonsecuritylog"),
          dest("f", "Custom-Syslog"),
          dest("g", "Custom-CommonSecurityLog-stream"),
        ]),
        KNOWN,
      ),
    );
    expect(rows.map((r) => [r.id, r.inferredTable])).toEqual([
      ["a", "CommonSecurityLog"],
      ["b", "CommonSecurityLog"],
      ["c", "MyApp_CL"],
      ["d", "MyApp_CL"],
      ["e", null],
      ["f", null],
      ["g", null],
    ]);
  });

  it("refuses to pick between two known tables claiming one stream", () => {
    const rows = rowsOf(
      parseSentinelOutputs(
        ok([{ id: "x", type: "sentinel", streamName: "Custom-Foo" }]),
        ["Foo", "Foo_CL"],
      ),
    );
    expect(rows[0].inferredTable).toBeNull();
    expect(rows[0].mode).toBe("unknown");
  });

  it("names each secret kind without carrying any secret", () => {
    const base = { type: "sentinel", endpointURLConfiguration: "ID" };
    const rows = rowsOf(
      parseSentinelOutputs(
        ok([
          { ...base, id: "ref", secret: `!{${SECRET_REF_NAME}}` },
          { ...base, id: "text", textSecret: SECRET_REF_NAME },
          { ...base, id: "emb", secret: SECRET_VALUE },
          { ...base, id: "ph", secret: "<replace me>" },
          { ...base, id: "none" },
          { ...base, id: "blank", secret: "   " },
        ]),
        KNOWN,
      ),
    );
    expect(rows.map((r) => [r.id, r.secretKind])).toEqual([
      ["ref", "reference"],
      ["text", "reference"],
      ["emb", "embedded"],
      ["ph", "placeholder"],
      ["none", "absent"],
      ["blank", "absent"],
    ]);
  });

  it("never copies a secret value, a secret reference name, or the client id into the result", () => {
    const embedded = { ...PAN_CSL, id: "emb", secret: SECRET_VALUE };
    const text = { ...PAN_CSL, id: "txt", textSecret: SECRET_REF_NAME };
    const serialised = JSON.stringify(
      parseSentinelOutputs(ok([PAN_CSL, embedded, text]), KNOWN),
    );
    expect(serialised).not.toContain(SECRET_VALUE);
    expect(serialised).not.toContain(SECRET_REF_NAME);
    expect(serialised).not.toContain(CLIENT_ID);
    // And the rows really were read - an empty result would pass the above.
    expect(rowsOf(parseSentinelOutputs(ok([PAN_CSL, embedded, text]), KNOWN)))
      .toHaveLength(3);
  });

  it("reads a status when the listing carries one", () => {
    const rows = rowsOf(
      parseSentinelOutputs(
        ok([
          { ...PAN_CSL, id: "s1", status: "Live" },
          { ...PAN_CSL, id: "s2", status: { health: "Green" } },
        ]),
        KNOWN,
      ),
    );
    expect(rows.map((r) => r.status)).toEqual(["Live", "Green"]);
  });
});

describe("parseSentinelOutputs - inventory honesty", () => {
  it("keeps only type sentinel outputs", () => {
    const rows = rowsOf(
      parseSentinelOutputs(
        ok([S3, PAN_CSL, DEVNULL, { id: "azlogs", type: "azure_logs" }]),
        KNOWN,
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["PAN-CSL"]);
  });

  it("reports outputs read with no Sentinel one as a measured none", () => {
    expect(parseSentinelOutputs(ok([S3, DEVNULL]), KNOWN)).toEqual({
      status: "read",
      sentinel: { kind: "none" },
    });
  });

  it("reports an empty listing as an unverified empty, not none", () => {
    expect(parseSentinelOutputs(ok([]), KNOWN)).toEqual({
      status: "read",
      sentinel: { kind: "empty" },
    });
    // Items with no usable id are not a read of anything either.
    expect(
      parseSentinelOutputs(ok([{ type: "sentinel" }, null, "x"]), KNOWN),
    ).toEqual({ status: "read", sentinel: { kind: "empty" } });
  });

  it("never claims none while an item it could not read might be the Sentinel one", () => {
    expect(
      parseSentinelOutputs(ok([S3, DEVNULL, { type: "sentinel" }]), KNOWN),
    ).toEqual({ status: "read", sentinel: { kind: "empty" } });
    expect(parseSentinelOutputs(ok([S3, "x"]), KNOWN)).toEqual({
      status: "read",
      sentinel: { kind: "empty" },
    });
    // A row that WAS read is still offered beside an unreadable item.
    expect(
      rowsOf(parseSentinelOutputs(ok([PAN_CSL, { type: "sentinel" }]), KNOWN))
        .map((r) => r.id),
    ).toEqual(["PAN-CSL"]);
  });

  it("keeps the output id verbatim", () => {
    expect(
      rowsOf(parseSentinelOutputs(ok([{ ...PAN_CSL, id: " PAN-CSL" }]), KNOWN))
        .map((r) => r.id),
    ).toEqual([" PAN-CSL"]);
  });

  it("reports a failed read as failed, never as empty", () => {
    expect(parseSentinelOutputs({ status: 403, body: { items: [] } }, KNOWN))
      .toEqual({
        status: "failed",
        reason: "The outputs listing returned HTTP 403.",
      });
    expect(parseSentinelOutputs({ status: 200, body: "<html>" }, KNOWN))
      .toEqual({
        status: "failed",
        reason: "The outputs listing was not an {items: [...]} response.",
      });
    expect(parseSentinelOutputs({ status: 200, body: [PAN_CSL] }, KNOWN).status)
      .toBe("failed");
  });
});
