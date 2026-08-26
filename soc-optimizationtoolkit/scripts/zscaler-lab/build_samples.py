"""Build three Zscaler NSS sample files (CSV, CEF, LEEF), each carrying
DNS / Firewall / Web / Tunnel events, for a Cribl datagen -> Lake lab.

PROVENANCE - every field NAME and ORDER below comes from a Zscaler source:

  CEF   github.com/zscaler/microsoft-resources
        microsoft-sentinel/zia-log-feeds/{dns,fw,web,tunnel}/nss-{...}.cef
        Zscaler's own published CEF feed-output-format strings.

  LEEF  Web: the QRadar LEEF Feed Output Format Zscaler populates when you
        pick "QRadar LEEF" as the Feed Output Type, reproduced at
        docs.rapid7.com/insightidr/zscaler-nss/ ("LEEF:1.0|Zscaler|NSS|4.1|").
        DNS/FW/Tunnel: Zscaler publishes NO LEEF layout for these feeds, so
        these are OPERATOR-AUTHORED LEEF built from the vendor's own CEF field
        set - which is what an admin does in the Custom output box. Marked
        lab-authored in the notes; not presented as vendor-published.

  CSV   Zscaler NSS's DEFAULT Feed Output Type is comma-separated
        (help.zscaler.com/zia/adding-nss-feeds-web-logs: "The output is a
        comma-separated (CSV) list by default"). The COLUMN ORDER is whatever
        the admin types into Feed Output Format - there is no canonical vendor
        order - so the orders below are one plausible admin choice drawn from
        the documented field lists. That is exactly the case the app's
        positional-CSV naming dialog exists for.

  Values are the documented Example column from
        help.zscaler.com/zia/nss-feed-output-format-{web,tunnel}-logs
        plus Zscaler's own sample logs at
        microsoft-sentinel/cloud-nss-test/sample-{dns,fw,web}.log.
        Tunnel algo/authentication/authtype are lab-authored (protocol-standard
        values); every other tunnel value is documented.
"""

import json

# Discriminator field. Zscaler's own JSON feed sets exactly this key with
# exactly these values (cloud-nss-{dns,fw,web,tunnel}.fof "sourcetype").
ST_DNS = "zscalernss-dns"
ST_FW = "zscalernss-fw"
ST_WEB = "zscalernss"
ST_TUN = "zscalernss-tunnel"

# Syslog tag each vendor .cef string emits ahead of the CEF header.
TAG = {ST_DNS: "zscalernss-dns", ST_FW: "zscalernss-fw",
       ST_WEB: "zscaler-nss", ST_TUN: "zscalernss-tunnel"}

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def stamp(i):
    """A deterministic Aug-2026 syslog timestamp; no clock is read."""
    mon, dd = "Aug", 25
    hh = 6 + (i * 7) % 17
    mm = (i * 13) % 60
    ss = (i * 29) % 60
    return "%s %02d %02d:%02d:%02d" % (mon, dd, hh, mm, ss), \
           "2026-08-%02d %02d:%02d:%02d" % (dd, hh, mm, ss)


# --------------------------------------------------------------------------
# Per-feed rows. Keys are the Zscaler field names (the %s{...} token names).
# --------------------------------------------------------------------------

