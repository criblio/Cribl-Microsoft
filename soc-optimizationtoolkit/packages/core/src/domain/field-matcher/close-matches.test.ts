/**
 * Pins for the close-match suggester (user request 2026-07-09). The founding
 * case is real: Zscaler web logs carry the URL only base64-encoded as
 * `b64url` - the MATCHER must never rename it onto RequestURL (rules filter
 * on decoded URL text), but the SUGGESTER must surface it for human review.
 */

import { describe, expect, it } from "vitest";
import {
  closeMatchRowsFromReports,
  isTypeMismatch,
  nameTokens,
  suggestCloseMatches,
  suggestForDestColumn,
} from "./close-matches";
import { scoreMatch } from "./scoring";

describe("nameTokens", () => {
  it("splits camelCase, separators, and letter/digit boundaries", () => {
    expect(nameTokens("RequestURL")).toEqual(["request", "url"]);
    expect(nameTokens("b64url")).toEqual(["64", "url"]);
    expect(nameTokens("source_nat_ip")).toEqual(["source", "nat", "ip"]);
  });
});

describe("suggestCloseMatches", () => {
  const ZSCALER_WEB_ROWS = [
    {
      sourceName: "b64url",
      logType: "BLOCKED",
      disposition: "overflow",
      sampleValue: "d3d3LnRyeXRoaXNlbmNvZGV1cmwuY29t",
    },
    {
      sourceName: "urlclass",
      logType: "BLOCKED",
      disposition: "overflow",
      sampleValue: "Bandwidth Loss",
    },
    { sourceName: "cltip", logType: "BLOCKED", disposition: "mapped to SourceIP" },
    { sourceName: "reqsize", logType: "BLOCKED", disposition: "mapped to SentBytes" },
  ];

  it("surfaces b64url for RequestURL even though the matcher refuses it", () => {
    // The matcher is deliberately conservative here (base64 content).
    expect(scoreMatch("b64url", "RequestURL").score).toBe(0);
    // The suggester is deliberately looser.
    const suggestions = suggestCloseMatches("RequestURL", ZSCALER_WEB_ROWS, 5, {
      solutionName: "Zscaler Internet Access",
    });
    // DBT-195: the Zscaler hand pack documents b64url as RequestURL's data
    // (encoded), so it leads the documented tier, and its reason says a
    // decode is needed - the founding warning, now cited.
    expect(suggestions[0]?.sourceName).toBe("b64url");
    expect(suggestions[0]?.documented).toBe(true);
    expect(suggestions[0]?.reason).toBe(
      "Documented: NSS web: full URL, base64-encoded by the feed (needs a decode, not a rename)",
    );
    expect(suggestions[0]?.sampleValue).toContain("d3d3");
    // urlclass shares "url" only: offered below, as a sub-50 suggestion.
    expect(suggestions[1]?.sourceName).toBe("urlclass");
    expect(suggestions[1]?.score).toBe(35); // never reads as a match
  });

  it("cites a vendor pack only for the solution it documents", () => {
    // DBT-195 review: the documented index used to merge every vendor's
    // pack, so Zscaler's NSS citations were shown against any vendor's
    // fields. Unscoped, b64url is only a token overlap.
    const rows = [
      ...ZSCALER_WEB_ROWS,
      { sourceName: "location", logType: "TRAFFIC", disposition: "overflow" },
    ];
    const pick = (field: string, solutionName?: string) =>
      suggestCloseMatches(
        field,
        rows,
        5,
        solutionName === undefined ? {} : { solutionName },
      ).map((c) => [c.sourceName, c.score, c.documented]);
    expect(pick("RequestURL")).toEqual([
      ["b64url", 35, false],
      ["urlclass", 35, false],
    ]);
    // Zscaler documents `location` as SourceUserPrivileges; a PAN-OS or
    // Fortinet `location` is no such thing, and shares nothing by name.
    expect(pick("SourceUserPrivileges", "Palo Alto Networks")).toEqual([]);
    expect(pick("SourceUserPrivileges", "Zscaler Private Access")).toEqual([]);
    expect(pick("SourceUserPrivileges", "Zscaler Internet Access")).toEqual([
      ["location", 90, true],
    ]);
  });

  it("drops fields sharing nothing with the missing field", () => {
    const suggestions = suggestCloseMatches("RequestURL", ZSCALER_WEB_ROWS);
    expect(suggestions.map((s) => s.sourceName)).not.toContain("cltip");
    expect(suggestions.map((s) => s.sourceName)).not.toContain("reqsize");
  });

  it("ranks matcher-ladder hits above token overlaps", () => {
    const rows = [
      { sourceName: "urlclass", logType: "A", disposition: "overflow" },
      { sourceName: "uri", logType: "A", disposition: "overflow" },
    ];
    // "uri" is a known alias for RequestURL (score 90) and must outrank the
    // 35-point token overlap of urlclass. (b64url used to play urlclass's
    // part; since DBT-195 it is documented, so it no longer can.)
    const suggestions = suggestCloseMatches("RequestURL", rows);
    expect(suggestions[0]?.sourceName).toBe("uri");
    expect(suggestions[0]?.score).toBeGreaterThanOrEqual(50);
    expect(suggestions[1]?.sourceName).toBe("urlclass");
  });

  it("ranks an undocumented ladder hit above an undocumented token overlap", () => {
    const rows = [
      { sourceName: "urlclass", logType: "A", disposition: "overflow" },
      { sourceName: "RequestURLFull", logType: "A", disposition: "overflow" },
    ];
    expect(
      suggestCloseMatches("RequestURL", rows).map((s) => [
        s.sourceName,
        s.score,
        s.documented,
      ]),
    ).toEqual([
      ["RequestURLFull", 50, false],
      ["urlclass", 35, false],
    ]);
  });

  it("dedupes by source and log type and honors the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      sourceName: `url_variant_${i}`,
      logType: "A",
      disposition: "overflow",
    }));
    const suggestions = suggestCloseMatches("RequestURL", [...rows, ...rows], 3);
    expect(suggestions).toHaveLength(3);
  });
});

