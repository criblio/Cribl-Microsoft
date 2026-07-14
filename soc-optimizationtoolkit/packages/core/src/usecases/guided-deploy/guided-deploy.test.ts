import { describe, expect, it } from "vitest";
import { FakeArtifactSink, FakeJobStore } from "../../testing";
import { parseUstarTar, ungzipStored } from "../../domain/pack-assembly";
import { buildSentinelDestination } from "../../domain/sentinel-destination";
import {
  guidedDeploy,
  guidedDeployKey,
  GuidedDeployBusyError,
  GUIDED_DEPLOY_JOB_KIND,
  guidedDeployStepName,
  type GuidedDeployCollaborators,
  type GuidedDeployInput,
  type GuidedDeploySource,
} from "./guided-deploy";

const SCOPE = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  location: "eastus",
};

function source(id: string, vendor = id): GuidedDeploySource {
  return { id, vendor, packName: `${id}-sentinel`, tables: [`${vendor}_CL`] };
}

function baseInput(overrides: Partial<GuidedDeployInput> = {}): GuidedDeployInput {
  return {
    sources: [source("paloalto"), source("cloudflare")],
    mode: "full",
    scope: SCOPE,
    workerGroups: ["wg-1"],
    mtimeSec: 1_700_000_000,
    ...overrides,
  };
}

const DESTINATION = buildSentinelDestination({
  id: "MS-Sentinel-X-dest",
  dcrImmutableId: "dcr-1",
  ingestionEndpoint: "https://dce.eastus-1.ingest.monitor.azure.com",
  streamName: "Custom-X",
  tenantId: "t",
  ingestionClientId: "c",
});

/** A collaborators stub with call counters. */
function makeCollaborators(
  overrides: Partial<GuidedDeployCollaborators> = {},
): GuidedDeployCollaborators & { deployCalls: string[]; publishCalls: string[] } {
  const deployCalls: string[] = [];
  const publishCalls: string[] = [];
  return {
    deployCalls,
    publishCalls,
    deploySource: async (src) => {
      deployCalls.push(src.id);
      return {
        destinations: [DESTINATION],
        armRequests: [
          {
            kind: "dcr",
            table: src.tables[0]!,
            artifactName: `dcr-${src.id}.json`,
            method: "PUT",
            path: `/x/${src.id}`,
            apiVersion: "2023-03-11",
            body: { id: src.id },
          },
        ],
        detail: "deployed",
      };
    },
    buildSourcePack: async () => ({
      crbl: new Uint8Array([0x1f, 0x8b, 1, 2]),
      version: "1.0.0",
    }),
    publishPack: async (src) => {
      publishCalls.push(src.id);
      return { uploadedGroups: ["wg-1"], detail: "uploaded" };
    },
    ...overrides,
  };
}