DNS_ROWS = [
    dict(action="Req(allow),Res(allow)", rulelabel="Default Firewall DNS Rule",
         login="jdoe@safemarch.com", dept="Default Department",
         reqaction="Allow", resaction="Allow", reqtype="A",
         req="edgeservices.bing.com", res="www.a.test.zscaler.com",
         durationms="1", reqrulelabel="Default Firewall DNS Rule",
         resrulelabel="Default Firewall DNS Rule", domcat="Web Search",
         cip="192.168.180.253", sip="1.1.1.1", sport="53", location="Home",
         deviceowner="NA", devicehostname="NA"),
    dict(action="Req(allow),Res(allow)", rulelabel="Default Firewall DNS Rule",
         login="user@zscaler.com", dept="Sales",
         reqaction="Allow", resaction="Allow", reqtype="AAAA",
         req="login.microsoftonline.com", res="40.126.32.140",
         durationms="4", reqrulelabel="Default Firewall DNS Rule",
         resrulelabel="Default Firewall DNS Rule",
         domcat="Professional Services",
         cip="192.168.180.41", sip="1.1.1.1", sport="53",
         location="Headquarters", deviceowner="John-Doe",
         devicehostname="John-Doe-PC"),
    dict(action="Req(block),Res(none)", rulelabel="Block Risky DNS",
         login="jdoe@safemarch.com", dept="Default Department",
         reqaction="Block", resaction="None", reqtype="A",
         req="malware.test.zscaler.com", res="None",
         durationms="0", reqrulelabel="Block Risky DNS",
         resrulelabel="None", domcat="Spyware Callback",
         cip="192.168.180.253", sip="1.1.1.1", sport="53", location="Home",
         deviceowner="John-Doe", devicehostname="John-Doe-PC"),
    dict(action="Req(allow),Res(allow)", rulelabel="Default Firewall DNS Rule",
         login="user@zscaler.com", dept="Sales",
         reqaction="Allow", resaction="Allow", reqtype="UNKNOWN",
         req="www.google.com", res="142.250.70.196",
         durationms="2", reqrulelabel="Default Firewall DNS Rule",
         resrulelabel="Default Firewall DNS Rule", domcat="Web Search",
         cip="192.168.180.77", sip="1.1.1.1", sport="53",
         location="Headquarters", deviceowner="NA", devicehostname="NA"),
]

FW_ROWS = [
    dict(action="Drop", rulelabel="Default Firewall Filtering Rule",
         login="jdoe@safemarch.com", csip="192.168.140.31", csport="62964",
         cdip="1.1.1.1", cdport="443", ssip="0.0.0.0", ssport="0",
         sdip="0.0.0.0", sdport="0", tsip="1.1.1.1", tsport="0",
         ipproto="UDP", ttype="ZscalerClientConnector", dnat="No",
         stateful="Yes", location="Home",
         inbytes="0", outbytes="4134", dept="Default Department",
         nwsvc="QUIC", nwapp="udp", aggregate="No", threatcat="None",
         threatname="None", durationms="2998", numsessions="1",
         ipcat="Miscellaneous or Unknown", destcountry="Australia",
         avgduration="2998"),
    dict(action="Allow", rulelabel="Default Firewall Filtering Rule",
         login="user@zscaler.com", csip="192.168.140.52", csport="51330",
         cdip="52.88.186.130", cdport="443", ssip="0.0.0.0", ssport="0",
         sdip="0.0.0.0", sdport="0", tsip="1.1.1.1", tsport="0",
         ipproto="TCP", ttype="ZscalerClientConnector", dnat="No",
         stateful="Yes", location="Headquarters",
         inbytes="18422", outbytes="2310", dept="Sales",
         nwsvc="HTTPS", nwapp="tcp", aggregate="No", threatcat="None",
         threatname="None", durationms="1204", numsessions="1",
         ipcat="Professional Services", destcountry="United States",
         avgduration="1204"),
    dict(action="Drop", rulelabel="Block Outbound SMB",
         login="jdoe@safemarch.com", csip="192.168.140.31", csport="49155",
         cdip="203.0.113.5", cdport="445", ssip="0.0.0.0", ssport="0",
         sdip="0.0.0.0", sdport="0", tsip="1.1.1.1", tsport="0",
         ipproto="TCP", ttype="GRE", dnat="No",
         stateful="Yes", location="Headquarters",
         inbytes="0", outbytes="176", dept="Default Department",
         nwsvc="SMB", nwapp="tcp", aggregate="No", threatcat="None",
         threatname="None", durationms="30", numsessions="1",
         ipcat="Miscellaneous or Unknown", destcountry="United States",
         avgduration="30"),
    dict(action="Allow", rulelabel="Default Firewall Filtering Rule",
         login="user@zscaler.com", csip="192.168.140.90", csport="60122",
         cdip="8.8.8.8", cdport="53", ssip="0.0.0.0", ssport="0",
         sdip="0.0.0.0", sdport="0", tsip="1.1.1.1", tsport="0",
         ipproto="UDP", ttype="IPSEC_IKEV2", dnat="No",
         stateful="Yes", location="Headquarters",
         inbytes="182", outbytes="64", dept="Sales",
         nwsvc="DNS", nwapp="udp", aggregate="Yes", threatcat="None",
         threatname="None", durationms="12", numsessions="6",
         ipcat="Miscellaneous or Unknown", destcountry="United States",
         avgduration="2"),
]

