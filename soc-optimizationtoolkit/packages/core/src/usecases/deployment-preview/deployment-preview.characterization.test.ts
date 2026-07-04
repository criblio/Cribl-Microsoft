/**
 * Characterization: preview name === deployed name.
 *
 * The legacy preview predicted DCR names with a simplified approximation
 * (lowercase + slice(0, 20)) that DIVERGED from what deployment created -
 * the Unit 7 DO-NOT-PORT defect. This suite pins the fix across every
 * ABBREVIATION-TRIGGERING vector of dcr-naming's legacy-vectors.json (the
 * golden names recorded from the legacy PowerShell engine - i.e. the names
 * that are actually deployed in customer environments): checkExistingDcrs
 * must predict EXACTLY the deployed name and therefore match it.
 *
 * Abbreviation-triggering means the naive composed name exceeds the mode's
 * limit (30 direct / 64 dce) - precisely the vectors where the legacy
 * approximation went wrong.
 */
import { describe, expect, it } from "vitest";
import { checkExistingDcrs } from "./deployment-preview";
import legacyVectors from "../../domain/dcr-naming/legacy-vectors.json";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";
import { onboardTable } from "../onboard-table";

interface LegacyVector {
  table: string;
  mode: string;
  prefix: string;
  suffix: string;
  location: string;
  custom: boolean;
  expected: string;
}

const vectors: LegacyVector[] = legacyVectors;

/**
 * Recompute the naive STEP-1 composition length independently of the module
 * under test (prefix + stripped table + "-" + location [+ "-" + suffix]) so
 * the abbreviation-triggering subset is selected without trusting dcr-naming.
 */
function composedLength(vector: LegacyVector): number {
  const table = vector.custom
    ? vector.table.replace(/_CL$/i, "")
    : vector.table;
  const suffix = vector.suffix.trim().length > 0 ? vector.suffix : undefined;
  let name = `${vector.prefix}${table}-${vector.location}`;
  if (suffix !== undefined) {
    name = `${name}-${suffix}`;
  }
  return name.length;
}

const abbreviationTriggering = vectors.filter(
  (vector) =>
    (vector.mode === "direct" || vector.mode === "dce") &&
    composedLength(vector) > (vector.mode === "direct" ? 30 : 64),
);

/** Group vectors sharing one checkExistingDcrs option set. */
const groups = new Map<string, LegacyVector[]>();
for (const vector of abbreviationTriggering) {
  const key = `${vector.mode}|${vector.prefix}|${vector.suffix}|${vector.location}`;
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, [vector]);
  } else {
    group.push(vector);
  }
}

const DCR_LIST_PATH_PREFIX =
  "/subscriptions/sub-1/resourceGroups/rg-1" +
  "/providers/Microsoft.Insights/dataCollectionRules";

describe("preview name === deployed name (abbreviation-triggering legacy vectors)", () => {
  it("covers the full abbreviation-triggering subset of the 276 vectors", () => {
    expect(abbreviationTriggering).toHaveLength(100);
  });

  for (const [key, group] of groups) {
    const first = group[0];
    const mode = first.mode === "direct" ? ("direct" as const) : ("dce" as const);

    it(`matches every deployed name exactly for option set [${key}] (${group.length} vectors)`, async () => {
      const azure = new FakeAzureManagement();

      // The ARM list carries the DEPLOYED names - the golden legacy outputs.
      // Duplicates (first-6 abbreviation collisions) are listed once, as ARM
      // would.
      const deployedNames = [...new Set(group.map((vector) => vector.expected))];
      azure.respondWith({
        status: 200,
        body: {
          value: deployedNames.map((name) => ({
            name,
            id: `${DCR_LIST_PATH_PREFIX}/${name}`,
          })),
        },
      });
      // One per-match detail GET per requested table (every prediction must
      // hit).
      for (const vector of group) {
        azure.respondWith({
          status: 200,
          body: { properties: { immutableId: `imm-${vector.table}` } },
        });
      }

      const results = await checkExistingDcrs(
        azure,
        { subscriptionId: "sub-1", resourceGroup: "rg-1" },
        group.map((vector) => vector.table),
        {
          mode,
          location: first.location,
          dcrNamePrefix: first.prefix,
          dcrNameSuffix: first.suffix,
        },
      );

      for (const [index, vector] of group.entries()) {
        const result = results[index];
        expect(result.table).toBe(vector.table);
        // THE pin: the preview's predicted name IS the deployed name.
        expect(result.dcrName).toBe(vector.expected);
        expect(result.exists).toBe(true);
      }
      // Exactly one list + one GET per match - and every table matched.
      expect(azure.calls).toHaveLength(1 + group.length);
    });
  }

  it("agrees with what onboardTable ACTUALLY deploys (end-to-end name parity)", async () => {
    // Deploy CommonSecurityLog with a suffix that pushes the composed name
    // over the 30-char direct limit ("dcr-CommonSecurityLog-eastus-prod" is
    // 33 chars), forcing the dictionary abbreviation the legacy preview got
    // wrong.
    const azure = new FakeAzureManagement();
    const cribl = new FakeCriblClient();
    const jobs = new FakeJobStore();

    const succeededDcr = {
      status: 200,
      body: {
        properties: {
          provisioningState: "Succeeded",
          immutableId: "dcr-imm-csl",
          endpoints: {
            logsIngestion: "https://csl.eastus-1.ingest.monitor.azure.com",
          },
        },
      },
    };
    azure.respondWith(
      {
        status: 200,
        body: {
          id:
            "/subscriptions/sub-1/resourceGroups/rg-1" +
            "/providers/Microsoft.OperationalInsights/workspaces/ws-1",
          location: "eastus",
        },
      },
      {
        status: 200,
        body: {
          properties: {
            schema: {
              standardColumns: [
                { name: "TimeGenerated", type: "dateTime" },
                { name: "Activity", type: "string" },
              ],
            },
          },
        },
      },
      succeededDcr, // deploy PUT response
      succeededDcr, // verify GET
    );
    cribl.respondWith(
      { status: 200, body: {} }, // POST /system/outputs
      { status: 200, body: { items: [{ commit: "abc123" }] } }, // commit
      { status: 200, body: {} }, // deploy
      { status: 200, body: {} }, // verify output
    );

    const record = await onboardTable(
      { azure, cribl, jobs },
      {
        table: "CommonSecurityLog",
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        workspaceName: "ws-1",
        groupId: "default",
        tenantId: "tenant-1",
        ingestionClientId: "client-1",
        dcrNameSuffix: "prod",
      },
    );
    expect(record.status).toBe("succeeded");

    const putCall = azure.calls.find((call) => call.method === "PUT");
    if (putCall === undefined) {
      throw new Error("onboardTable issued no DCR PUT");
    }
    const segments = putCall.path.split("/");
    const deployedName = segments[segments.length - 1];
    expect(deployedName).toBe("dcr-CSL-eastus-prod");

    // The preview check, against exactly what was deployed.
    const previewAzure = new FakeAzureManagement();
    previewAzure.respondWith(
      {
        status: 200,
        body: { value: [{ name: deployedName, id: putCall.path }] },
      },
      succeededDcr,
    );
    const results = await checkExistingDcrs(
      previewAzure,
      { subscriptionId: "sub-1", resourceGroup: "rg-1" },
      ["CommonSecurityLog"],
      { mode: "direct", location: "eastus", dcrNameSuffix: "prod" },
    );
    expect(results[0].dcrName).toBe(deployedName);
    expect(results[0].exists).toBe(true);
    expect(results[0].immutableId).toBe("dcr-imm-csl");
  });
});
