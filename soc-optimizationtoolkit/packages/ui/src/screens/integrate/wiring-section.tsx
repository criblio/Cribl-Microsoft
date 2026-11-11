/**
 * WiringSection - the Integrate arc's post-deploy SOURCE WIRING step
 * (porting-plan Unit 20 UI: "wiring with a Lake toggle"). After a pack's
 * destination is deployed, this connects a Cribl source to it: it adds the
 * Sentinel route (final:true) plus an OPTIONAL Cribl Lake route (non-final,
 * cloud only) at the TOP of the worker group's routing table, in the correct
 * evaluation order, then commits and deploys that group. The ROUTE ORDER
 * SEMANTICS are the load-bearing part - a regression silently drops data - and
 * they live entirely in @soc/core (planSourceWiring, planWireSource /
 * applyWireSource over the shared route-insert writer).
 *
 * TWO CLICKS (DBT-301), the onboarding Cribl source panel's pattern: the first
 * "Wire source" click PLANS read-only (the group's sources, its routing table,
 * its pending changes) and, when ready, shows the confirm naming the group, the
 * routes to add, where they go, the commit file and the worker restart. Only a
 * second click while armed applies. Any change to the group, source, pack or
 * Lake choice disarms (wiring-state.ts wireConfirmReducer). A refusal, a void
 * (the table moved since the confirm: plan again, never retried) and every
 * apply outcome are rendered in words.
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

import { useCallback, useEffect, useReducer, useState } from "react";
import {
  SENTINEL_CLIENT_SECRET_DESCRIPTION,
  SENTINEL_CLIENT_SECRET_NAME,
  SENTINEL_CLIENT_SECRET_REFERENCE,
  applyWireSource,
  ensureTextSecret,
  planWireSource,
} from "@soc/core";
import type { CriblDeploymentType, DeployMode, LakeFederation, PlanWireSourceInput } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { usePorts } from "../../ports-context";
import {
  WIRE_CONFIRM_IDLE,
  deriveWiringState,
  isWireArmed,
  wireArmKey,
  wireClick,
  wireConfirmLines,
  wireConfirmReducer,
  wireOutcomeView,
  wirePlanRefusalView,
} from "./wiring-state";
import type { WireView, WiringDeploymentType } from "./wiring-state";

/** The (i) beside the wiring heading: what each click does. */
const WIRE_TIP =
  "The first click only reads: the worker group's sources (for the source's type), its routing table and its " +
  "pending changes. It shows what would change. The second click writes the routes, reads them back, commits " +
  "the routes file and deploys the group. Changing any field in between cancels the confirmation.";

/** The (i) beside the source field: where the type comes from. */
const SOURCE_TIP =
  "Cribl tags every event with __inputId set to <type>:<id>, so the route filter needs the source's type. " +
  "Enter the source's id; its type is read from the worker group's sources. Entering <type>:<id> also works, " +
  "and is refused if the type does not match.";

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