WEB_ROWS = [
    dict(action="Allowed", reason="Allowed", proto="HTTP",
         urlcat="Test Category", ehost="this.is.a.test.zscaler.com",
         sip="1.1.1.1", cip="1.1.1.1", respsize="796584", respcode="206",
         reqsize="446",
         eurl="test.zscaler.com/filestreamingservice/files/199",
         cintip="1.1.1.1", ua="Zscaler-Delivery-Optimization/10.1",
         reqmethod="GET", login="user@zscaler.com", location="Home",
         recordid="7379073205867184130", filetype="None",
         appname="General Browsing", riskscore="0",
         dept="Default Department", urlsupercat="User-defined",
         appclass="General Browsing", malwarecat="None", threatname="None",
         dlpeng="None", urlclass="Bandwidth Loss",
         contenttype="application/octet_stream", deviceowner="John-Doe",
         devicehostname="John-Doe-PC", cloudname="zscaler.net",
         datacenter="SYD3", ssldecrypted="No", threatseverity="None"),
    dict(action="Blocked",
         reason="Not allowed to browse this category", proto="HTTPS",
         urlcat="Adult Themes", ehost="www.blocked-example.com",
         sip="0.0.0.0", cip="192.168.180.253", respsize="0", respcode="403",
         reqsize="812", eurl="www.blocked-example.com/index",
         cintip="203.0.113.5", ua="Mozilla/5.0%20(Windows%20NT%2010.0)",
         reqmethod="GET", login="jdoe@safemarch.com",
         location="Headquarters", recordid="7379073205867184131",
         filetype="None", appname="General Browsing", riskscore="72",
         dept="Sales", urlsupercat="Entertainment/Recreation",
         appclass="General Browsing", malwarecat="None", threatname="None",
         dlpeng="None", urlclass="Privacy Risk", contenttype="None",
         deviceowner="John-Doe", devicehostname="John-Doe-PC",
         cloudname="zscaler.net", datacenter="SYD3", ssldecrypted="Yes",
         threatseverity="Medium"),
    dict(action="Blocked", reason="Virus/Spyware/Malware Blocked",
         proto="HTTPS", urlcat="Spyware Callback",
         ehost="malware.test.zscaler.com", sip="0.0.0.0",
         cip="192.168.180.41", respsize="0", respcode="403", reqsize="640",
         eurl="malware.test.zscaler.com/payload.exe", cintip="203.0.113.5",
         ua="Mozilla/5.0%20(Windows%20NT%2010.0)", reqmethod="GET",
         login="jdoe@safemarch.com", location="Headquarters",
         recordid="7379073205867184132", filetype="Windows Executables",
         appname="General Browsing", riskscore="95", dept="Sales",
         urlsupercat="Security", appclass="General Browsing",
         malwarecat="Trojan", threatname="EICAR Test File", dlpeng="None",
         urlclass="Privacy Risk", contenttype="application/octet_stream",
         deviceowner="John-Doe", devicehostname="John-Doe-PC",
         cloudname="zscaler.net", datacenter="SYD3", ssldecrypted="Yes",
         threatseverity="Critical"),
    dict(action="Allowed", reason="Allowed", proto="HTTPS",
         urlcat="Web Search", ehost="www.google.com", sip="142.250.70.196",
         cip="192.168.180.77", respsize="41028", respcode="200",
         reqsize="1300", eurl="www.google.com/search%3Fq%3Dcribl",
         cintip="203.0.113.5", ua="Mozilla/5.0%20(Windows%20NT%2010.0)",
         reqmethod="GET", login="user@zscaler.com", location="Headquarters",
         recordid="7379073205867184133", filetype="None",
         appname="General Browsing", riskscore="10", dept="Sales",
         urlsupercat="Internet Communication", appclass="General Browsing",
         malwarecat="None", threatname="None", dlpeng="None",
         urlclass="General Surfing", contenttype="text/html",
         deviceowner="John-Doe", devicehostname="John-Doe-PC",
         cloudname="zscaler.net", datacenter="SYD3", ssldecrypted="Yes",
         threatseverity="None"),
]

