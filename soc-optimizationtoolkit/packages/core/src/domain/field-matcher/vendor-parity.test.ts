/**
 * VENDOR PARITY pins (user request 2026-07-12): our Zscaler web mapping must
 * be a SUPERSET of Zscaler's own published Microsoft Sentinel integration.
 *
 * The reference is the vendor's canonical feed definition (nss-web.cef /
 * cloud-nss-web.fof in github.com/zscaler/microsoft-resources, cited by the
 * Zscaler and Microsoft Sentinel Deployment Guide): 30 underlying web-log
 * fields reach named CommonSecurityLog columns; everything else goes to
 * AdditionalExtensions. Label literals (cs1Label=dept ... cn1Label=riskscore)
 * are verbatim from that feed.
 *
 * Documented divergences (deliberate, better than parity):
 *  - fileHash: the vendor emits only MD5 (bamd5); we map sha256 -> FileHash
 *    and leave bamd5 in overflow. bamd5 is deliberately NOT in the pack.
 *  - proto: the vendor maps app={proto} -> ApplicationProtocol; the raw feed
 *    carries applayerprotocol for that datum, and proto is log-type-ambiguous
 *    (TCP in firewall logs), so applayerprotocol carries the pack entry.
 */

import { describe, expect, it } from "vitest";
import { matchFields } from "./match-fields";
import type { VendorMapping } from "./match-fields";
import {
  vendorLabelEnrichments,
  vendorMappingsForSolution,
} from "./vendor-mapping-packs";

/** The raw Cloud NSS web fields behind the vendor's named-column mappings. */
const WEB_SAMPLE_FIELDS = [
  "action", "reason", "urlsubcat", "host", "serverip", "cltip", "respsize",
  "respcode", "reqsize", "b64url", "time", "cltpubip", "useragent",
  "reqmethod", "b64referer", "login", "location", "recordid", "filetype",
  "filename", "bamd5", "sha256", "appname", "riskscore", "dept",
  "urlsupercat", "appclass", "malwarecategory", "threatname", "dlpeng",
];

/** The CommonSecurityLog columns the vendor's feed populates (plus FileName/
 *  ProcessName/AdditionalExtensions to exercise the divergences). */
const CSL_COLUMNS = [
  "DeviceAction", "Reason", "DeviceEventCategory", "DestinationHostName",
  "DestinationIP", "SourceIP", "ReceivedBytes", "EventOutcome", "SentBytes",
  "RequestURL", "ReceiptTime", "SourceTranslatedAddress",
  "RequestClientApplication", "RequestMethod", "RequestContext",
  "SourceUserName", "SourceUserPrivileges", "ExternalID", "FileType",
  "FileName", "FileHash", "DestinationServiceName", "DeviceCustomNumber1",
  "DeviceCustomNumber1Label", "DeviceCustomString1", "DeviceCustomString1Label",
  "DeviceCustomString2", "DeviceCustomString2Label", "DeviceCustomString3",
  "DeviceCustomString3Label", "DeviceCustomString4", "DeviceCustomString4Label",
  "DeviceCustomString5", "DeviceCustomString5Label", "DeviceCustomString6",
  "DeviceCustomString6Label", "ProcessName", "AdditionalExtensions",
].map((name) => ({ name, type: "string" }));

/** The per-sample guard the analyzeSamples usecase applies to Phase 0. */
function applicable(mappings: VendorMapping[], sourceNames: string[]) {
  const sample = new Set(sourceNames.map((n) => n.toLowerCase()));
  const schema = new Set(CSL_COLUMNS.map((c) => c.name.toLowerCase()));
  const claimedDest = new Set<string>();
  const claimedSource = new Set<string>();
  return mappings.filter((vm) => {
    const src = vm.sourceName.toLowerCase();
    if (!sample.has(src) || claimedSource.has(src)) return false;
    if (vm.action === "drop") {
      claimedSource.add(src);
      return true;
    }
    const dest = vm.destName.toLowerCase();
    if (!schema.has(dest) || claimedDest.has(dest)) return false;
    claimedSource.add(src);
    claimedDest.add(dest);
    return true;
  });
}

function analyzeWeb() {
  const mappings = vendorMappingsForSolution("Zscaler Internet Access");
  return matchFields(
    WEB_SAMPLE_FIELDS.map((name) => ({ name, type: "string" })),
    CSL_COLUMNS,
    applicable(mappings, WEB_SAMPLE_FIELDS),
    "CommonSecurityLog",
  );
}