export function WiringSection({
  deployCompleted,
  mode,
  deploymentType,
  workerGroup,
  packName,
}: WiringSectionProps) {
  const { ports, config } = usePorts();

  const [sourceId, setSourceId] = useState("");
  const [lakeRequested, setLakeRequested] = useState(false);
  const [lakeDataset, setLakeDataset] = useState("");
  const [secretValue, setSecretValue] = useState("");

  const [confirm, dispatch] = useReducer(wireConfirmReducer, WIRE_CONFIRM_IDLE);
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

  const lakeEffective = decision.lakeEffective;
  const key = wireArmKey({ workerGroup, sourceId, packName, lakeEffective, lakeDataset });
  useEffect(() => {
    dispatch({ type: "inputs", key });
  }, [key]);
  const armed = isWireArmed(confirm, key);
  const busy = confirm.phase === "planning" || confirm.phase === "applying";

  async function onWire(): Promise<void> {
    const action = wireClick(confirm, key);
    if (action === "none") return;
    setWireError("");
    if (action === "apply" && confirm.phase === "armed") {
      const ready = confirm.ready;
      dispatch({ type: "apply-start", key });
      try {
        dispatch({ type: "apply-result", result: await applyWireSource({ cribl: ports.cribl }, ready) });
      } catch (error) {
        setWireError(
          `The wiring stopped before it reported an outcome: ${errorText(error)}. Check the worker group's routing table and pending changes in Cribl before trying again.`,
        );
        dispatch({ type: "reset" });
      }
      return;
    }
    if (!decision.canWire) return;
    // The Lake route is EFFECTIVE only when cloud offers it and the operator
    // asked for it - the pure decision already collapsed that, and
    // planSourceWiring re-checks the deployment type, so an onprem run can
    // never emit a Lake route.
    const lake: LakeFederation | undefined = lakeEffective
      ? { enabled: true, dataset: lakeDataset.trim(), deploymentType: (deploymentType ?? "onprem") as CriblDeploymentType }
      : undefined;
    const input: PlanWireSourceInput = {
      groupId: workerGroup.trim(),
      source: sourceId.trim(),
      packName: packName.trim(),
      ...(lake !== undefined ? { lake } : {}),
    };
    dispatch({ type: "plan-start", key });
    try {
      dispatch({ type: "plan-result", key, result: await planWireSource({ cribl: ports.cribl }, input) });
    } catch (error) {
      setWireError(`The check before wiring did not finish: ${errorText(error)}. Nothing was changed.`);
      dispatch({ type: "reset" });
    }
  }

  const wireView: WireView | null =
    confirm.phase === "done"
      ? wireOutcomeView(confirm.result)
      : confirm.phase === "planned"
        ? wirePlanRefusalView(confirm.result)
        : null;

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
      // Create-or-update, ours only (ensureTextSecret, DBT-152): POST creates
      // the named secret; on a 409 it is PATCHed only when its description
      // carries this app's ownership stamp. A secret another admin or app made
      // under this name, or one whose owner cannot be read, is left unchanged
      // and the refusal says so; a 400 is an error, never an overwrite.
      const ensured = await ensureTextSecret(ports.cribl, {
        groupId: group,
        id: SENTINEL_CLIENT_SECRET_NAME,
        value,
        description: SENTINEL_CLIENT_SECRET_DESCRIPTION,
        // ONE secret name for every tenant (ADR 0009, audit HIGH
        // secret-provisioning.ts:36): naming the tenant means a second tenant
        // wiring into this group is refused instead of replacing the first
        // tenant's value under its destinations.
        tenantId: config.tenantId,
      });
      if (ensured.kind === "created") {
        setSecretNote(`Created Cribl secret ${SENTINEL_CLIENT_SECRET_NAME}.`);
        setSecretState("ok");
      } else if (ensured.kind === "updated") {
        setSecretNote(`Updated existing Cribl secret ${SENTINEL_CLIENT_SECRET_NAME}.`);
        setSecretState("ok");
      } else {
        setSecretError(ensured.message);
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
    config.tenantId,
  ]);

  return (
    <div className="discovery-result">
      <span className="field-label">Ensure Cribl secret (connected path)</span>
      <p className="panel-desc">
        The Sentinel destination references a named Cribl secret,{" "}
        <code className="code-chip">{SENTINEL_CLIENT_SECRET_REFERENCE}</code>.
        Store the ingestion client secret
        under that name here so the live destination resolves without hand-editing
        Cribl. Create-or-update: it creates the secret, or updates it if it
        already exists and this app created it; a secret of that name made by
        anyone else is left unchanged. The value is transient - written once to Cribl, never
        kept by this app. Leave the deploy&apos;s destination on the placeholder
        and provision it here. A secret given at deploy time goes into a
        per-destination Cribl secret instead, never into the destination -
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
          Stored as the Cribl text secret{" "}
          <code className="code-chip">{SENTINEL_CLIENT_SECRET_NAME}</code> in worker
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

      <span className="field-label">
        Wire a Cribl source <InfoTip text={WIRE_TIP} />
      </span>
      <p className="panel-desc">
        Route a Cribl source through the deployed pack to Sentinel. The Sentinel
        route is always final; when Cribl Lake is on (cloud only) a non-final
        full-fidelity route goes directly ABOVE it so events reach both. Both are
        added at the top of the worker group&apos;s routing table; no other route
        is changed. You confirm before anything is written.
      </p>
      <label className="field">
        <span className="field-label">
          Cribl source id <InfoTip text={SOURCE_TIP} />
        </span>
        <input
          type="text"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          placeholder="in_syslog or syslog:in_syslog"
          autoComplete="off"
          spellCheck={false}
          className="mono"
        />
        <span className="field-hint">
          The Cribl source already collecting the events you want to send to
          Sentinel. Its type is read from worker group{" "}
          {workerGroup.trim() === "" ? "(none selected)" : workerGroup}.
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
      {armed && (
        <div className="azo-confirm" role="alert">
          {wireConfirmLines(confirm.ready).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      <div className="panel-controls">
        <button
          type="button"
          className="run-button"
          onClick={() => void onWire()}
          disabled={busy || (!armed && !decision.canWire)}
        >
          {confirm.phase === "planning"
            ? "Checking..."
            : confirm.phase === "applying"
              ? "Wiring..."
              : armed
                ? "Confirm: write the routes"
                : "Wire source"}
        </button>
        {armed && (
          <button type="button" className="run-button" onClick={() => dispatch({ type: "reset" })}>
            Cancel
          </button>
        )}
        {!armed && !busy && decision.wireDisabledReason !== null && (
          <span className="field-hint">{decision.wireDisabledReason}</span>
        )}
      </div>
      {wireError !== "" && (
        <p className="field-hint" role="alert">
          {wireError}
        </p>
      )}
      {wireView !== null && (
        <div className="discovery-result" role="status" data-tone={wireView.tone}>
          <p>
            <strong>{wireView.headline}</strong>
          </p>
          {wireView.detail !== "" && <p>{wireView.detail}</p>}
          {wireView.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}