# Only the two tunnel record types whose tunnelactionname Zscaler DOCUMENTS
# (WL_TUNNEL_IPSECPHASE1 on the IKE Phase 1 table, WL_TUNNEL_EVENT on the
# Tunnel Events table). The Phase 2 and Sample record types have published
# LAYOUTS but their action-name token is not stated on the pages read, and
# inventing one would put a fabricated vendor token in the data.
TUN_ROWS = [
    dict(kind="phase1", tunnelactionname="WL_TUNNEL_IPSECPHASE1",
         sourceip="116.113.61.135", destvip="165.225.104.35",
         srcport="500", dstport="500", ikeversion="2", lifetime="86400",
         algo="AES_CBC_256", authentication="HMAC_SHA2_256_128",
         authtype="PSK", locationname="Headquarters",
         vpncredentialname="jdoe@safemarch.com", vendorname="CISCO",
         recordid="4412887", tz="GMT", spi_in="3221225473",
         spi_out="3221225474", olocationname="Headquarters",
         ovpncredentialname="jdoe@safemarch.com"),
    dict(kind="phase1", tunnelactionname="WL_TUNNEL_IPSECPHASE1",
         sourceip="116.113.61.142", destvip="165.225.104.35",
         srcport="4500", dstport="4500", ikeversion="1", lifetime="86400",
         algo="AES_CBC_128", authentication="HMAC_SHA1_96",
         authtype="PSK", locationname="Home",
         vpncredentialname="user@zscaler.com", vendorname="STRONGSWAN",
         recordid="4412888", tz="GMT", spi_in="3221225475",
         spi_out="3221225476", olocationname="Home",
         ovpncredentialname="user@zscaler.com"),
    dict(kind="event", tunnelactionname="WL_TUNNEL_EVENT",
         sourceip="116.113.61.135", destvip="165.225.104.35",
         srcport="500", event="UP", eventreason="None",
         tunneltype="IPSEC_IKEV2", locationname="Headquarters",
         vpncredentialname="jdoe@safemarch.com", recordid="4412889",
         tz="GMT", olocationname="Headquarters",
         ovpncredentialname="jdoe@safemarch.com"),
    dict(kind="event", tunnelactionname="WL_TUNNEL_EVENT",
         sourceip="116.113.61.142", destvip="165.225.104.35",
         srcport="500", event="DOWN", eventreason="DPD_TIMEOUT",
         tunneltype="GRE", locationname="Home",
         vpncredentialname="user@zscaler.com", recordid="4412890",
         tz="GMT", olocationname="Home",
         ovpncredentialname="user@zscaler.com"),
    dict(kind="event", tunnelactionname="WL_TUNNEL_EVENT",
         sourceip="116.113.61.135", destvip="165.225.104.35",
         srcport="500", event="REKEY", eventreason="EXPIRED",
         tunneltype="IPSEC_IKEV2", locationname="Headquarters",
         vpncredentialname="jdoe@safemarch.com", recordid="4412891",
         tz="GMT", olocationname="Headquarters",
         ovpncredentialname="jdoe@safemarch.com"),
]


# --------------------------------------------------------------------------
# CEF - built from Zscaler's own nss-*.cef format strings, token for token.
# --------------------------------------------------------------------------

