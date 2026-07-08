/**
 * RoleAssignmentSection - the Integrate page's ingestion-role step (porting-plan
 * Unit 8, ENG-37 RUNTIME half). Grants "Monitoring Metrics Publisher" to the
 * ingestion service principal on each DCR a deploy created, so Cribl can push
 * telemetry through the DCR's logs-ingestion endpoint (data cannot flow to a
 * DCR without it). ADDITIVE and NON-GATING: it lives inside the Azure Resources
 * section and never participates in canDeploy / canDeployContentPath.
 *
 * The RUN is the @soc/core assignDcrRoles usecase (idempotency, PrincipalNotFound
 * retry, {results, assigned, total} aggregation); this component only collects
 * the ENTERPRISE APPLICATION OBJECT ID, seeds the honest step list, and renders
 * the aggregated result plus the per-DCR outcome. Every non-trivial decision is
 * the pure role-assignment-state module.
 *
 * SHELL OWNS ID MINTING: the per-assignment name is a GUID minted by the
 * shell-injected ports.mintAssignmentName (@soc/core never mints an id). When a
 * shell does not provide one, the Run stays visible-but-disabled with the reason.
 *
 * EMPTY STATE: with no deployed DCRs and/or no object id, the Run button is
 * always visible and disabled with the reason (keep-list: affordances are never
 * hidden).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acquireServicePrincipals,
  assignDcrRoles,
  defaultServicePrincipalId,
} from "@soc/core";
import type {
  AssignDcrRoleOutcome,
  DcrRoleTarget,
  JobStep,
  ServicePrincipalRef,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { SearchableSelect } from "../../components/searchable-select";
import { formatStepLine } from "../../onboarding/step-line";
import {
  projectRoleOutcome,
  roleAssignDisabledReason,
  roleAssignStepNames,
  roleTargetDisplayName,
  validateObjectId,
} from "./role-assignment-state";

/** Kind -> the short label the per-DCR outcome row shows. */
const KIND_LABEL: Record<"assigned" | "already" | "failed", string> = {
  assigned: "assigned",
  already: "already assigned",
  failed: "failed",
};

/** Default retry pacing when the shell injects none (real timer; UI layer). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RoleAssignmentSectionProps {
  /**
   * The DCRs to grant the role on - the DCRs a successful deploy on this page
   * created (name + ARM scope already resolved, so no location guesswork). An
   * empty list renders the always-visible-disabled empty state.
   */
  targets: readonly DcrRoleTarget[];
  /**
   * The active connection's app-registration CLIENT id, used ONLY to reject an
   * object-id value equal to it (the classic ENG-37 mistake). Optional.
   */
  clientId?: string;
  /**
   * Shell-provided pointer to where the operator can grant the role out of band
   * instead (az CLI / portal / change request). Rendered as a fallback note.
   */
  roleGuidance?: string;
  /**
   * OPTIONAL shell-injected retry pacing for the usecase's PrincipalNotFound
   * backoff. Absent, a real setTimeout-based delay is used.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Terminal display state of the last assignment run. */
type RunState = "idle" | "running" | "ok" | "failed";

