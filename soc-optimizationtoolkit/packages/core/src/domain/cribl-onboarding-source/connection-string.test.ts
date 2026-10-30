import { describe, expect, it } from "vitest";
import { readRefused, readRows } from "../logging-map/list-read";
import type { NamespaceAuthRule } from "../eventhub-arm";
import {
  checkPastedCredential,
  parseEventHubConnectionString,
  sameDescriptor,
  type ConnectionDescriptor,
} from "./connection-string";

const SAMPLE =
  "Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=reader;SharedAccessKey=abc;EntityPath=h1";

describe("parseEventHubConnectionString", () => {
  it("returns host, key name and entity path - never the key", () => {
    const d = parseEventHubConnectionString(SAMPLE);
    expect(d).toEqual({ host: "ns1.servicebus.windows.net", keyName: "reader", entityPath: "h1" });
    expect(JSON.stringify(d)).not.toContain("abc");
  });

  it("keeps base64 padding in a value and matches keys case-insensitively", () => {
    const d = parseEventHubConnectionString(
      "endpoint=sb://NS1.servicebus.windows.net/;sharedaccesskeyname=r;sharedaccesskey=k==",
    );
    expect(d).toEqual({ host: "ns1.servicebus.windows.net", keyName: "r" });
  });

  it("is invalid without an endpoint, key name or key, and never echoes the key", () => {
    expect(parseEventHubConnectionString("")).toEqual({ invalid: "empty" });
    expect(parseEventHubConnectionString("garbage")).toEqual({ invalid: "malformed" });
    expect(parseEventHubConnectionString("SharedAccessKeyName=r;SharedAccessKey=zzz")).toEqual({ invalid: "no-endpoint" });
    expect(parseEventHubConnectionString("Endpoint=sb://a.servicebus.windows.net/;SharedAccessKey=zzz")).toEqual({ invalid: "no-key-name" });
    const noKey = parseEventHubConnectionString("Endpoint=sb://a.servicebus.windows.net/;SharedAccessKeyName=r");
    expect(noKey).toEqual({ invalid: "no-key" });
    expect(JSON.stringify(parseEventHubConnectionString("Endpoint=x;SharedAccessKey=zzz"))).not.toContain("zzz");
  });
});

describe("sameDescriptor", () => {
  const a: ConnectionDescriptor = { host: "ns1.servicebus.windows.net", keyName: "reader", entityPath: "h1" };
  it("is true for the same target and false when any part changes", () => {
    expect(sameDescriptor(a, { ...a })).toBe(true);
    expect(sameDescriptor(a, { ...a, keyName: "other" })).toBe(false);
    expect(sameDescriptor(a, { ...a, host: "ns2.servicebus.windows.net" })).toBe(false);
    expect(sameDescriptor(a, { host: a.host, keyName: a.keyName })).toBe(false);
  });
});

describe("checkPastedCredential", () => {
  const rules = readRows<NamespaceAuthRule>([
    { name: "sender", id: "r1", rights: ["Send"] },
    { name: "reader", id: "r2", rights: ["Listen"] },
    { name: "admin", id: "r3", rights: ["Manage", "Listen", "Send"] },
  ]);
  const ctx = { namespace: "ns1", topics: ["h1"], rules, attested: false };
  const d = (keyName: string, extra: Partial<ConnectionDescriptor> = {}): ConnectionDescriptor => ({
    host: "ns1.servicebus.windows.net",
    keyName,
    ...extra,
  });
  const denied = readRefused<NamespaceAuthRule>({
    request: "/x/authorizationRules",
    status: 403,
    code: "AuthorizationFailed",
    text: "denied",
    reason: "http",
  });

  it("refuses a Send-only rule", () => {
    expect(checkPastedCredential(d("sender"), ctx)).toMatchObject({ ok: false, reason: "rule-cannot-listen" });
  });

  it("accepts a Listen rule and a Manage-only rule", () => {
    expect(checkPastedCredential(d("reader"), ctx)).toEqual({ ok: true, attested: false });
    const manageOnly = readRows<NamespaceAuthRule>([{ name: "m", id: "x", rights: ["Manage"] }]);
    expect(checkPastedCredential(d("m"), { ...ctx, rules: manageOnly })).toEqual({ ok: true, attested: false });
  });

  it("refuses another namespace", () => {
    expect(checkPastedCredential(d("reader", { host: "ns2.servicebus.windows.net" }), ctx)).toMatchObject({
      ok: false,
      reason: "wrong-namespace",
    });
  });

  it("refuses an EntityPath for a hub the lane does not read, accepts the lane's own", () => {
    expect(checkPastedCredential(d("reader", { entityPath: "h2" }), ctx)).toMatchObject({ ok: false, reason: "entity-mismatch" });
    expect(checkPastedCredential(d("reader", { entityPath: "h1" }), ctx)).toEqual({ ok: true, attested: false });
    expect(checkPastedCredential(d("reader", { entityPath: "h1" }), { ...ctx, topics: ["h1", "h3"] })).toMatchObject({
      ok: false,
      reason: "entity-mismatch",
    });
  });

  it("refuses a rule the namespace does not list", () => {
    expect(checkPastedCredential(d("ghost"), ctx)).toMatchObject({ ok: false, reason: "unknown-rule" });
  });

  it("treats a refused rules read as unknown rights unless attested", () => {
    expect(checkPastedCredential(d("sender"), { ...ctx, rules: denied })).toMatchObject({ ok: false, reason: "rule-rights-unknown" });
    expect(checkPastedCredential(d("sender"), { ...ctx, rules: denied, attested: true })).toEqual({ ok: true, attested: true });
  });

  it("ignores an attestation when the rules WERE read", () => {
    expect(checkPastedCredential(d("sender"), { ...ctx, attested: true })).toMatchObject({ ok: false, reason: "rule-cannot-listen" });
  });
});