def cef_dns(r, ts):
    return ("%s %s CEF:0|Zscaler|NSSDNSlog|5.7|%s|%s|3| act=%s Severity=3 "
            "name=%s deviceEventClassId=%s suser=%s cs1=%s cs1Label=department "
            "cs2=%s cs2Label=reqaction cs3=%s cs3Label=resaction cs4=%s "
            "cs4Label=dns_reqtype cs5=%s cs5Label=dns_req cs6=%s "
            "cs6Label=dns_resp cn1=%s cn1Label=durationms flexString1=%s "
            "flexString1Label=reqrulelabel flexString2=%s "
            "flexString2Label=resrulelabel cat=%s src=%s dst=%s dpt=%s "
            "spriv=%s suid=%s dvchost=%s") % (
        ts, TAG[ST_DNS], r["action"], r["rulelabel"], r["action"],
        r["rulelabel"], r["action"], r["login"], r["dept"], r["reqaction"],
        r["resaction"], r["reqtype"], r["req"], r["res"], r["durationms"],
        r["reqrulelabel"], r["resrulelabel"], r["domcat"], r["cip"],
        r["sip"], r["sport"], r["location"], r["deviceowner"],
        r["devicehostname"])


def cef_fw(r, ts):
    return ("%s %s CEF:0|Zscaler|NSSFWlog|5.7|%s|%s|3| Severity=3 name=%s "
            "deviceEventClassId=%s act=%s suser=%s src=%s spt=%s dst=%s dpt=%s "
            "deviceTranslatedAddress=%s deviceTranslatedPort=%s "
            "destinationTranslatedAddress=%s destinationTranslatedPort=%s "
            "sourceTranslatedAddress=%s sourceTranslatedPort=%s proto=%s "
            "tunnelType=%s dnat=%s stateful=%s spriv=%s reason=%s in_bytes=%s "
            "in=%s out=%s deviceDirection=1 cs1=%s cs1Label=dept cs2=%s "
            "cs2Label=nwService cs3=%s cs3Label=nwApp cs4=%s "
            "cs4Label=aggregated cs5=%s cs5Label=threatcat cs6=%s "
            "cs6label=threatname cn1=%s cn1Label=durationms cn2=%s "
            "cn2Label=numsessions flexString1Label=ipCat flexString1=%s "
            "destCountry=%s avgduration=%s") % (
        ts, TAG[ST_FW], r["action"], r["rulelabel"], r["rulelabel"],
        r["action"], r["action"], r["login"], r["csip"], r["csport"],
        r["cdip"], r["cdport"], r["ssip"], r["ssport"], r["sdip"],
        r["sdport"], r["tsip"], r["tsport"], r["ipproto"], r["ttype"],
        r["dnat"], r["stateful"], r["location"], r["rulelabel"],
        r["inbytes"], r["inbytes"], r["outbytes"], r["dept"], r["nwsvc"],
        r["nwapp"], r["aggregate"], r["threatcat"], r["threatname"],
        r["durationms"], r["numsessions"], r["ipcat"], r["destcountry"],
        r["avgduration"])


def cef_web(r, ts):
    return ("%s %s CEF:0|Zscaler|NSSWeblog|5.7|%s|%s|3|act=%s Severity=3 "
            "name=%s deviceEventClassId=%s app=%s cat=%s dhost=%s dst=%s "
            "src=%s in_bytes=%s in=%s outcome=%s out=%s request=%s rt=%s "
            "sourceTranslatedAddress=%s requestClientApplication=%s "
            "requestMethod=%s suser=%s spriv=%s externalId=%s fileType=%s "
            "reason=%s destinationServiceName=%s cn1=%s cn1Label=riskscore "
            "cs1=%s cs1Label=dept cs2=%s cs2Label=urlsupercat cs3=%s "
            "cs3Label=appclass cs4=%s cs4Label=malwarecat cs5=%s "
            "cs5Label=threatname cs6=%s cs6Label=dlpeng "
            "ZscalerNSSWeblogURLClass=%s contenttype=%s deviceowner=%s "
            "devicehostname=%s cloudname=%s datacenter=%s ssldecrypted=%s "
            "threatseverity=%s") % (
        ts, TAG[ST_WEB], r["action"], r["reason"], r["action"], r["reason"],
        r["action"], r["proto"], r["urlcat"], r["ehost"], r["sip"], r["cip"],
        r["respsize"], r["respsize"], r["respcode"], r["reqsize"], r["eurl"],
        ts, r["cintip"], r["ua"], r["reqmethod"], r["login"], r["location"],
        r["recordid"], r["filetype"], r["reason"], r["appname"],
        r["riskscore"], r["dept"], r["urlsupercat"], r["appclass"],
        r["malwarecat"], r["threatname"], r["dlpeng"], r["urlclass"],
        r["contenttype"], r["deviceowner"], r["devicehostname"],
        r["cloudname"], r["datacenter"], r["ssldecrypted"],
        r["threatseverity"])


