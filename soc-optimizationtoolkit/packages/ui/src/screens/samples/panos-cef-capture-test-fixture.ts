/**
 * A live-shaped Cribl capture of PAN-OS CEF over syslog (DBT-197). Test-only;
 * nothing shipped imports it.
 *
 * Shaped on the 2026-10-29 UAT capture that lost 91 of 100 events between the
 * capture headline and the sample chip: `_raw` is a syslog-wrapped PAN-OS CEF
 * line, alternating the THREAT `url` and TRAFFIC `end` shapes, carrying the
 * vendor's long extension list (PanOS*, Pan*Device*, PanTimeHighRes, in/out).
 * The LENGTH is the point - a verbose line per event is what runs into the
 * sample store's per-log-type byte cap, and a fixture of three short lines
 * could never show it. Every value is fake; the serial, hosts and addresses are
 * documentation ranges.
 *
 * The events carry the wrapper fields a Cribl capture adds (`_time`,
 * `__inputId`, `cribl_breaker`, `host`) and the body is NDJSON text, which is
 * what /system/capture returns for more than one event.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/** The extension pairs a PAN-OS 10.x CEF line carries for both shapes. */
function commonPairs(i: number): string {
  const second = pad(i % 60);
  return [
    `rt=Oct 29 2026 12:00:${second} GMT`,
    "deviceExternalId=012345678901",
    `src=10.1.${i % 250}.${(i * 3) % 250}`,
    `dst=203.0.113.${i % 250}`,
    `sourceTranslatedAddress=198.51.100.${i % 250}`,
    "destinationTranslatedAddress=0.0.0.0",
    "cs1Label=Rule",
    `cs1=allow-web-${i % 4}`,
    `suser=corp\\\\user${i % 9}`,
    "duser=",
    "app=web-browsing",
    "cs3Label=Virtual System",
    "cs3=vsys1",
    "cs4Label=Source Zone",
    "cs4=trust",
    "cs5Label=Destination Zone",
    "cs5=untrust",
    "deviceInboundInterface=ethernet1/2",
    "deviceOutboundInterface=ethernet1/1",
    "cs6Label=LogProfile",
    "cs6=default-logging",
    "cn1Label=SessionID",
    `cn1=${100000 + i}`,
    "cnt=1",
    `spt=${40000 + i}`,
    "dpt=443",
    `sourceTranslatedPort=${50000 + i}`,
    "destinationTranslatedPort=443",
    "flexString1Label=Flags",
    "flexString1=0x400000",
    "proto=tcp",
    "act=allow",
    "PanOSDGl1=11",
    "PanOSDGl2=12",
    "PanOSDGl3=0",
    "PanOSDGl4=0",
    "PanOSVsysName=",
    "dvchost=fw01.example.com",
    `PanOSSrcUUID=00000000-0000-4000-8000-0000000000${pad(i % 100)}`,
    `PanOSDstUUID=00000000-0000-4000-9000-0000000000${pad(i % 100)}`,
    "PanOSTunnelID=0",
    "PanOSMonitorTag=",
    "PanOSParentSessionID=0",
    "PanOSParentStartTime=",
    "PanOSTunnelType=N/A",
    "PanOSRuleUUID=11111111-2222-4333-8444-555555555555",
    "PanOSHTTP2Con=0",
    "PanDynamicUsrgrp=",
    "PanSrcDeviceCat=Workstation",
    "PanSrcDeviceProf=Windows",
    "PanSrcDeviceModel=Generic",
    "PanSrcDeviceVendor=ExampleCorp",
    "PanSrcDeviceOS=Windows",
    "PanSrcDeviceOSv=11",
    `PanSrcHostname=ws-${pad(i % 40)}.example.com`,
    `PanSrcMac=00:11:22:33:44:${pad(i % 100)}`,
    "PanDstDeviceCat=",
    "PanDstDeviceProf=",
    "PanDstDeviceModel=",
    "PanDstDeviceVendor=",
    "PanDstDeviceOS=",
    "PanDstDeviceOSv=",
    "PanDstHostname=",
    `PanDstMac=66:77:88:99:aa:${pad(i % 100)}`,
    "PanContainerName=",
    "PanPODNamespace=",
    "PanPODName=",
    "PanSrcEDL=",
    "PanDstEDL=",
    "PanHostID=",
    "PanSerialNumber=012345678901",
    "PanSrcDAG=",
    "PanDstDAG=",
    "PanOSSessionOwner=",
    "PanOSA_Slice_Service_Type=",
    "PanOSA_Slice_Differentiator=",
    "PanOSApplicationSubcategory=internet-utility",
    "PanOSApplicationCategory=general-internet",
    "PanOSApplicationTechnology=browser-based",
    "PanOSApplicationRisk=4",
    "PanOSApplicationCharacteristic=used-by-malware,able-to-transfer-file",
    "PanOSApplicationContainer=",
    "PanOSApplicationSaaS=no",
    "PanOSApplicationSanctioned=no",
    `PanTimeHighRes=2026-10-29T12:00:${second}.123+00:00`,
  ].join(" ");
}