export function RoleAssignmentSection({
  targets,
  clientId,
  roleGuidance,
  sleep,
}: RoleAssignmentSectionProps) {
  const { ports } = usePorts();

  const [objectId, setObjectId] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [outcome, setOutcome] = useState<AssignDcrRoleOutcome | null>(null);
  const [runError, setRunError] = useState("");

  // Service-principal picker (B3): when the shell binds a GraphDirectory, the
  // object id is chosen from a name-sorted dropdown (own app first, cribl-named
  // next) instead of typed. Everything degrades to the plain text field when the
  // port is absent or the directory read is denied - never worse than before.
  const [servicePrincipals, setServicePrincipals] = useState<
    ServicePrincipalRef[] | null
  >(null);
  const [spLoading, setSpLoading] = useState(false);
  const [spError, setSpError] = useState("");
  const [manualEntry, setManualEntry] = useState(false);

  const loadServicePrincipals = useCallback(async () => {
    const graph = ports.graph;
    if (graph === undefined) return;
    setSpLoading(true);
    setSpError("");
    try {
      const list = await acquireServicePrincipals(graph, clientId);
      setServicePrincipals(list);
      // Preselect the app's own SP when the field is still empty; never
      // overwrite an id the operator already entered.
      setObjectId((cur) =>
        cur.trim() === "" ? defaultServicePrincipalId(list, clientId) : cur,
      );
    } catch (err) {
      setSpError(err instanceof Error ? err.message : String(err));
      setServicePrincipals([]);
    } finally {
      setSpLoading(false);
    }
  }, [ports.graph, clientId]);

  useEffect(() => {
    if (ports.graph !== undefined) void loadServicePrincipals();
  }, [ports.graph, loadServicePrincipals]);

  // The dropdown drives the field only when the port is bound, the directory
  // read succeeded, and the operator has not switched to manual entry.
  const useDropdown =
    ports.graph !== undefined && spError === "" && !manualEntry;

  const objectIdCheck = validateObjectId(objectId, clientId);
  const canMint = ports.mintAssignmentName !== undefined;
  const disabledReason = roleAssignDisabledReason({
    objectIdValid: objectIdCheck.valid,
    objectIdReason: objectIdCheck.reason,
    targetCount: targets.length,
    canMint,
    running,
  });
  const canRun = disabledReason === null;

  const view = useMemo(
    () => (outcome !== null ? projectRoleOutcome(outcome) : null),
    [outcome],
  );

  const runState: RunState = running
    ? "running"
    : view !== null
      ? view.allSucceeded
        ? "ok"
        : "failed"
      : runError !== ""
        ? "failed"
        : "idle";

  const run = useCallback(async () => {
    const minter = ports.mintAssignmentName;
    if (running || minter === undefined || targets.length === 0) {
      return;
    }
    const check = validateObjectId(objectId, clientId);
    if (!check.valid) {
      return;
    }
    setRunning(true);
    setOutcome(null);
    setRunError("");
    // Seed every step as pending so the list renders complete from the first
    // onProgress tick (shared honest-step-list idiom; names match the usecase).
    setSteps(
      roleAssignStepNames(targets).map((name) => ({ name, status: "pending" })),
    );
    try {
      const result = await assignDcrRoles(
        { azure: ports.azure, jobs: ports.jobs, ...(ports.logger !== undefined ? { logger: ports.logger } : {}) },
        {
          principalId: objectId.trim(),
          targets: [...targets],
          mintAssignmentName: minter,
          retry: { sleep: sleep ?? defaultSleep },
          onProgress: (step) => {
            setSteps((prev) =>
              prev.map((s) => (s.name === step.name ? { ...step } : s)),
            );
          },
        },
      );
      // assignDcrRoles never rejects for assignment failures - the outcome
      // carries them; a rejection here means the JobStore or an injected hook
      // failed.
      setOutcome(result);
    } catch (err) {
      setRunError(String(err));
    } finally {
      setRunning(false);
    }
  }, [ports, running, targets, objectId, clientId, sleep]);

  return (
    <div className="discovery-result">
      <span className="field-label">
        Assign Monitoring Metrics Publisher (ingestion role)
      </span>
      <p className="panel-desc">
        The Cribl ingestion identity needs Monitoring Metrics Publisher on each
        deployed DCR before any event can flow to it. This grants it directly
        over ARM - idempotent (a DCR that already has the role is reported as
        such), and resilient to Entra ID replication lag. It is additive: it
        never gates the deploy above.
      </p>
      <label className="field">
        <span className="field-label">
          Enterprise Application object id (ingestion service principal)
        </span>
        {useDropdown ? (
          <>
            <SearchableSelect
              options={(servicePrincipals ?? []).map((sp) => ({
                value: sp.id,
                label: sp.displayName,
                hint: sp.id,
              }))}
              value={objectId}
              onChange={setObjectId}
              disabled={spLoading}
              placeholder={
                spLoading
                  ? "Loading service principals..."
                  : "Select a service principal..."
              }
              ariaLabel="Filter service principals"
            />
            <div className="role-sp-controls">
              <button
                type="button"
                className="gap-reset-button"
                onClick={() => void loadServicePrincipals()}
                disabled={spLoading}
              >
                Reload
              </button>
              <button
                type="button"
                className="gap-reset-button"
                onClick={() => setManualEntry(true)}
              >
                Enter manually
              </button>
            </div>
            <span className="field-hint">
              The ingestion service principal&apos;s OBJECT id, picked from your
              directory - the app registration this app uses is preselected, and
              cribl-named principals are listed first. This is NOT the app
              registration&apos;s client (application) id - confusing the two is
              the classic failure.
            </span>
          </>
        ) : (
          <>
            <input
              type="text"
              value={objectId}
              onChange={(e) => setObjectId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              spellCheck={false}
              className="mono"
            />
            {ports.graph !== undefined && (
              <div className="role-sp-controls">
                <button
                  type="button"
                  className="gap-reset-button"
                  onClick={() => {
                    setManualEntry(false);
                    if (spError !== "") void loadServicePrincipals();
                  }}
                >
                  Pick from directory
                </button>
              </div>
            )}
            {spError !== "" && (
              <span className="field-hint">
                Could not read the directory ({spError}). Enter the object id
                manually, or retry with Pick from directory. This needs the app
                to have Application.Read.All (or Directory.Read.All) consented.
              </span>
            )}
            <span className="field-hint">
              This is the ingestion service principal&apos;s OBJECT id - its
              Enterprise Application object id in Entra ID - NOT the app
              registration&apos;s client (application) id. They are different
              GUIDs, and confusing the two is the classic failure. In Entra ID,
              open the app registration, follow the Managed application link to
              the Enterprise Application, and copy its Object ID.
            </span>
          </>
        )}
      </label>

      {targets.length > 0 ? (
        <>
          <span className="field-label">
            DCRs to grant on ({targets.length})
          </span>
          <pre className="result">
            {targets.map((t) => roleTargetDisplayName(t)).join("\n")}
          </pre>
        </>
      ) : (
        <p className="field-hint">
          No deployed DCRs yet. Run the deploy below; each DCR a successful run
          creates appears here to grant the role on.
        </p>
      )}

      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void run()}
          disabled={!canRun}
          title={disabledReason ?? undefined}
        >
          Assign role
        </button>
        <span className={`status status-${runState}`}>{runState}</span>
        {disabledReason !== null && !running && (
          <span className="field-hint">{disabledReason}</span>
        )}
      </div>

      {steps.length > 0 && (
        <pre className="result">{steps.map(formatStepLine).join("\n")}</pre>
      )}
      {runError !== "" && <pre className="result">{runError}</pre>}
      {view !== null && (
        <div className="discovery-result">
          <span className="field-label">Role assignment result</span>
          <pre className="result">
            {[
              view.summary,
              ...view.rows.map(
                (r) => `${r.dcr}: ${KIND_LABEL[r.kind]} - ${r.detail}`,
              ),
            ].join("\n")}
          </pre>
        </div>
      )}

      <p className="panel-desc">
        Prefer to grant it out of band?{" "}
        {roleGuidance ??
          "Assign Monitoring Metrics Publisher on each DCR via the az CLI, the portal, or a change request."}
      </p>
    </div>
  );
}