def cef_tunnel(r, ts):
    if r["kind"] == "phase1":
        return ("%s %s CEF:0|Zscaler|NSSTunnellog|5.7|%s|%s|3| dpt=%s "
                "cn1Label=ikeversion cn1=%s cfp1Label=lifetime cfp1=%s spt=%s "
                "spi_in=%s spi_out=%s cs1Label=algo cs1=%s "
                "cs2Label=authentication cs2=%s cs3Label=authtype cs3=%s "
                "dst=%s cs4Label=locationname cs4=%s src=%s "
                "deviceEventClassId=%s vendorname=%s suser=%s "
                "deviceExternalId=%s olocationname=%s ovpncredentialname=%s "
                "dtz=%s") % (
            ts, TAG[ST_TUN], r["tunnelactionname"], r["destvip"],
            r["dstport"], r["ikeversion"], r["lifetime"], r["srcport"],
            r["spi_in"], r["spi_out"], r["algo"], r["authentication"],
            r["authtype"], r["destvip"], r["locationname"], r["sourceip"],
            r["tunnelactionname"], r["vendorname"], r["vpncredentialname"],
            r["recordid"], r["olocationname"], r["ovpncredentialname"],
            r["tz"])
    return ("%s %s CEF:0|Zscaler|NSSTunnellog|5.7|%s|%s|3| spt=%s dst=%s "
            "name=%s reason=%s cs4Label=locationname cs4=%s src=%s "
            "deviceEventClassId=%s cs5Label=tunneltype cs5=%s suser=%s "
            "deviceExternalId=%s olocationname=%s ovpncredentialname=%s "
            "dtz=%s") % (
        ts, TAG[ST_TUN], r["tunnelactionname"], r["event"], r["srcport"],
        r["destvip"], r["event"], r["eventreason"], r["locationname"],
        r["sourceip"], r["tunnelactionname"], r["tunneltype"],
        r["vpncredentialname"], r["recordid"], r["olocationname"],
        r["ovpncredentialname"], r["tz"])


# --------------------------------------------------------------------------
# LEEF. Header + tab-delimited key=value pairs (LEEF 1.0).
# Web follows Zscaler's published QRadar LEEF string; the other three are
# operator-authored from the vendor's CEF field set.
# --------------------------------------------------------------------------

T = "\t"


def _leef(event_id, pairs, ts, tag):
    body = T.join("%s=%s" % (k, v) for k, v in pairs)
    return "%s %s: LEEF:1.0|Zscaler|NSS|4.1|%s|%s" % (ts, tag, event_id, body)


def leef_web(r, ts):
    pairs = [
        ("cat", r["action"]),
        ("devTime", ts + " GMT"),
        ("devTimeFormat", "MMM dd yyyy HH:mm:ss z"),
        ("src", r["cip"]), ("dst", r["sip"]), ("srcPostNAT", r["cintip"]),
        ("realm", r["location"]), ("usrName", r["login"]),
        ("srcBytes", r["reqsize"]), ("dstBytes", r["respsize"]),
        ("role", r["dept"]), ("policy", r["reason"]), ("url", r["eurl"]),
        ("recordid", r["recordid"]), ("bwthrottle", "NO"),
        ("useragent", r["ua"]), ("referer", "None"), ("hostname", r["ehost"]),
        ("appproto", r["proto"]), ("urlcategory", r["urlcat"]),
        ("urlsupercategory", r["urlsupercat"]), ("urlclass", r["urlclass"]),
        ("appclass", r["appclass"]), ("appname", r["appname"]),
        ("malwaretype", r["malwarecat"]), ("malwareclass", "None"),
        ("threatname", r["threatname"]), ("riskscore", r["riskscore"]),
        ("dlpdict", "None"), ("dlpeng", r["dlpeng"]), ("fileclass", "None"),
        ("filetype", r["filetype"]), ("reqmethod", r["reqmethod"]),
        ("respcode", r["respcode"]), ("contenttype", r["contenttype"]),
        ("unscannabletype", "None"), ("deviceowner", r["deviceowner"]),
        ("devicehostname", r["devicehostname"]), ("bypassedtraffic", "0"),
    ]
    return _leef(r["reason"], pairs, ts, TAG[ST_WEB])


