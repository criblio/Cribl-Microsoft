import { describe, expect, it } from "vitest";

import { parseFeedConfig } from "./index";

// NEW coverage (Unit 12 named this a coverage gap). Mined from the legacy
// sample-parser.ts parseVendorFeedConfig. The load-bearing BRANCH ORDER and two
// consciously-preserved quirks (the Cloudflare 'dataset' false-positive and the
// Zscaler default-TCP) are pinned here.

describe("parseFeedConfig - Zscaler NSS (three extraction patterns)", () => {
  it("pattern 1: format-string placeholders %s{field}/%d{field}", () => {
    const cfg = parseFeedConfig(
      "NSS for Web feed: %s{datetime},%s{cloudname},%d{action},%s{url}",
    );
    expect(cfg.vendor).toBe("Zscaler");
    expect(cfg.feedType).toBe("nss_web");
    expect(cfg.format).toBe("csv");
    expect(cfg.fields).toEqual(["datetime", "cloudname", "action", "url"]);
  });

  it("pattern 2: 'Fields: a,b,c'", () => {
    const cfg = parseFeedConfig(
      "Zscaler NSS\nFields: datetime,cloudname,host,action,url",
    );
    expect(cfg.vendor).toBe("Zscaler");
    expect(cfg.fields).toEqual([
      "datetime",
      "cloudname",
      "host",
      "action",
      "url",
    ]);
  });

  it("pattern 3: a bare comma-separated identifier list (>=5 columns)", () => {
    const cfg = parseFeedConfig(
      "nss_type=web\ndatetime,cloudname,host,serverip,action,url",
    );
    expect(cfg.feedType).toBe("nss_web");
    expect(cfg.fields).toEqual([
      "datetime",
      "cloudname",
      "host",
      "serverip",
      "action",
      "url",
    ]);
  });

  it("defaults transport to TCP (pinned), only HTTPS when https present and tcp absent", () => {
    expect(
      parseFeedConfig("Zscaler NSS feed %s{datetime},%s{action}")
        .transportProtocol,
    ).toBe("TCP");
    expect(
      parseFeedConfig("Zscaler NSS https endpoint %s{datetime}")
        .transportProtocol,
    ).toBe("HTTPS");
    expect(
      parseFeedConfig("Zscaler NSS tcp %s{datetime}").transportProtocol,
    ).toBe("TCP");
  });
});

describe("parseFeedConfig - other vendors", () => {
  it("Palo Alto syslog forwarding profile", () => {
    const cfg = parseFeedConfig(
      "set syslog-server-profile Prod server 10.0.0.9 port 514 transport TCP format BSD log traffic threat url",
    );
    expect(cfg.vendor).toBe("Palo Alto");
    expect(cfg.feedType).toBe("syslog_forwarding");
    expect(cfg.port).toBe(514);
    expect(cfg.transportProtocol).toBe("TCP");
    expect(cfg.format).toBe("syslog_bsd");
    expect(cfg.fields).toEqual(
      expect.arrayContaining(["traffic", "threat", "url"]),
    );
  });

  it("FortiGate syslogd config (kv format)", () => {
    const cfg = parseFeedConfig(
      'config log syslogd setting\nset server "10.0.0.5"\nset port 514\nset mode udp\nset filter "traffic threat"',
    );
    expect(cfg.vendor).toBe("Fortinet");
    expect(cfg.format).toBe("kv");
    expect(cfg.port).toBe(514);
    expect(cfg.transportProtocol).toBe("UDP");
    expect(cfg.fields).toEqual(["traffic", "threat"]);
  });

  it("Cloudflare Logpush job JSON", () => {
    const cfg = parseFeedConfig(
      '{"dataset":"http_requests","destination_conf":"https://bucket","logpull_options":"fields=ClientIP,EdgeStartTimestamp&timestamps=rfc3339"}',
    );
    expect(cfg.vendor).toBe("Cloudflare");
    expect(cfg.feedType).toBe("logpush");
    expect(cfg.format).toBe("ndjson");
    expect(cfg.transportProtocol).toBe("HTTPS");
    expect(cfg.fields).toEqual(["ClientIP", "EdgeStartTimestamp"]);
  });

  it("CrowdStrike SIEM connector / event streams", () => {
    const cfg = parseFeedConfig(
      "CrowdStrike Falcon SIEM Connector event_streams: DetectionSummary, AuthActivity, UserActivity",
    );
    expect(cfg.vendor).toBe("CrowdStrike");
    expect(cfg.feedType).toBe("event_stream");
    expect(cfg.format).toBe("json");
    expect(cfg.transportProtocol).toBe("HTTPS");
    expect(cfg.fields).toEqual([
      "DetectionSummary",
      "AuthActivity",
      "UserActivity",
    ]);
  });

  it("generic rsyslog fallback", () => {
    const cfg = parseFeedConfig(
      "rsyslog forward to 10.0.0.1 port 601 tls",
    );
    expect(cfg.vendor).toBe("generic");
    expect(cfg.feedType).toBe("syslog_forwarding");
    expect(cfg.format).toBe("syslog");
    expect(cfg.port).toBe(601);
    expect(cfg.transportProtocol).toBe("TLS");
  });

  it("returns unknown for unrelated text", () => {
    const cfg = parseFeedConfig("something totally unrelated");
    expect(cfg.vendor).toBe("unknown");
    expect(cfg.format).toBe("unknown");
    expect(cfg.fields).toEqual([]);
  });
});

describe("parseFeedConfig - branch order and the 'dataset' false-positive", () => {
  it("misclassifies a bare 'dataset' mention as Cloudflare (documented, preserved)", () => {
    // A non-Cloudflare config that merely says 'dataset' is claimed by the
    // Cloudflare branch because it runs before the generic syslog fallback.
    const cfg = parseFeedConfig(
      "Our internal pipeline exports the dataset nightly to disk",
    );
    expect(cfg.vendor).toBe("Cloudflare");
    expect(cfg.feedType).toBe("logpush");
  });

  it("an earlier vendor branch still wins even when 'dataset' is present", () => {
    // Branch order: the Zscaler branch precedes the Cloudflare 'dataset' branch,
    // so this stays Zscaler despite the literal word 'dataset'.
    const cfg = parseFeedConfig(
      "Zscaler NSS for Firewall dataset export %s{datetime},%s{action}",
    );
    expect(cfg.vendor).toBe("Zscaler");
    expect(cfg.feedType).toBe("nss_firewall");
  });
});
