/**
 * WiringSection - the Integrate arc's post-deploy SOURCE WIRING step
 * (porting-plan Unit 20 UI: "wiring with a Lake toggle"). After a pack's
 * destination is deployed, this connects a Cribl source to it: it creates the
 * Sentinel route (final:true) plus an OPTIONAL Cribl Lake route (non-final,
 * cloud only) in the correct evaluation order, commits, and deploys to the
 * worker groups. The ROUTE ORDER SEMANTICS are the load-bearing part - a
 * regression silently drops data - and they live entirely in the pure @soc/core
 * planSourceWiring / wireSource; this component only collects the source id and
 * the Lake choice and renders the applied result.
 *
 * It also carries the ENSURE-SECRET action (the connected-path half of the ONE
 * secret convention, deferred from Unit 19): create-or-update the named Cribl
 * secret sentinel_client_secret the destination references as
 * `!{sentinel_client_secret}`, so the live destination resolves without the
 * operator hand-editing Cribl. The secret value is TRANSIENT input - written
 * once to Cribl, never persisted here.
 *
 * The two actions are INDEPENDENTLY RE-RUNNABLE (the legacy per-sub-step
 * re-run). Every gating decision is the pure wiring-state module; this
 * component only renders and orchestrates IO through the ports in PortsContext.
 *
 * UNLOCK: rendered only when @soc/core canWireSource is true (a deploy
 * completed AND the mode keeps Cribl); the parent decides whether to mount it.
 * The Lake toggle is offered only for a cloud Cribl deployment.
 */

