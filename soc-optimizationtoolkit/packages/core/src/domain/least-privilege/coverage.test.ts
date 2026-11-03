/**
 * COVERAGE PIN - every Azure request the toolkit builds - in @soc/core,
 * @soc/ui and the cribl-app shell - maps to a least-privilege registry
 * operation. An unmapped call fails (ADR 0009
 * decision 4: "A pin fails when an Azure call site in the code has no
 * registry row").
 *
 * The sites are found by reading the source (call-sites.testkit.ts): every
 * object literal shaped like an AzureManagementRequest, with its path worked
 * out symbolically. So a new builder, or a new inline `azure.request({...})`
 * in a use case, is checked the moment it is written - nobody has to remember
 * to list it.
 *
 * OPAQUE SITES. A few sites send a path that is a run-time value end to end -
 * a resource id read back from Azure, or a request built elsewhere and passed
 * in. Their path cannot be worked out from the source, so they are declared
 * below, per file, with the operations they reach. The pin holds the COUNT of
 * opaque sites per file to the declaration, so a new opaque site fails until
 * someone says what it reaches.
 *
 * ID-RELATIVE SITES. A site whose path is a run-time resource id followed by
 * a child or an action (`${hubId}/consumergroups`, `${workspaceId}/query`) is
 * half readable: the tail is literal, but which resource TYPE the id names is
 * not, and the type decides the permission (`${id}/listKeys` is an Event Hub
 * key read or a storage key read). operationsForCall therefore matches none
 * of them, and they are declared below with the operations they reach; each
 * declared operation must have a call whose path ends in the site's tail.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findAzureCallSites } from "./call-sites.testkit";
import type { CallSite } from "./call-sites.testkit";
import { LEAST_PRIVILEGE_OPERATIONS, operationsForCall } from "./least-privilege";
import type { OperationId } from "./least-privilege";

/** The toolkit root; every site and every declaration below is relative to it. */
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SRC_DIRS = ["packages/core/src", "packages/ui/src", "apps/cribl-app/src"].map(
  (dir) => fileURLToPath(new URL(`../../../../../${dir}/`, import.meta.url)),
);

/** A path with no literal segment: nothing in it can be matched. */
function isOpaque(path: string): boolean {
  return path.split("/").every((segment) => segment === "" || segment === "{}");
}

interface OpaqueDeclaration {
  readonly count: number;
  readonly operations: readonly OperationId[];
  readonly why: string;
}

/** The shell: the only place that fetches Graph and token URLs directly. */
const SHELL_DIR = SRC_DIRS[2] ?? "";

/** Opaque sites, per file (path relative to the toolkit root). */
const OPAQUE_SITES: Readonly<Record<string, OpaqueDeclaration>> = {
  "packages/core/src/domain/defender-export/defender-automation.ts": {
    count: 1,
    operations: ["defender.automation.read"],
    why: "reads the automation back by the id the PUT returned",
  },
  "packages/core/src/domain/logging-map/logging-map-requests.ts": {
    count: 2,
    operations: ["policy.definition.read", "rbac.roleDefinition.read"],
    why: "reads a policy or role definition by the id an assignment names",
  },
  "packages/core/src/usecases/deployment-preview/deployment-preview.ts": {
    count: 3,
    operations: ["dcr.read", "dce.read", "dcr.write", "table.write"],
    why: "reads a matched DCR and the DCE it names by resource id, and copies planned PUTs into the preview",
  },
  "packages/ui/src/screens/setup-wizard/azure-resources-section.tsx": {
    count: 1,
    operations: ["rbac.permissions.read"],
    why: "reads permissions at each scope permissionScopeChecks (@soc/core) names",
  },
  "packages/core/src/usecases/onboard-table/onboard-table.ts": {
    count: 3,
    operations: ["dcr.write", "dcr.read"],
    why: "sends the DCR request built by onboard-batch or the caller, then polls and verifies it by the same path",
  },
  "packages/core/src/usecases/update-dcr/update-dcr.ts": {
    count: 3,
    operations: ["table.write", "table.read"],
    why: "writes and re-reads a table whose path the caller resolved",
  },
};

/**
 * Id-relative sites, per file: a run-time id then a literal child or action.
 * Each entry pairs the literal tail with the operations it reaches.
 */
