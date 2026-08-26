"""Three more Lake benches, covering the format families the Zscaler ones do not.

  fortigate_kv   key=value, self-describing        -> the app must ask NOTHING
  okta_json      nested JSON, names in the data    -> structured/overflow path
  broken_feed    ragged CSV, no discriminator      -> what the app SAYS when
                                                      the data is bad

PROVENANCE. These lean on knowledge this repo already carries and has vetted,
which is a better source than a fresh guess:

  FortiGate  field names that appear in the toolkit's own alias table,
             packages/core/src/domain/field-matcher/knowledge-bases.ts -
             srcintf, dstintf, sentbyte, rcvdbyte, policyid, proto, service,
             action, app, duration all map to Sentinel columns there. Using them
             means the bench exercises mappings the app really has.
  Okta       System Log event-type families from
             packages/core/src/domain/log-type-catalog/vendor-log-types.ts,
             which cites developer.okta.com/docs/reference/api/event-types/.
             The envelope shape (actor / client.geographicalContext / outcome /
             target[] / securityContext) is Okta's documented System Log object.

Values are illustrative lab data, not captured traffic - the point of these
benches is FORMAT coverage, not vendor fidelity, and none of them claims a
vendor-published byte layout the way the Zscaler CEF bench does.
"""

import json

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def stamp(i):
    """Deterministic Aug-2026 timestamps; no clock is read (see meta rules)."""
    hh = 6 + (i * 7) % 17
    mm = (i * 13) % 60
    ss = (i * 29) % 60
    return ("2026-08-26", "%02d:%02d:%02d" % (hh, mm, ss),
            "2026-08-26T%02d:%02d:%02d.000Z" % (hh, mm, ss),
            1787700000 + i * 37)


# ---------------------------------------------------------------------------
# BENCH 4 - FortiGate key=value
# ---------------------------------------------------------------------------
# `type` and `subtype` are set as REAL event fields, which is what a Cribl
# pipeline extracting kv produces and what Search needs in order to group. They
# are also the vendor's own discriminators, not something minted here.

FG_ROWS = [
    dict(type="traffic", subtype="forward", level="notice", logid="0000000013",
         srcip="10.10.20.31", srcport="54321", srcintf="port1",
         srcintfrole="lan", dstip="52.88.186.130", dstport="443",
         dstintf="port2", dstintfrole="wan", proto="6", action="accept",
         policyid="12", policytype="policy", service="HTTPS",
         trandisp="snat", app="HTTPS", appcat="Network.Service",
         apprisk="elevated", duration="132", sentbyte="4180",
         rcvdbyte="18422", sentpkt="34", rcvdpkt="41", devtype="Windows PC",
         osname="Windows", srcmac="00:0c:29:a1:b2:c3", sessionid="884213",
         vd="root"),
    dict(type="traffic", subtype="forward", level="notice", logid="0000000013",
         srcip="10.10.20.77", srcport="51002", srcintf="port1",
         srcintfrole="lan", dstip="8.8.8.8", dstport="53",
         dstintf="port2", dstintfrole="wan", proto="17", action="accept",
         policyid="12", policytype="policy", service="DNS",
         trandisp="snat", app="DNS", appcat="Network.Service",
         apprisk="low", duration="2", sentbyte="82", rcvdbyte="164",
         sentpkt="1", rcvdpkt="1", devtype="Windows PC", osname="Windows",
         srcmac="00:0c:29:d4:e5:f6", sessionid="884214", vd="root"),
    dict(type="traffic", subtype="forward", level="warning", logid="0000000013",
         srcip="10.10.20.31", srcport="49155", srcintf="port1",
         srcintfrole="lan", dstip="203.0.113.5", dstport="445",
         dstintf="port2", dstintfrole="wan", proto="6", action="deny",
         policyid="3", policytype="policy", service="SMB",
         trandisp="noop", app="SMB", appcat="Network.Service",
         apprisk="critical", duration="0", sentbyte="176", rcvdbyte="0",
         sentpkt="4", rcvdpkt="0", devtype="Windows PC", osname="Windows",
         srcmac="00:0c:29:a1:b2:c3", sessionid="884215", vd="root"),
    dict(type="utm", subtype="webfilter", level="warning", logid="0316013056",
         srcip="10.10.20.77", srcport="51330", srcintf="port1",
         srcintfrole="lan", dstip="93.184.216.34", dstport="443",
         dstintf="port2", dstintfrole="wan", proto="6", action="blocked",
         policyid="12", policytype="policy", service="HTTPS",
         hostname="www.blocked-example.com", url="/index",
         catdesc="Adult Materials", cat="14", eventtype="ftgd_blk",
         reqtype="direct", method="domain", sessionid="884216", vd="root"),
    dict(type="utm", subtype="ips", level="alert", logid="0419016384",
         srcip="203.0.113.9", srcport="40122", srcintf="port2",
         srcintfrole="wan", dstip="10.10.20.5", dstport="445",
         dstintf="port1", dstintfrole="lan", proto="6", action="dropped",
         policyid="3", policytype="policy", service="SMB",
         attack="MS.SMB.Server.Trans.Peeking.Data.Information.Disclosure",
         attackid="38255", severity="critical", srccountry="Reserved",
         eventtype="signature", sessionid="884217", vd="root"),
    dict(type="event", subtype="system", level="information",
         logid="0100032002", action="login", status="success",
         user="admin", ui="jsconsole", method="jsconsole",
         msg="Administrator admin logged in successfully from jsconsole",
         vd="root"),
]


