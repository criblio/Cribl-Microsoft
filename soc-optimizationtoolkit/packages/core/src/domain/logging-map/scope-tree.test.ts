// Pins for the logging-map scope tree (AZR-19, U1a).

import { describe, expect, it } from "vitest";

import type { ScopeEntry } from "./logging-map-types";
import {
  PARENT_UNKNOWN_ID,
  ancestorsOf,
  buildScopeTree,
  descendantsOf,
  ensureOriginScopes,
  normaliseScopeId,
  rootsFromVisible,
  scopeKindOfId,
} from "./scope-tree";

const TENANT = "aaaa0000-0000-0000-0000-00000000tnnt";
const mg = (name: string) => `/providers/Microsoft.Management/managementGroups/${name}`;
const sub = (id: string) => `/subscriptions/${id}`;
const e = (id: string, parentId: string | null, displayName = ""): ScopeEntry => ({
  id,
  name: id.split("/").pop() ?? "",
  displayName,
  parentId,
});
const n = normaliseScopeId;

// root -> platform -> landing; root -> sub-a; landing -> sub-b, sub-c
const THREE_LEVEL: ScopeEntry[] = [
  e(mg(TENANT), null, "Tenant Root Group"),
  e(mg("Platform"), mg(TENANT)),
  e(mg("Landing"), mg("Platform")),
  e(sub("A"), mg(TENANT)),
  e(sub("B"), mg("Landing")),
  e(sub("C"), mg("Landing")),
];

describe("normaliseScopeId", () => {
  it("lower-cases, adds a leading slash, drops trailing slashes", () => {
    expect(normaliseScopeId("Subscriptions/ABC/")).toBe("/subscriptions/abc");
    expect(normaliseScopeId("  /Providers/Microsoft.Management/managementGroups/X//  ")).toBe(
      "/providers/microsoft.management/managementgroups/x",
    );
    expect(normaliseScopeId("")).toBe("");
  });
});

describe("scopeKindOfId", () => {
  it("names the tenant root, groups and subscriptions, and nothing else", () => {
    expect(scopeKindOfId(mg(TENANT.toUpperCase()), TENANT)).toBe("tenant-root");
    expect(scopeKindOfId(mg("x"), TENANT)).toBe("management-group");
    expect(scopeKindOfId(sub("s"), TENANT)).toBe("subscription");
    expect(scopeKindOfId(`${sub("s")}/resourceGroups/rg`, TENANT)).toBeNull();
  });
});

describe("buildScopeTree", () => {
  it("parents a three-level hierarchy correctly", () => {
    const tree = buildScopeTree({ tenantId: TENANT, entries: THREE_LEVEL });
    expect(tree.roots).toEqual([n(mg(TENANT))]);
    expect(tree.byId.get(n(mg(TENANT)))?.kind).toBe("tenant-root");
    expect(tree.byId.get(n(mg(TENANT)))?.displayName).toBe("Tenant Root Group");
    expect(tree.childrenOf.get(n(mg(TENANT)))).toEqual([n(mg("Platform")), n(sub("A"))]);
    expect(tree.childrenOf.get(n(mg("Platform")))).toEqual([n(mg("Landing"))]);
    expect(tree.childrenOf.get(n(mg("Landing")))).toEqual([n(sub("B")), n(sub("C"))]);
    expect(tree.nodes).toHaveLength(6);
    expect(tree.nodes.every((x) => x.treeRole === "listed")).toBe(true);
    expect(tree.byId.has(PARENT_UNKNOWN_ID)).toBe(false);
  });

  it("the same scope in two casings is ONE node, and a mixed-case parent resolves", () => {
    const tree = buildScopeTree({
      tenantId: TENANT,
      entries: [
        e(mg("Corp"), null),
        e(mg("CORP").toLowerCase(), null),
        e(sub("S1"), mg("corp").toUpperCase()),
      ],
    });
    expect(tree.nodes).toHaveLength(2);
    expect(tree.byId.get(n(sub("S1")))?.parentId).toBe(n(mg("Corp")));
    expect(tree.roots).toEqual([n(mg("Corp"))]);
  });

  it("puts every subscription with an unread parent under ONE parent-unknown node", () => {
    const tree = buildScopeTree({
      tenantId: TENANT,
      entries: [e(mg("Visible"), null), e(sub("O1"), null), e(sub("O2"), mg("Hidden")), e(sub("K"), mg("Visible"))],
    });
    const holders = tree.nodes.filter((x) => x.treeRole === "parent-unknown");
    expect(holders).toHaveLength(1);
    expect(holders[0]?.kind).toBe("placeholder");
    expect(tree.childrenOf.get(PARENT_UNKNOWN_ID)).toEqual([n(sub("O1")), n(sub("O2"))]);
    expect(tree.roots).toEqual([n(mg("Visible")), PARENT_UNKNOWN_ID]);
    expect(descendantsOf(tree, PARENT_UNKNOWN_ID)).toHaveLength(2);
  });

  it("drops ids that are not tree scopes", () => {
    const tree = buildScopeTree({ tenantId: TENANT, entries: [e(`${sub("x")}/resourceGroups/rg`, null)] });
    expect(tree.nodes).toHaveLength(0);
  });
});

describe("rootsFromVisible", () => {
  it("picks only the groups whose parent is not visible", () => {
    const visible = [
      e(mg("A"), mg(TENANT)), // root unread -> A is a root
      e(mg("A1"), mg("A")),
      e(mg("B"), null),
      e(mg("a1").toLowerCase(), mg("a")), // same as A1, other casing
    ];
    expect(rootsFromVisible(visible)).toEqual([n(mg("A")), n(mg("B"))]);
  });
});

describe("ensureOriginScopes", () => {
  it("adds ONE unread-origin node for two assignments sharing an unknown group", () => {
    const tree = buildScopeTree({ tenantId: TENANT, entries: [e(sub("S"), null)] });
    const next = ensureOriginScopes(tree, [mg("Secret"), mg("SECRET"), sub("S"), `${sub("S")}/resourceGroups/rg`]);
    const origins = next.nodes.filter((x) => x.treeRole === "unread-origin");
    expect(origins).toHaveLength(1);
    expect(origins[0]).toEqual({
      id: n(mg("Secret")),
      kind: "management-group",
      name: "Secret",
      displayName: "Secret",
      parentId: null,
      treeRole: "unread-origin",
    });
    expect(next.roots).toEqual([n(mg("Secret")), PARENT_UNKNOWN_ID]);
  });

  it("returns the same tree when every origin is already present", () => {
    const tree = buildScopeTree({ tenantId: TENANT, entries: THREE_LEVEL });
    expect(ensureOriginScopes(tree, [mg("platform")])).toBe(tree);
  });
});

describe("ancestorsOf / descendantsOf", () => {
  const tree = buildScopeTree({ tenantId: TENANT, entries: THREE_LEVEL });

  it("ancestors nearest first, from any casing", () => {
    expect(ancestorsOf(tree, sub("b").toUpperCase()).map((x) => x.id)).toEqual([
      n(mg("Landing")),
      n(mg("Platform")),
      n(mg(TENANT)),
    ]);
    expect(ancestorsOf(tree, mg(TENANT))).toEqual([]);
  });

  it("descendants breadth-first", () => {
    expect(descendantsOf(tree, mg("Platform")).map((x) => x.id)).toEqual([
      n(mg("Landing")),
      n(sub("B")),
      n(sub("C")),
    ]);
    expect(descendantsOf(tree, mg(TENANT))).toHaveLength(5);
  });
});