const ID_RELATIVE_SITES: Readonly<Record<string, readonly { tail: string; operations: readonly OperationId[]; why: string }[]>> = {
  "packages/core/src/domain/eventhub-discovery/eventhub-discovery.ts": [
    {
      tail: "consumergroups",
      operations: ["eventhub.consumerGroups.list"],
      why: "the id is an Event Hub (listConsumerGroupsRequest(hubResourceId))",
    },
    {
      tail: "authorizationRules",
      operations: ["eventhub.hubRules.list"],
      why: "the id is an Event Hub (listAuthRulesRequest(hubResourceId))",
    },
  ],
  "packages/core/src/usecases/workspace-inventory/workspace-inventory.ts": [
    {
      tail: "query",
      operations: ["workspace.query"],
      why: "the id is the Log Analytics workspace (runWorkspaceQuery(workspaceId))",
    },
  ],
};

/** A leading run-time id followed by a literal child or action that no operation matches on its own. */
function isIdRelative(path: string, methods: readonly string[]): boolean {
  const segments = path.split("/");
  return (
    segments[0] === "{}" &&
    (segments[1] ?? "").toLowerCase() !== "providers" &&
    !isOpaque(path) &&
    !methods.some((method) => operationsForCall(method, path).length > 0)
  );
}

/** The literal part after an id-relative site's leading id. */
function tailOf(path: string): string {
  return path.split("/").slice(1).join("/");
}

let sitesCache: CallSite[] | undefined;
function sites(): CallSite[] {
  sitesCache ??= findAzureCallSites(SRC_DIRS, ROOT, [SHELL_DIR]);
  return sitesCache;
}

describe("least-privilege coverage of Azure call sites", () => {
  it("finds the Azure request sites at all (a broken finder must not pass vacuously)", () => {
    // 178 on 2026-11-03. A floor, not an exact count, so adding a call does
    // not fail here - the mapping test below is what judges new calls.
    expect(sites().length).toBeGreaterThanOrEqual(170);
  }, 120_000);

  it("sweeps the UI and the shell too, including the shell's Graph and token URLs", () => {
    // Found by review: the sweep once read packages/core/src only, so an ARM
    // call built in a UI screen, or a Graph call in the shell, was never held
    // to a registry row.
    const reached = (file: string): string[] =>
      sites()
        .filter((site) => site.file === file)
        .flatMap((site) =>
          site.paths.flatMap((path) => site.methods.flatMap((m) => operationsForCall(m, path).map((op) => op.id))),
        );
    expect(reached("packages/ui/src/screens/setup-wizard/azure-resources-section.tsx")).toContain(
      "workspaces.list",
    );
    expect(reached("apps/cribl-app/src/platform/adapters.ts")).toContain("graph.servicePrincipals.read");
    expect(reached("apps/cribl-app/src/platform/http.ts")).toContain("entra.token");
  }, 120_000);

  it("maps every site with a readable path to at least one registry operation", () => {
    const unmapped: string[] = [];
    for (const site of sites()) {
      for (const path of site.paths.filter((p) => !isOpaque(p) && !isIdRelative(p, site.methods))) {
        const matched = site.methods.some((method) => operationsForCall(method, path).length > 0);
        if (!matched) {
          unmapped.push(`${site.file}:${site.line} ${site.methods.join("|")} ${path}`);
        }
      }
    }
    expect(unmapped).toEqual([]);
  }, 120_000);

  it("declares every opaque site, per file, with the operations it reaches", () => {
    const counts = new Map<string, number>();
    for (const site of sites()) {
      if (site.paths.every(isOpaque)) {
        counts.set(site.file, (counts.get(site.file) ?? 0) + 1);
      }
    }
    const declared = Object.fromEntries(
      Object.entries(OPAQUE_SITES).map(([file, d]) => [file, d.count]),
    );
    expect(Object.fromEntries(counts)).toEqual(declared);
    for (const d of Object.values(OPAQUE_SITES)) {
      expect(d.operations.length).toBeGreaterThan(0);
      for (const id of d.operations) {
        expect(LEAST_PRIVILEGE_OPERATIONS[id]).toBeDefined();
      }
    }
  }, 120_000);
});