describe("nameTokens acronym runs", () => {
  it("splits an acronym from the word after it", () => {
    expect(nameTokens("SourceMACAddress")).toEqual(["source", "mac", "address"]);
    expect(nameTokens("DeviceEventClassID")).toEqual([
      "device",
      "event",
      "class",
      "id",
    ]);
  });
});

/**
 * DBT-195: the field set the offline UAT captured (TMNA_POV, PaloAlto-PAN-OS
 * CEF on in_syslog, v1.12.6). `in` went to overflow while its twin `out` was
 * renamed to SentBytes; the PAN extensions were overflowed as "no
 * CommonSecurityLog equivalent"; the five ids were the SourceUserID chip's
 * already-mapped noise.
 */
describe("close-match ranking against the PAN-OS UAT field set", () => {
  const overflow = (sourceName: string, sourceType: string) => ({
    sourceName,
    logType: "PAN-OS",
    disposition: "overflow -> AdditionalExtensions",
    sourceType,
  });
  const mapped = (sourceName: string, currentDest: string, sourceType = "string") => ({
    sourceName,
    logType: "PAN-OS",
    disposition: "rename -> " + currentDest,
    sourceType,
    currentDest,
  });
  const PAN_ROWS = [
    overflow("in", "int"),
    mapped("out", "SentBytes", "int"),
    overflow("PanOSPacketsReceived", "int"),
    overflow("PanOSPacketsSent", "int"),
    overflow("PanSrcMac", "string"),
    overflow("PanDstMac", "string"),
    overflow("PanSrcHostname", "string"),
    overflow("PanDstHostname", "string"),
    mapped("DeviceEventClassID", "DeviceEventClassID"),
    mapped("deviceExternalId", "DeviceExternalID"),
    mapped("duser", "DestinationUserName"),
    mapped("externalId", "ExternalID"),
    mapped("fileId", "FileID"),
    mapped("suser", "SourceUserName"),
    mapped("deviceInboundInterface", "DeviceInboundInterface"),
  ];
  const ranked = (name: string, type: string) =>
    suggestForDestColumn({ name, type }, PAN_ROWS).map((c) => [
      c.sourceName,
      c.score,
    ]);

  it("ReceivedBytes ranks the CEF-documented `in` first, the packet count below", () => {
    const candidates = suggestForDestColumn(
      { name: "ReceivedBytes", type: "long" },
      PAN_ROWS,
    );
    expect(candidates[0]).toEqual({
      ...overflow("in", "int"),
      score: 90,
      reason: "Documented: CEF in: Bytes transferred inbound",
      documented: true,
      alreadyMapped: false,
      typeMismatch: false,
    });
    expect(ranked("ReceivedBytes", "long")).toEqual([
      ["in", 90],
      ["PanOSPacketsReceived", 35],
      ["deviceInboundInterface", 35],
    ]);
    expect(candidates[1]?.documented).toBe(false);
    expect(candidates[1]?.reason).toBe('Shares "received" with ReceivedBytes');
  });

  it("SourceMACAddress ranks PanSrcMac above PanDstMac, DestinationMACAddress the reverse", () => {
    // PanSrcHostname shares only the direction with SourceMACAddress: a
    // qualifier alone is not a suggestion.
    expect(ranked("SourceMACAddress", "string")).toEqual([
      ["PanSrcMac", 39],
      ["PanDstMac", 30],
    ]);
    expect(ranked("DestinationMACAddress", "string")).toEqual([
      ["PanDstMac", 39],
      ["PanSrcMac", 30],
    ]);
  });

  it("SourceHostName ranks PanSrcHostname above PanDstHostname, DestinationHostName the reverse", () => {
    expect(ranked("SourceHostName", "string").slice(0, 2)).toEqual([
      ["PanSrcHostname", 49],
      ["PanDstHostname", 39],
    ]);
    expect(ranked("DestinationHostName", "string").slice(0, 2)).toEqual([
      ["PanDstHostname", 49],
      ["PanSrcHostname", 39],
    ]);
  });

  it("SourceUserID ranks an unmapped user field above the already-mapped ids", () => {
    const rows = [...PAN_ROWS, overflow("PanUser", "string")];
    const candidates = suggestForDestColumn(
      { name: "SourceUserID", type: "string" },
      rows,
      10,
    );
    // PanUser outranks suser (39) although it scores 30: suser is a move.
    // The ids sharing only "id" (DeviceEventClassID, deviceExternalId,
    // externalId, fileId - the UAT's noise) are not offered at all.
    expect(
      candidates.map((c) => [c.sourceName, c.score, c.alreadyMapped]),
    ).toEqual([
      ["PanUser", 30, false],
      ["suser", 39, true],
      ["duser", 30, true],
    ]);
  });

  it("still offers already-mapped fields (as moves) when nothing unmapped is close", () => {
    const candidates = suggestForDestColumn(
      { name: "SourceUserID", type: "string" },
      PAN_ROWS,
    );
    expect(
      candidates.map((c) => [c.sourceName, c.currentDest, c.alreadyMapped]),
    ).toEqual([
      ["suser", "SourceUserName", true],
      ["duser", "DestinationUserName", true],
    ]);
  });

  it("keeps every token-overlap score below the matcher's 50 floor", () => {
    const columns = [
      "ReceivedBytes",
      "SentBytes",
      "SourceMACAddress",
      "DestinationMACAddress",
      "SourceHostName",
      "DestinationHostName",
      "SourceUserID",
      "DeviceInboundInterface",
    ];
    const overlaps = columns.flatMap((name) =>
      suggestForDestColumn({ name, type: "string" }, PAN_ROWS, 50).filter((c) =>
        c.reason.startsWith("Shares"),
      ),
    );
    expect(overlaps.length).toBeGreaterThan(10);
    expect(Math.max(...overlaps.map((c) => c.score))).toBe(49);
  });

  it("never suggests the field already filling the column itself", () => {
    const names = suggestForDestColumn(
      { name: "SentBytes", type: "long" },
      PAN_ROWS,
      50,
    ).map((c) => c.sourceName);
    expect(names).not.toContain("out");
    expect(names).toEqual(["PanOSPacketsSent"]);
  });

  it("marks a type the column cannot take, without filtering it", () => {
    const candidates = suggestForDestColumn(
      { name: "ReceivedBytes", type: "long" },
      [overflow("in", "string"), overflow("PanOSPacketsReceived", "int")],
    );
    expect(candidates.map((c) => [c.sourceName, c.typeMismatch])).toEqual([
      ["in", true],
      ["PanOSPacketsReceived", false],
    ]);
  });

  it("the Rule Coverage path ranks with the same tiers and no type mark", () => {
    const candidates = suggestCloseMatches("ReceivedBytes", PAN_ROWS);
    expect(candidates.map((c) => c.sourceName)).toEqual([
      "in",
      "PanOSPacketsReceived",
      "deviceInboundInterface",
    ]);
    expect(candidates.every((c) => !c.typeMismatch)).toBe(true);
  });
});