describe("guidedDeploy - multi-source outer loop", () => {
  it("deploys every source and finishes 'succeeded' (deploy-complete reached)", async () => {
    const jobs = new FakeJobStore();
    const collaborators = makeCollaborators();
    const record = await guidedDeploy({ jobs }, baseInput(), collaborators);

    expect(record.kind).toBe(GUIDED_DEPLOY_JOB_KIND);
    expect(record.status).toBe("succeeded");
    const result = record.result as { sources: Array<{ status: string }>; deployComplete: boolean };
    expect(result.sources.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
    expect(result.deployComplete).toBe(true);
    expect(collaborators.deployCalls).toEqual(["paloalto", "cloudflare"]);
    expect(collaborators.publishCalls).toEqual(["paloalto", "cloudflare"]);

    // There is NO validate step (Unit 10/21 seam) - the flow stops at deploy.
    expect(record.steps.some((s) => s.name.endsWith(":validate"))).toBe(false);
  });

  it("tags each source result with the producing scope (stale-data hazard)", async () => {
    const jobs = new FakeJobStore();
    const record = await guidedDeploy(
      { jobs },
      baseInput({ sources: [source("paloalto")] }),
      makeCollaborators(),
    );
    const result = record.result as {
      sources: Array<{ sourceId: string; scope?: typeof SCOPE }>;
    };
    expect(result.sources[0]!.scope).toEqual(SCOPE);
  });

  it("FAILURE ISOLATION: one source failing does not stop the others", async () => {
    const jobs = new FakeJobStore();
    const collaborators = makeCollaborators({
      deploySource: async (src) => {
        if (src.id === "paloalto") throw new Error("boom");
        return { destinations: [DESTINATION], armRequests: [], detail: "ok" };
      },
    });
    const record = await guidedDeploy({ jobs }, baseInput(), collaborators);

    expect(record.status).toBe("failed");
    const result = record.result as {
      sources: Array<{ sourceId: string; status: string; error?: string }>;
      failed: number;
      succeeded: number;
    };
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    const palo = result.sources.find((s) => s.sourceId === "paloalto");
    const cloud = result.sources.find((s) => s.sourceId === "cloudflare");
    expect(palo?.status).toBe("failed");
    expect(palo?.error).toContain("boom");
    // The SECOND source still ran (isolation).
    expect(cloud?.status).toBe("succeeded");
    expect(collaborators.publishCalls).toEqual(["cloudflare"]);
  });

  it("SINGLE-FLIGHT: rejects when a same-key deploy is already running", async () => {
    const jobs = new FakeJobStore();
    const input = baseInput();
    // Seed a running job with the SAME deploy key.
    const running = await jobs.create(GUIDED_DEPLOY_JOB_KIND, {
      deployKey: guidedDeployKey(input),
    });
    await jobs.update(running.id, { status: "running" });

    await expect(
      guidedDeploy({ jobs }, input, makeCollaborators()),
    ).rejects.toBeInstanceOf(GuidedDeployBusyError);
  });

  it("RESUMABILITY (survives reload): a re-run SKIPS sources a prior run completed", async () => {
    const jobs = new FakeJobStore();
    const input = baseInput();

    // Run 1: cloudflare fails, paloalto succeeds.
    const run1 = makeCollaborators({
      deploySource: async (src) => {
        if (src.id === "cloudflare") throw new Error("transient");
        return { destinations: [DESTINATION], armRequests: [], detail: "ok" };
      },
    });
    const first = await guidedDeploy({ jobs }, input, run1);
    expect(first.status).toBe("failed");

    // Run 2: same key, everything succeeds. paloalto must be SKIPPED (0 calls).
    const run2 = makeCollaborators();
    const second = await guidedDeploy({ jobs }, input, run2);

    expect(second.status).toBe("succeeded");
    const result = second.result as {
      sources: Array<{ sourceId: string; status: string; reason?: string }>;
    };
    const palo = result.sources.find((s) => s.sourceId === "paloalto");
    expect(palo?.status).toBe("skipped");
    expect(palo?.reason).toBe("already-completed");
    // paloalto was NOT re-deployed; only cloudflare ran in run 2.
    expect(run2.deployCalls).toEqual(["cloudflare"]);
  });

  it("idempotent azure skip: when all destinations exist, the azure step is 'skipped'", async () => {
    const jobs = new FakeJobStore();
    const collaborators = makeCollaborators({
      listExistingDestinations: async () => ["paloalto_CL", "cloudflare_CL"],
    });
    const record = await guidedDeploy(
      { jobs },
      baseInput({ sources: [source("paloalto")] }),
      collaborators,
    );
    const azureStep = record.steps.find(
      (s) => s.name === guidedDeployStepName("paloalto", "azure"),
    );
    expect(azureStep?.status).toBe("skipped");
    expect(azureStep?.detail).toBe("DCRs already deployed");
  });

  it("vendor research is MEMOIZED: same vendor across sources calls it once", async () => {
    const jobs = new FakeJobStore();
    let researchCalls = 0;
    const collaborators = makeCollaborators({
      research: async () => {
        researchCalls += 1;
        return {};
      },
    });
    await guidedDeploy(
      { jobs },
      baseInput({
        sources: [
          { id: "a", vendor: "acme", packName: "a", tables: ["a_CL"] },
          { id: "b", vendor: "acme", packName: "b", tables: ["b_CL"] },
        ],
      }),
      collaborators,
    );
    expect(researchCalls).toBe(1);
  });
});

describe("guidedDeploy - air-gap mode", () => {
  it("delivers ONE archive per source via ArtifactSink and skips Cribl publish", async () => {
    const jobs = new FakeJobStore();
    const artifacts = new FakeArtifactSink();
    const collaborators = makeCollaborators();
    const record = await guidedDeploy(
      { jobs, artifacts },
      baseInput({ sources: [source("paloalto")], mode: "air-gapped" }),
      collaborators,
    );

    expect(record.status).toBe("succeeded");
    // Cribl publish is skipped in air-gapped mode.
    expect(collaborators.publishCalls).toEqual([]);
    // Exactly one archive saved, and it round-trips through the Unit 19 parser.
    expect(artifacts.saves).toHaveLength(1);
    const saved = artifacts.saves[0]!;
    expect(saved.name).toBe("paloalto-sentinel-artifacts.tgz");
    const entries = parseUstarTar(ungzipStored(saved.data as Uint8Array));
    const names = entries.filter((e) => !e.isDir).map((e) => e.path);
    expect(names).toContain("README-deployment.md");
    expect(names).toContain("paloalto-sentinel.crbl");
  });

  it("throws when a partial/air-gapped mode has no ArtifactSink to deliver the archive", async () => {
    const jobs = new FakeJobStore();
    await expect(
      guidedDeploy({ jobs }, baseInput({ mode: "air-gapped" }), makeCollaborators()),
    ).rejects.toThrow(/ArtifactSink/);
  });
});