function destOf(result: ReturnType<typeof matchFields>, source: string) {
  return result.matched.find((m) => m.sourceName === source)?.destName;
}

describe("Zscaler web vendor parity (feed: nss-web.cef / cloud-nss-web.fof)", () => {
  const result = analyzeWeb();

  it("covers every vendor-documented named-column mapping", () => {
    // CEF key -> raw field -> CommonSecurityLog column, from the vendor feed.
    expect(destOf(result, "action")).toBe("DeviceAction"); // act
    expect(destOf(result, "reason")).toBe("Reason"); // reason + name header
    expect(destOf(result, "urlsubcat")).toBe("DeviceEventCategory"); // cat={urlcat}
    expect(destOf(result, "host")).toBe("DestinationHostName"); // dhost={ehost}
    expect(destOf(result, "serverip")).toBe("DestinationIP"); // dst={sip}
    expect(destOf(result, "cltip")).toBe("SourceIP"); // src={cip}
    expect(destOf(result, "respsize")).toBe("ReceivedBytes"); // in
    expect(destOf(result, "reqsize")).toBe("SentBytes"); // out
    expect(destOf(result, "respcode")).toBe("EventOutcome"); // outcome
    expect(destOf(result, "b64url")).toBe("RequestURL"); // request={eurl}
    expect(destOf(result, "cltpubip")).toBe("SourceTranslatedAddress"); // cintip
    expect(destOf(result, "useragent")).toBe("RequestClientApplication"); // ua
    expect(destOf(result, "reqmethod")).toBe("RequestMethod");
    expect(destOf(result, "b64referer")).toBe("RequestContext"); // ereferer
    expect(destOf(result, "login")).toBe("SourceUserName"); // suser
    expect(destOf(result, "location")).toBe("SourceUserPrivileges"); // spriv
    expect(destOf(result, "recordid")).toBe("ExternalID"); // externalId
    expect(destOf(result, "filetype")).toBe("FileType");
    expect(destOf(result, "filename")).toBe("FileName"); // fname
    expect(destOf(result, "appname")).toBe("DestinationServiceName");
    expect(destOf(result, "riskscore")).toBe("DeviceCustomNumber1"); // cn1
    expect(destOf(result, "dept")).toBe("DeviceCustomString1"); // cs1
    expect(destOf(result, "urlsupercat")).toBe("DeviceCustomString2"); // cs2
    expect(destOf(result, "appclass")).toBe("DeviceCustomString3"); // cs3
    expect(destOf(result, "malwarecategory")).toBe("DeviceCustomString4"); // cs4
    expect(destOf(result, "threatname")).toBe("DeviceCustomString5"); // cs5
    expect(destOf(result, "dlpeng")).toBe("DeviceCustomString6"); // cs6
  });

  it("keeps the documented divergences: sha256 beats bamd5; appname leaves ProcessName", () => {
    expect(destOf(result, "sha256")).toBe("FileHash");
    expect(destOf(result, "bamd5")).toBeUndefined();
    expect(result.overflow.map((m) => m.sourceName)).toContain("bamd5");
    expect(result.matched.map((m) => m.destName)).not.toContain("ProcessName");
  });

  it("demands the verbatim CEF label constants for the applied cs/cn columns", () => {
    const labels = vendorLabelEnrichments("Zscaler Internet Access");
    const byField = new Map(labels.map((l) => [l.field, l.value]));
    expect(byField.get("DeviceCustomNumber1Label")).toBe("riskscore");
    expect(byField.get("DeviceCustomString1Label")).toBe("dept");
    expect(byField.get("DeviceCustomString2Label")).toBe("urlsupercat");
    expect(byField.get("DeviceCustomString3Label")).toBe("appclass");
    expect(byField.get("DeviceCustomString4Label")).toBe("malwarecat");
    expect(byField.get("DeviceCustomString5Label")).toBe("threatname");
    expect(byField.get("DeviceCustomString6Label")).toBe("dlpeng");
    // Both raw-name variants of the cs4 datum demand the SAME vendor label.
    const cs4 = labels.filter((l) => l.field === "DeviceCustomString4Label");
    expect(new Set(cs4.map((l) => l.value))).toEqual(new Set(["malwarecat"]));
    // Labels seed only for mappings that applied - the entries carry the
    // source/dest pair the caller must check.
    expect(labels.every((l) => l.sourceName !== "" && l.destName !== "")).toBe(
      true,
    );
  });

  it("solutions without label-bearing packs demand nothing", () => {
    expect(vendorLabelEnrichments("Barracuda WAF")).toEqual([]);
  });
});