describe("closeMatchRowsFromReports", () => {
  it("gives currentDest only to rows that fill a dedicated column", () => {
    const rows = closeMatchRowsFromReports([
      {
        logType: "TRAFFIC",
        fieldMappings: [
          { source: "out", dest: "SentBytes", sourceType: "int", action: "rename" },
          {
            source: "in",
            dest: "AdditionalExtensions",
            sourceType: "int",
            action: "overflow",
            sampleValue: "4096",
          },
          { source: "junk", dest: "", sourceType: "", action: "drop" },
          { source: "Message", dest: "Message", sourceType: "string", action: "keep" },
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        sourceName: "out",
        logType: "TRAFFIC",
        disposition: "rename -> SentBytes",
        sourceType: "int",
        currentDest: "SentBytes",
      },
      {
        sourceName: "in",
        logType: "TRAFFIC",
        disposition: "overflow -> AdditionalExtensions",
        sampleValue: "4096",
        sourceType: "int",
      },
      { sourceName: "junk", logType: "TRAFFIC", disposition: "drop" },
      {
        sourceName: "Message",
        logType: "TRAFFIC",
        disposition: "keep -> Message",
        sourceType: "string",
        currentDest: "Message",
      },
    ]);
  });
});

describe("isTypeMismatch", () => {
  it("flags only a known source the known column cannot take", () => {
    expect(isTypeMismatch("string", "long")).toBe(true);
    expect(isTypeMismatch("string", "datetime")).toBe(true);
    expect(isTypeMismatch("int", "long")).toBe(false);
    expect(isTypeMismatch("int", "string")).toBe(false);
    expect(isTypeMismatch("int", "dynamic")).toBe(false);
    expect(isTypeMismatch("string", "guid")).toBe(false);
    expect(isTypeMismatch(undefined, "long")).toBe(false);
    expect(isTypeMismatch("", "long")).toBe(false);
    expect(isTypeMismatch("string", "")).toBe(false);
  });
});