describe("least-privilege id-relative call sites", () => {
  it("declares every id-relative site, per file, by its tail", () => {
    const found: Record<string, string[]> = {};
    for (const site of sites()) {
      for (const path of site.paths.filter((p) => isIdRelative(p, site.methods))) {
        (found[site.file] ??= []).push(tailOf(path));
      }
    }
    const declared = Object.fromEntries(
      Object.entries(ID_RELATIVE_SITES).map(([file, entries]) => [file, entries.map((e) => e.tail)]),
    );
    expect(found).toEqual(declared);
  }, 120_000);

  it("declares for each tail only operations whose call ends in that tail", () => {
    const wrong: string[] = [];
    for (const [file, entries] of Object.entries(ID_RELATIVE_SITES)) {
      for (const entry of entries) {
        expect(entry.operations.length, `${file} ${entry.tail}`).toBeGreaterThan(0);
        for (const id of entry.operations) {
          const tail = `/${entry.tail.toLowerCase()}`;
          const ends = LEAST_PRIVILEGE_OPERATIONS[id].calls.some((call) =>
            call.path.toLowerCase().endsWith(tail),
          );
          if (!ends) {
            wrong.push(`${file} ${entry.tail}: ${id}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("operationsForCall", () => {
  it("matches a concrete path to its template, case-insensitively", () => {
    const ids = operationsForCall(
      "POST",
      "/subscriptions/s1/resourceGroups/rg1/providers/microsoft.eventhub/namespaces/ns1/authorizationRules/r1/listKeys",
    ).map((op) => op.id);
    expect(ids).toEqual(["eventhub.rule.listKeys"]);
  });

  it("does not match the same path under another method", () => {
    expect(
      operationsForCall(
        "GET",
        "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.EventHub/namespaces/ns1/authorizationRules/r1/listKeys",
      ),
    ).toEqual([]);
  });

  it("lets a {*} template segment take a whole scope", () => {
    const rg = operationsForCall(
      "GET",
      "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Authorization/permissions",
    ).map((op) => op.id);
    const sub = operationsForCall("GET", "/subscriptions/s1/providers/Microsoft.Authorization/permissions").map(
      (op) => op.id,
    );
    expect(rg).toEqual(["rbac.permissions.read"]);
    expect(sub).toEqual(["rbac.permissions.read"]);
  });

  it("lets a run-time {} in the call stand for one or more segments", () => {
    expect(operationsForCall("GET", "{}/providers/Microsoft.Authorization/permissions").map((op) => op.id)).toEqual([
      "rbac.permissions.read",
    ]);
  });

  it("never lets a trailing run-time value swallow the rest of another template", () => {
    // Found by mutation: with a trailing {} allowed to absorb several
    // segments, an unknown PUT matched the DCR role-assignment template, so
    // the coverage pin could not fail for any PUT ending in a name.
    expect(
      operationsForCall("PUT", "/subscriptions/{}/resourceGroups/{}/providers/Microsoft.Web/sites/{}"),
    ).toEqual([]);
    expect(
      operationsForCall("GET", "/subscriptions/{}/resourceGroups/{}/providers/Microsoft.Web/sites/{}"),
    ).toEqual([]);
  });

  it("never lets a leading id stand in for a resource type it hides", () => {
    // Found by review: `${storageId}/listKeys` is a storage key read, but a
    // leading {} that absorbed any template segments matched it to the Event
    // Hub listKeys row, and `${hubId}/consumergroups` matched 36 unrelated
    // GETs. A child or action on an id depends on the id's TYPE, which {}
    // hides, so it matches nothing and the site must be declared.
    expect(operationsForCall("POST", "{}/listKeys")).toEqual([]);
    expect(operationsForCall("GET", "{}/consumergroups")).toEqual([]);
    expect(operationsForCall("POST", "{}/query")).toEqual([]);
  });

  it("lets a leading id carry an extension resource, which is valid at any scope", () => {
    // Found by review: the DCR grant PUT resolved only to the lab TTL grant,
    // because the template's {*} took the leading {} as one segment before
    // the leading-{} rule could absorb Microsoft.Insights/dataCollectionRules.
    const ids = operationsForCall("PUT", "{}/providers/Microsoft.Authorization/roleAssignments/{}").map(
      (op) => op.id,
    );
    expect(ids).toContain("dcr.roleAssignment.write");
    expect(ids).toContain("lab.roleAssignment.write");
    expect(
      operationsForCall("GET", "{}/providers/Microsoft.Insights/dataCollectionRules").map((op) => op.id),
    ).toEqual(["dcr.list"]);
  });

  it("finds nothing for a call the registry does not know", () => {
    expect(
      operationsForCall("PUT", "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Web/sites/app1"),
    ).toEqual([]);
  });

  it("ignores the query string and the host", () => {
    expect(
      operationsForCall("GET", "https://management.azure.com/subscriptions?api-version=2022-12-01").map((op) => op.id),
    ).toEqual(["subscriptions.list"]);
  });
});