def fortigate_line(r, date, time_, eventtime):
    """FortiGate kv: space separated, values with spaces double-quoted."""
    head = [("date", date), ("time", time_), ("eventtime", str(eventtime)),
            ("tz", "+0000"), ("devname", "FGT-LAB-01"),
            ("devid", "FGT60FTK20001234")]
    parts = []
    for k, v in head + list(r.items()):
        v = str(v)
        parts.append('%s="%s"' % (k, v) if (" " in v or "," in v) else "%s=%s" % (k, v))
    return " ".join(parts)


# ---------------------------------------------------------------------------
# BENCH 5 - Okta System Log, nested JSON
# ---------------------------------------------------------------------------
# Emitted as PARSED event fields with no _raw, which is what a JSON source
# produces - and it exercises the app's JSON.stringify(row) fallback in
# rowRawText, a path the _raw-bearing benches never reach.

OKTA_ROWS = [
    dict(eventType="user.session.start", severity="INFO", result="SUCCESS",
         reason=None, display="User login to Okta",
         actor_id="00u1a2b3c4d5e6f7g8h9", actor_alt="jdoe@safemarch.com",
         actor_name="Jane Doe", ip="203.0.113.5", city="San Francisco",
         country="United States", browser="CHROME", os="Windows 10",
         target_type="AppInstance", target_name="Salesforce"),
    dict(eventType="user.authentication.auth_via_mfa", severity="INFO",
         result="SUCCESS", reason=None, display="Authentication of user via MFA",
         actor_id="00u1a2b3c4d5e6f7g8h9", actor_alt="jdoe@safemarch.com",
         actor_name="Jane Doe", ip="203.0.113.5", city="San Francisco",
         country="United States", browser="CHROME", os="Windows 10",
         target_type="AuthenticatorEnrollment", target_name="Okta Verify"),
    dict(eventType="user.session.start", severity="WARN", result="FAILURE",
         reason="INVALID_CREDENTIALS", display="User login to Okta",
         actor_id="00u9z8y7x6w5v4u3t2s1", actor_alt="rsmith@safemarch.com",
         actor_name="Rowan Smith", ip="198.51.100.100", city="Dublin",
         country="Ireland", browser="FIREFOX", os="Mac OS X",
         target_type="AppInstance", target_name="Okta Admin Console"),
    dict(eventType="user.lifecycle.suspend", severity="WARN", result="SUCCESS",
         reason=None, display="Suspend Okta user",
         actor_id="00uadmin000000000001", actor_alt="admin@safemarch.com",
         actor_name="Org Admin", ip="203.0.113.10", city="San Francisco",
         country="United States", browser="CHROME", os="Windows 10",
         target_type="User", target_name="rsmith@safemarch.com"),
    dict(eventType="policy.lifecycle.update", severity="INFO",
         result="SUCCESS", reason=None, display="Update policy",
         actor_id="00uadmin000000000001", actor_alt="admin@safemarch.com",
         actor_name="Org Admin", ip="203.0.113.10", city="San Francisco",
         country="United States", browser="CHROME", os="Windows 10",
         target_type="PolicyEntity", target_name="Default sign-on policy"),
    dict(eventType="application.lifecycle.update", severity="INFO",
         result="SUCCESS", reason=None, display="Update application",
         actor_id="00uadmin000000000001", actor_alt="admin@safemarch.com",
         actor_name="Org Admin", ip="203.0.113.10", city="San Francisco",
         country="United States", browser="CHROME", os="Windows 10",
         target_type="AppInstance", target_name="Salesforce"),
]


def okta_event(r, iso, idx):
    return {
        "uuid": "b4e1%08x-4a1b-4c2d-9e3f-%012x" % (idx, 0xA00000000000 + idx),
        "published": iso,
        "eventType": r["eventType"],
        "version": "0",
        "severity": r["severity"],
        "displayMessage": r["display"],
        "legacyEventType": "core.user_auth.login_success",
        "actor": {"id": r["actor_id"], "type": "User",
                  "alternateId": r["actor_alt"], "displayName": r["actor_name"]},
        "client": {
            "userAgent": {"rawUserAgent": "Mozilla/5.0 (%s)" % r["os"],
                          "os": r["os"], "browser": r["browser"]},
            "zone": "null", "device": "Computer", "ipAddress": r["ip"],
            "geographicalContext": {
                "city": r["city"], "state": "-", "country": r["country"],
                "postalCode": "94107",
                "geolocation": {"lat": 37.7749, "lon": -122.4194}},
        },
        "outcome": {"result": r["result"], "reason": r["reason"]},
        "target": [{"id": "0oa%016x" % idx, "type": r["target_type"],
                    "alternateId": r["target_name"],
                    "displayName": r["target_name"]}],
        "transaction": {"type": "WEB", "id": "Y%015x" % idx},
        "authenticationContext": {"authenticationStep": 0,
                                  "externalSessionId": "102%013x" % idx},
        "securityContext": {"asNumber": 15169, "asOrg": "google",
                            "isp": "google", "domain": "google.com",
                            "isProxy": False},
        "debugContext": {"debugData": {"requestId": "Xr%013x" % idx,
                                       "requestUri": "/api/v1/authn",
                                       "threatSuspected": "false"}},
    }