def leef_dns(r, ts):
    pairs = [
        ("cat", r["action"]), ("devTime", ts + " GMT"),
        ("devTimeFormat", "MMM dd yyyy HH:mm:ss z"),
        ("src", r["cip"]), ("dst", r["sip"]), ("dstPort", r["sport"]),
        ("usrName", r["login"]), ("realm", r["location"]),
        ("role", r["dept"]), ("policy", r["rulelabel"]),
        ("reqaction", r["reqaction"]), ("resaction", r["resaction"]),
        ("dns_reqtype", r["reqtype"]), ("dns_req", r["req"]),
        ("dns_resp", r["res"]), ("durationms", r["durationms"]),
        ("reqrulelabel", r["reqrulelabel"]),
        ("resrulelabel", r["resrulelabel"]), ("domcat", r["domcat"]),
        ("deviceowner", r["deviceowner"]),
        ("devicehostname", r["devicehostname"]),
    ]
    return _leef(r["action"], pairs, ts, TAG[ST_DNS])


def leef_fw(r, ts):
    pairs = [
        ("cat", r["action"]), ("devTime", ts + " GMT"),
        ("devTimeFormat", "MMM dd yyyy HH:mm:ss z"),
        ("src", r["csip"]), ("srcPort", r["csport"]),
        ("dst", r["cdip"]), ("dstPort", r["cdport"]),
        ("srcPostNAT", r["tsip"]), ("proto", r["ipproto"]),
        ("usrName", r["login"]), ("realm", r["location"]),
        ("role", r["dept"]), ("policy", r["rulelabel"]),
        ("srcBytes", r["outbytes"]), ("dstBytes", r["inbytes"]),
        ("tunnelType", r["ttype"]), ("dnat", r["dnat"]),
        ("stateful", r["stateful"]), ("nwService", r["nwsvc"]),
        ("nwApp", r["nwapp"]), ("aggregated", r["aggregate"]),
        ("threatcat", r["threatcat"]), ("threatname", r["threatname"]),
        ("durationms", r["durationms"]), ("numsessions", r["numsessions"]),
        ("ipCat", r["ipcat"]), ("destCountry", r["destcountry"]),
    ]
    return _leef(r["action"], pairs, ts, TAG[ST_FW])


def leef_tunnel(r, ts):
    if r["kind"] == "phase1":
        pairs = [
            ("cat", r["tunnelactionname"]), ("devTime", ts + " GMT"),
            ("devTimeFormat", "MMM dd yyyy HH:mm:ss z"),
            ("src", r["sourceip"]), ("srcPort", r["srcport"]),
            ("dst", r["destvip"]), ("dstPort", r["dstport"]),
            ("usrName", r["vpncredentialname"]),
            ("locationname", r["locationname"]),
            ("ikeversion", r["ikeversion"]), ("lifetime", r["lifetime"]),
            ("spi_in", r["spi_in"]), ("spi_out", r["spi_out"]),
            ("algo", r["algo"]), ("authentication", r["authentication"]),
            ("authtype", r["authtype"]), ("vendorname", r["vendorname"]),
            ("recordid", r["recordid"]), ("dtz", r["tz"]),
        ]
    else:
        pairs = [
            ("cat", r["tunnelactionname"]), ("devTime", ts + " GMT"),
            ("devTimeFormat", "MMM dd yyyy HH:mm:ss z"),
            ("src", r["sourceip"]), ("srcPort", r["srcport"]),
            ("dst", r["destvip"]), ("usrName", r["vpncredentialname"]),
            ("locationname", r["locationname"]), ("event", r["event"]),
            ("reason", r["eventreason"]), ("tunneltype", r["tunneltype"]),
            ("recordid", r["recordid"]), ("dtz", r["tz"]),
        ]
    return _leef(r["tunnelactionname"], pairs, ts, TAG[ST_TUN])