import { useCallback, useState } from "react";
import {
  SENTINEL_CLIENT_SECRET_NAME,
  SENTINEL_CLIENT_SECRET_REFERENCE,
  buildEnsureSecretRequest,
  buildUpdateSecretRequest,
  wireSource,
} from "@soc/core";
import type {
  CriblDeploymentType,
  DeployMode,
  LakeFederation,
  SourceWiringInput,
  WireSourceResult,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { deriveWiringState } from "./wiring-state";
import type { WiringDeploymentType } from "./wiring-state";

export interface WiringSectionProps {
  /** A deploy on this page has completed successfully (wiring's driver). */
  deployCompleted: boolean;
  /** The active integration mode (drives skipAzure/skipCribl gating). */
  mode: DeployMode;
  /** The Cribl deployment flavor the shell reports (cloud enables Lake). */
  deploymentType: WiringDeploymentType;
  /** The selected Cribl worker group (the routes/commit/deploy target). */
  workerGroup: string;
  /** The deployed pack name (drives the route ids, names, and pipeline). */
  packName: string;
}

type ActionState = "idle" | "running" | "ok" | "failed";

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

export function WiringSection({
  deployCompleted,
  mode,
  deploymentType,
  workerGroup,
  packName,
}: WiringSectionProps) {
  const { ports } = usePorts();

  const [sourceId, setSourceId] = useState("");
  const [lakeRequested, setLakeRequested] = useState(false);
  const [lakeDataset, setLakeDataset] = useState("");
  const [secretValue, setSecretValue] = useState("");

  const [wireState, setWireState] = useState<ActionState>("idle");
  const [wireResult, setWireResult] = useState<WireSourceResult | null>(null);
  const [wireError, setWireError] = useState("");

  const [secretState, setSecretState] = useState<ActionState>("idle");
  const [secretNote, setSecretNote] = useState("");
  const [secretError, setSecretError] = useState("");

  const decision = deriveWiringState({
    deployCompleted,
    mode,
    deploymentType,
    workerGroupSelected: workerGroup.trim() !== "",
    packNameSet: packName.trim() !== "",
    sourceId,
    lakeRequested,
    lakeDataset,
    secretValue,
  });

  const runWire = useCallback(async () => {
    if (wireState === "running" || !decision.canWire) {
      return;
    }
    setWireState("running");
    setWireResult(null);
    setWireError("");
    // The Lake route is EFFECTIVE only when cloud offers it and the operator
    // asked for it - the pure decision already collapsed that, and
    // planSourceWiring re-checks the deployment type, so an onprem run can
    // never emit a Lake route.
    const lake: LakeFederation | undefined = decision.lakeEffective
      ? {
          enabled: true,
          dataset: lakeDataset.trim(),
          deploymentType: (deploymentType ?? "onprem") as CriblDeploymentType,
        }
      : undefined;
    const input: SourceWiringInput = {
      sourceId: sourceId.trim(),
      packName: packName.trim(),
      workerGroups: [workerGroup.trim()],
      ...(lake !== undefined ? { lake } : {}),
    };
    try {
      const result = await wireSource({ cribl: ports.cribl }, input);
      setWireResult(result);
      // A partial success (routes applied but a commit/deploy warning) still
      // counts as a run that did work; surface warnings but do not fail red.
      setWireState("ok");
    } catch (err) {
      setWireError(String(err));
      setWireState("failed");
    }
  }, [
    wireState,
    decision.canWire,
    decision.lakeEffective,
    lakeDataset,
    deploymentType,
    sourceId,
    packName,
    workerGroup,
    ports.cribl,
  ]);

  const runEnsureSecret = useCallback(async () => {
    if (secretState === "running" || !decision.canEnsureSecret) {
      return;
    }
    setSecretState("running");
    setSecretNote("");
    setSecretError("");
    const group = workerGroup.trim();
    const value = secretValue.trim();
    try {
      // Create-or-update: POST creates the named secret; a 409/conflict means
      // it already exists, so PATCH updates it in place (the ensure contract).
      const created = await ports.cribl.request(
        buildEnsureSecretRequest(value, group),
      );
      if (is2xx(created.status)) {
        setSecretNote(`Created Cribl secret ${SENTINEL_CLIENT_SECRET_NAME}.`);
        setSecretState("ok");
      } else if (created.status === 409) {
        const updated = await ports.cribl.request(
          buildUpdateSecretRequest(value, group),
        );
        if (is2xx(updated.status)) {
          setSecretNote(`Updated existing Cribl secret ${SENTINEL_CLIENT_SECRET_NAME}.`);
          setSecretState("ok");
        } else {
          setSecretError(`Secret update failed: HTTP ${updated.status}`);
          setSecretState("failed");
        }
      } else {
        setSecretError(`Secret create failed: HTTP ${created.status}`);
        setSecretState("failed");
      }
    } catch (err) {
      setSecretError(String(err));
      setSecretState("failed");
    } finally {
      // Transient: never keep the secret after the run it was typed for.
      setSecretValue("");
    }
  }, [
    secretState,
    decision.canEnsureSecret,
    workerGroup,
    secretValue,
    ports.cribl,
  ]);

  return (
    <div className="discovery-result">
      <span className="field-label">Ensure Cribl secret (connected path)</span>
      <p className="panel-desc">
        The Sentinel destination references a named Cribl secret,{" "}
        {SENTINEL_CLIENT_SECRET_REFERENCE}. Store the ingestion client secret
        under that name here so the live destination resolves without hand-editing
        Cribl. Create-or-update: it creates the secret, or updates it if it
        already exists. The value is transient - written once to Cribl, never
        kept by this app. Leave the deploy&apos;s destination on the placeholder
        and provision it here, or bake it into the destination at deploy time -
        either way this is the one place the named secret is set.
      </p>
      <label className="field">
        <span className="field-label">Ingestion client secret</span>
        <input
          type="password"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
          autoComplete="new-password"
        />
        <span className="field-hint">
          Stored as the Cribl text secret {SENTINEL_CLIENT_SECRET_NAME} in worker
          group {workerGroup.trim() === "" ? "(none selected)" : workerGroup}.
        </span>
      </label>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void runEnsureSecret()}
          disabled={!decision.canEnsureSecret}
          title={decision.secretDisabledReason ?? undefined}
        >
          Ensure secret
        </button>
        <span className={`status status-${secretState}`}>{secretState}</span>
        {decision.secretDisabledReason !== null && secretState !== "running" && (
          <span className="field-hint">{decision.secretDisabledReason}</span>
        )}
      </div>
      {secretNote !== "" && <pre className="result">{secretNote}</pre>}
      {secretError !== "" && <pre className="result">{secretError}</pre>}

      <span className="field-label">Wire a Cribl source</span>
      <p className="panel-desc">
        Route a Cribl source through the deployed pack to Sentinel. The Sentinel
        route is always final; when Cribl Lake is on (cloud only) a non-final
        full-fidelity route is added ABOVE it so events reach both. The routes are
        prepended to the worker group in evaluation order, committed, and deployed.
      </p>
      <label className="field">
        <span className="field-label">Cribl source id</span>
        <input
          type="text"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          placeholder="in_http:sentinel"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field-hint">
          The input the routes filter on (__inputId==&apos;...&apos;). This is the
          Cribl source already collecting the events you want to send to Sentinel.
        </span>
      </label>
      {decision.lakeAvailable ? (
        <>
          <label className="integrate-check">
            <input
              type="checkbox"
              checked={lakeRequested}
              onChange={(e) => setLakeRequested(e.target.checked)}
            />
            <span className="integrate-check-text">
              Also send a full-fidelity copy to Cribl Lake (cloud only,
              non-final route above the Sentinel route).
            </span>
          </label>
          {lakeRequested && (
            <label className="field">
              <span className="field-label">Cribl Lake dataset id</span>
              <input
                type="text"
                value={lakeDataset}
                onChange={(e) => setLakeDataset(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="field-hint">
                An existing dataset, or a new id to create (an existing dataset
                is accepted, not an error).
              </span>
            </label>
          )}
        </>
      ) : (
        <p className="field-hint">
          Cribl Lake federation is a cloud-only capability; this deployment does
          not offer it, so only the Sentinel route is created.
        </p>
      )}
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void runWire()}
          disabled={!decision.canWire}
          title={decision.wireDisabledReason ?? undefined}
        >
          Wire source
        </button>
        <span className={`status status-${wireState}`}>{wireState}</span>
        {decision.wireDisabledReason !== null && wireState !== "running" && (
          <span className="field-hint">{decision.wireDisabledReason}</span>
        )}
      </div>
      {wireError !== "" && <pre className="result">{wireError}</pre>}
      {wireResult !== null && (
        <div className="discovery-result">
          <span className="field-label">Wiring result</span>
          <pre className="result">
            {[
              `Routes applied: ${wireResult.appliedRoutes.length}`,
              ...wireResult.appliedRoutes.map(
                (r) => `  ${r.id} (final: ${r.final ? "yes" : "no"}) -> ${r.output}`,
              ),
              `Lake dataset created: ${wireResult.datasetCreated ? "yes" : "no"}`,
              `Committed: ${wireResult.committed ?? "not committed"}`,
              `Deployed to: ${
                wireResult.deployedGroups.length > 0
                  ? wireResult.deployedGroups.join(", ")
                  : "(none)"
              }`,
              ...(wireResult.warnings.length > 0
                ? ["Warnings:", ...wireResult.warnings.map((w) => `  ${w}`)]
                : []),
            ].join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