# ---------------------------------------------------------------------------
# BENCH 6 - deliberately broken
# ---------------------------------------------------------------------------
# Every line here is a hazard the app claims to handle. NO field beyond _raw is
# set, on purpose: with nothing for Search to group by, this bench exercises the
# datasetAsLogType path - "offered as one log type, named after the dataset".

BROKEN_LINES = [
    # 1. The reference shape: 12 clean columns.
    "1,2026/08/26 09:14:02,013101001305,TRAFFIC,end,10,2026/08/26 09:13:55,"
    "10.0.0.5,8.8.8.8,allow,tcp,443",
    # 2. THE EMPTY COLUMN. Field 2 is blank, so every name after it shifts left
    #    by one and `TRAFFIC` lands where the serial belongs. This is the
    #    off-by-one the header dialog's mismatch warning exists to catch.
    "1,2026/08/26 09:14:03,,TRAFFIC,end,11,2026/08/26 09:13:56,"
    "10.0.0.6,1.1.1.1,allow,tcp,443",
    # 3. SHORT ROW - 8 columns where the reference has 12.
    "1,2026/08/26 09:14:04,013101001305,THREAT,vulnerability,12,"
    "2026/08/26 09:13:57,10.0.0.7",
    # 4. LONG ROW - 16 columns, same nominal log type as row 1.
    "1,2026/08/26 09:14:05,013101001305,TRAFFIC,end,13,2026/08/26 09:13:58,"
    "10.0.0.8,52.88.186.130,allow,tcp,443,4180,18422,34,41",
    # 5. UNESCAPED COMMA INSIDE A VALUE - the hazard Zscaler's own docs warn
    #    about ("avoid commas, they could be in some output values"). The
    #    description splits into two columns and shifts the rest.
    "1,2026/08/26 09:14:06,013101001305,SYSTEM,general,14,"
    "2026/08/26 09:13:59,Link down, interface port2,critical",
    # 6. QUOTED value that DOES contain a comma - the same hazard handled
    #    correctly, so the two are distinguishable.
    '1,2026/08/26 09:14:07,013101001305,SYSTEM,general,15,'
    '2026/08/26 09:14:00,"Link up, interface port2",informational',
    # 7. TRAILING DELIMITER - a thirteenth, empty column.
    "1,2026/08/26 09:14:08,013101001305,TRAFFIC,end,16,2026/08/26 09:14:01,"
    "10.0.0.9,1.1.1.1,deny,udp,53,",
    # 8. TRUNCATED mid-field.
    "1,2026/08/26 09:14:09,013101001305,TRAFF",
    # 9. A row that is only delimiters.
    ",,,,,,,,,,,",
    # 10. Not delimited at all - free text where a CSV row belongs.
    "Aug 26 09:14:10 fw-lab-01 kernel: [12345.678] nf_conntrack: table full",
    # 11. A JSON object smuggled into a CSV feed.
    '{"ts":"2026-08-26T09:14:11Z","type":"TRAFFIC","src":"10.0.0.10"}',
    # 12. Ragged whitespace around the delimiters.
    "1 , 2026/08/26 09:14:12 , 013101001305 , TRAFFIC , end , 17 , "
    "2026/08/26 09:14:05 , 10.0.0.11 , 1.1.1.1 , allow , tcp , 80",
]


# ---------------------------------------------------------------------------

BENCHES = ["fortigate_kv", "okta_json", "broken_feed"]
REPEATS = 6


def build():
    out = {b: [] for b in BENCHES}
    i = 0
    for _rep in range(REPEATS):
        for r in FG_ROWS:
            i += 1
            date, time_, iso, epoch = stamp(i)
            out["fortigate_kv"].append({
                "_raw": fortigate_line(r, date, time_, epoch),
                "type": r["type"], "subtype": r["subtype"],
                "host": "FGT-LAB-01", "source": "fortigate:syslog"})
        for r in OKTA_ROWS:
            i += 1
            _d, _t, iso, _e = stamp(i)
            out["okta_json"].append(okta_event(r, iso, i))
        for line in BROKEN_LINES:
            i += 1
            out["broken_feed"].append({"_raw": line})
    return out


if __name__ == "__main__":
    data = build()
    for name, events in data.items():
        with open("%s_events.json" % name, "w", encoding="utf-8") as fh:
            json.dump(events, fh)
        print("%-13s %3d events" % (name, len(events)))
        first = events[0]
        preview = first.get("_raw") or json.dumps(first)
        print("     %s" % preview[:150])