# --------------------------------------------------------------------------
# CSV - comma-separated, NO header row. The order is an admin's Feed Output
# Format choice; the names live only in the CSV_ORDER table below, which is
# what gets handed to the app's column-naming dialog.
# --------------------------------------------------------------------------

CSV_ORDER = {
    ST_DNS: ["datetime", "sourcetype", "action", "rulelabel", "login", "dept",
             "reqaction", "resaction", "reqtype", "req", "res", "durationms",
             "reqrulelabel", "resrulelabel", "domcat", "cip", "sip", "sport",
             "location", "deviceowner", "devicehostname"],
    ST_FW: ["datetime", "sourcetype", "action", "rulelabel", "login", "csip",
            "csport", "cdip", "cdport", "tsip", "tsport", "ipproto", "ttype",
            "dnat", "stateful", "location", "inbytes", "outbytes", "dept",
            "nwsvc", "nwapp", "aggregate", "threatcat", "threatname",
            "durationms", "numsessions", "ipcat", "destcountry",
            "avgduration"],
    ST_WEB: ["datetime", "sourcetype", "action", "reason", "proto", "urlcat",
             "urlsupercat", "urlclass", "ehost", "eurl", "cip", "cintip",
             "sip", "reqsize", "respsize", "respcode", "reqmethod", "ua",
             "login", "dept", "location", "recordid", "filetype", "appname",
             "appclass", "riskscore", "malwarecat", "threatname",
             "threatseverity", "dlpeng", "contenttype", "deviceowner",
             "devicehostname", "cloudname", "datacenter", "ssldecrypted"],
    ST_TUN: ["datetime", "sourcetype", "tunnelactionname", "sourceip",
             "srcport", "destvip", "dstport", "vpncredentialname",
             "locationname", "tunneltype", "event", "eventreason",
             "ikeversion", "lifetime", "algo", "authentication", "authtype",
             "vendorname", "recordid", "tz"],
}


def csv_row(r, st, iso):
    vals = []
    for name in CSV_ORDER[st]:
        if name == "datetime":
            vals.append(iso)
        elif name == "sourcetype":
            vals.append(st)
        else:
            vals.append(str(r.get(name, "None")))
    # Zscaler hex-encodes delimiter characters (Feed Escape Character); an
    # embedded comma would otherwise shift every column after it.
    return ",".join(v.replace(",", "%2C") for v in vals)


# --------------------------------------------------------------------------

FEEDS = [
    (ST_DNS, DNS_ROWS, cef_dns, leef_dns),
    (ST_FW, FW_ROWS, cef_fw, leef_fw),
    (ST_WEB, WEB_ROWS, cef_web, leef_web),
    (ST_TUN, TUN_ROWS, cef_tunnel, leef_tunnel),
]

REPEATS = 4  # events per row per feed -> 4*(4+4+4+5) = 68 events per file


def build():
    out = {"csv": [], "cef": [], "leef": []}
    i = 0
    for rep in range(REPEATS):
        for st, rows, cef_fn, leef_fn in FEEDS:
            for r in rows:
                i += 1
                syslog_ts, iso_ts = stamp(i)
                common = {"sourcetype": st, "host": "nss.zscaler.net",
                          "source": "zscaler:nss"}
                out["cef"].append(dict(_raw=cef_fn(r, syslog_ts), **common))
                out["leef"].append(dict(_raw=leef_fn(r, syslog_ts), **common))
                out["csv"].append(dict(_raw=csv_row(r, st, iso_ts), **common))
    return out


if __name__ == "__main__":
    data = build()
    for fmt, events in data.items():
        path = "zscaler_%s_events.json" % fmt
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(events, fh)
        counts = {}
        for e in events:
            counts[e["sourcetype"]] = counts.get(e["sourcetype"], 0) + 1
        print("%-5s %3d events  %s" % (fmt, len(events), counts))
        print("      sample: %s" % events[0]["_raw"][:150])