/** One THREAT `url` line, syslog-wrapped the way an on-box forwarder sends it. */
function threatUrlLine(i: number): string {
  const second = pad(i % 60);
  return (
    `<14>Oct 29 12:00:${second} fw01.example.com ` +
    "CEF:0|Palo Alto Networks|PAN-OS|10.2.4|url|THREAT|1|" +
    `${commonPairs(i)} request=www.example.com/path/${i}?q\\=1 ` +
    "cs2Label=URL Category cs2=computer-and-internet-info " +
    "flexString2Label=Direction flexString2=client-to-server " +
    `PanOSActionFlags=0x8000000000000000 externalId=${7000000 + i} ` +
    "cat=(9999) fileId=0 PanOSThreatCategory=unknown PanOSContentVer=AppThreat-8800-8888 " +
    `PanOSAssocID=0 PanOSPPID=4294967295 PanOSHTTPHeader= PanOSURLCatList=computer-and-internet-info,low-risk ` +
    "PanOSContentType=text/html PanOSReferer=https://www.example.org/ PanOSUserAgent=Mozilla/5.0 " +
    "PanXFF= PanPartialHash=0 PanReasonForDataFilteringAction= PanJustification="
  );
}

/** One TRAFFIC `end` line, in the same envelope. */
function trafficEndLine(i: number): string {
  const second = pad(i % 60);
  return (
    `<14>Oct 29 12:00:${second} fw01.example.com ` +
    "CEF:0|Palo Alto Networks|PAN-OS|10.2.4|end|TRAFFIC|1|" +
    `${commonPairs(i)} externalId=${8000000 + i} cat=aged-out ` +
    `in=${1000 + i} out=${2000 + i} PanOSBytes=${3000 + 2 * i} ` +
    `PanOSPacketsReceived=${i * 2} PanOSPacketsSent=${i * 3} PanOSPackets=${i * 5} ` +
    `start=Oct 29 2026 11:59:${second} GMT PanOSSessionDuration=${i % 30} ` +
    "PanOSSessionStartTime= PanOSSourceLocation=10.0.0.0-10.255.255.255 " +
    "PanOSDestinationLocation=United States PanOSSessionEndReason=aged-out " +
    "PanOSLinkChangeCount=0 PanOSSDWANCluster= PanOSSDWANDeviceType= PanOSSDWANClusterType= " +
    "PanOSSDWANSite= PanOSPolicyID=1 PanOSOffloaded=0 PanOSFlowType=0"
  );
}

/** The `_raw` of event `i`: even indices THREAT url, odd TRAFFIC end. */
export function panosCefRaw(i: number): string {
  return i % 2 === 0 ? threatUrlLine(i) : trafficEndLine(i);
}

/**
 * `count` capture events as /system/capture returns them: NDJSON text, one
 * wrapper object per line with the vendor bytes in `_raw`.
 */
export function panosCefCaptureBody(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      _raw: panosCefRaw(i),
      _time: 1793275200 + i,
      __inputId: "syslog:in_syslog:udp",
      cribl_breaker: "Break on newlines",
      host: "192.0.2.10",
    }),
  ).join("\n");
}
