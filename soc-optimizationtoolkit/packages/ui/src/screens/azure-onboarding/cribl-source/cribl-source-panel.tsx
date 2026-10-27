/**
 * CriblSourcePanel - the "Cribl Stream source" panel (AZR-34, ADR 0007 D7-D10).
 *
 * The Cribl input that receives each chosen lane (type `eventhub` or
 * `azure_blob`) is ALWAYS created by the app, behind a two-click confirm. The
 * screen owns the IO (core's read-only planCriblSource, then the create-only
 * applyCriblSource); this panel owns, per lane, the credential choice, the
 * Listen rule pick, the paste field and the confirm machine from
 * cribl-source-state.ts.
 *
 * ZERO CALLS ON MOUNT. The worker-group listing is the screen's
 * `useStreamWorkerGroups(cribl, {auto: false})` (as at architecture-screen.tsx),
 * handed in as `workerGroups` plus `onLoadGroups`: rendering this panel calls
 * nothing; only "Load worker groups" lists them.
 *
 * TWO CLICKS. The first Create click PLANS (read-only GETs) and, when the plan
 * is ready, shows the confirm naming the group, input id and type, secret id,
 * the key name actually used, the commit files and the worker restart. Only a
 * second click while armed for the SAME arm key applies. Any change to what the
 * confirm names - group, rule, credential kind, attestation, plan value, a
 * newer read, a pasted string with a different descriptor - is a new key and
 * disarms for good (cribl-source-state.ts confirmReducer). A blob lane's
 * client secret has no descriptor, so any edit to it disarms directly.
 *
 * SECRETS. A pasted connection string (or a blob lane's client secret) lives
 * only in a ref and in the uncontrolled password input. React state and the
 * parent see the parsed, NON-SECRET descriptor {host, keyName, entityPath}.
 * The value leaves the ref only through the `value()` closure the apply is
 * handed, and the ref and the field are cleared after the apply and on unmount.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  checkPastedCredential,
  isInvalidConnection,
  parseEventHubConnectionString,
} from "@soc/core";
import type {
  ApplyCredential,
  ApplyCriblSourceOutcome,
  ConnectionDescriptor,
  LaneTopics,
  ListRead,
  NamespaceAuthRule,
  OnboardingCriblSide,
  OnboardingSourceId,
  ParsedConnection,
  PlanCredential,
  PlanCriblSourceResult,
  PlanValues,
  ReadyCriblSource,
  RouteConsumption,
  InputPresence,
  SourceMode,
} from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { WorkerGroupField } from "../../../components/worker-group-field";
import type { WorkerGroupsState } from "../../../components/worker-group-listing";
import {
  ATTESTATION_LABEL,
  CONFIRM_IDLE,
  armKey,
  confirmReducer,
  confirmText,
  createClick,
  createDisabledReason,
  credentialChoices,
  isArmed,
  listenRuleMessage,
  listenRules,
  needsAttestation,
  outcomeView,
  pasteDescriptorView,
  planResultView,
} from "./cribl-source-state";
import type {
  ConfirmAction,
  ConfirmState,
  CredentialKind,
  CriblSourceRow,
  OutcomeView,
} from "./cribl-source-state";

export interface CriblSourcePanelProps {
  /** One row per chosen source (cribl-source-state sourceRows). */
  readonly rows: readonly CriblSourceRow[];
  /** Each source's mode, for the default credential (D7). Absent reads as How-to. */
  readonly modes: Partial<Record<OnboardingSourceId, SourceMode>>;
  readonly values: PlanValues;
  /** Bumped by the screen on every Azure or Cribl read a plan depends on. */
  readonly readSeq: number;
  /** The screen's worker-group listing, created with auto:false. */
  readonly workerGroups: WorkerGroupsState;
  /** Lists the worker groups; called only by the button and Retry. */
  readonly onLoadGroups: () => void;
  readonly groupId: string;
  readonly onGroupChange: (groupId: string) => void;
  /** The plan namespace's authorization rules, or null when not read yet. */
  readonly rules: ListRead<NamespaceAuthRule> | null;
  /** Reads the namespace's rules; the button is hidden without it. */
  readonly onReadRules?: () => void;
  /** The hubs a lane's input reads (core laneTopics), or null when not computed. */
  readonly topicsFor: (sourceId: OnboardingSourceId) => LaneTopics | null;
  /** The service principal a blob lane authenticates as, or null when not set up. */
  readonly principal: { readonly tenantId: string; readonly clientId: string } | null;
  /** Core planCriblSource for one lane. Read-only. */
  readonly onPlan: (sourceId: OnboardingSourceId, credential: PlanCredential) => Promise<PlanCriblSourceResult>;
  /** Core applyCriblSource for a confirmed plan. */
  readonly onApply: (ready: ReadyCriblSource, credential: ApplyCredential) => Promise<ApplyCriblSourceOutcome>;
  /** The non-secret descriptor of a lane's paste, or null when cleared or invalid. */
  readonly onDescriptor?: (sourceId: OnboardingSourceId, descriptor: ConnectionDescriptor | null) => void;
  /** Reads the Cribl side (inputs and routes); the button is hidden without it. */
  readonly onReadCriblSide?: () => void;
  readonly criblSide?: OnboardingCriblSide | null;
  readonly criblSideBusy?: boolean;
}

const PANEL_TIP =
  "The app creates the Cribl source for each lane: an Azure Event Hubs source " +
  "(eventhub) or an Azure Blob Storage source (azure_blob). It only creates - " +
  "it never changes or deletes a source that is already there - and it asks " +
  "you to confirm first. The key goes into a Cribl secret; the source names the " +
  "secret and never holds the key. After the create, the app commits the " +
  "changed files and deploys the worker group, which restarts its workers.";

const RULE_TIP =
  "A Cribl Event Hubs source reads from the hub, so its key must come from a " +
  "rule with Listen (or Manage) rights. The Send rule the Defender export " +
  "writes with cannot be read from.";

const PASTE_TIP =
  "Paste the connection string of a Listen rule. Only the namespace host, the " +
  "key name and the hub are shown and checked; the key itself is sent once, " +
  "into a Cribl secret, when you confirm.";

const GROUP_TIP = "The Cribl Stream worker group the source runs on. Listed only when you ask.";

export function CriblSourcePanel(props: CriblSourcePanelProps) {
  const { rows, workerGroups, onLoadGroups, groupId, onGroupChange, rules, onReadRules } = props;
  const hasEventHub = rows.some((r) => r.transport === "eventhub");
  return (
    <div className="azo-cribl-source">
      <p className="panel-desc">
        The app creates the Cribl source for each chosen lane, after you confirm. <InfoTip text={PANEL_TIP} />
      </p>
      <div className="panel-controls">
        <button type="button" className="run-button" onClick={onLoadGroups}>
          {workerGroups.kind === "idle" ? "Load worker groups" : "Reload worker groups"}
        </button>
        <WorkerGroupField state={workerGroups} onRetry={onLoadGroups}>
          {(groups) => (
            <select
              aria-label="Worker group"
              value={groupId}
              onChange={(e) => onGroupChange(e.target.value)}
            >
              <option value="">Choose a worker group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.id}
                </option>
              ))}
            </select>
          )}
        </WorkerGroupField>
        <InfoTip text={GROUP_TIP} />
        {hasEventHub && onReadRules !== undefined && (
          <button type="button" className="run-button" onClick={onReadRules}>
            Read the namespace's rules
          </button>
        )}
        {props.onReadCriblSide !== undefined && (
          <button
            type="button"
            className="run-button"
            disabled={groupId.trim() === "" || props.criblSideBusy === true}
            onClick={props.onReadCriblSide}
          >
            Read Cribl side
          </button>
        )}
      </div>
      {hasEventHub && (
        <p className="field-hint">{listenRuleMessage(rules) ?? "Rules with Listen rights are offered below."}</p>
      )}
      {rows.length === 0 && <p className="field-hint">Choose a source above to give it a Cribl source.</p>}
      {rows.map((row) => (
        <LaneRow key={row.sourceId} row={row} panel={props} />
      ))}
    </div>
  );
}

type RowAction = ConfirmAction | { readonly type: "reset" } | { readonly type: "secret-changed" };

function rowReducer(state: ConfirmState, action: RowAction): ConfirmState {
  if (action.type === "reset") return CONFIRM_IDLE;
  // A blob lane's client secret has no descriptor, so it cannot reach the arm
  // key: any edit to it disarms directly. An apply already running keeps going.
  if (action.type === "secret-changed") return state.phase === "applying" ? state : CONFIRM_IDLE;
  return confirmReducer(state, action);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function LaneRow({ row, panel }: { readonly row: CriblSourceRow; readonly panel: CriblSourcePanelProps }) {
  const { sourceId, transport } = row;
  const { values, readSeq, groupId, rules, topicsFor, principal, onPlan, onApply, onDescriptor } = panel;
  const mode: SourceMode = panel.modes[sourceId] ?? "manual";
  const choices = credentialChoices(mode, transport);
  const [credentialKind, setCredentialKind] = useState<CredentialKind | null>(
    choices.find((c) => c.isDefault)?.kind ?? null,
  );
  const [rule, setRule] = useState("");
  const [attested, setAttested] = useState(false);
  const [parsed, setParsed] = useState<ParsedConnection | null>(null);
  const [hasClientSecret, setHasClientSecret] = useState(false);
  const [wiringError, setWiringError] = useState("");
  const [state, dispatch] = useReducer(rowReducer, CONFIRM_IDLE);

  // The secret lives here and in the uncontrolled field, nowhere else.
  const secretRef = useRef("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const clearSecret = useCallback(() => {
    secretRef.current = "";
    if (fieldRef.current !== null) fieldRef.current.value = "";
  }, []);
  useEffect(() => () => {
    secretRef.current = "";
  }, []);

  const descriptor: ConnectionDescriptor | null =
    credentialKind === "paste" && parsed !== null && !isInvalidConnection(parsed) ? parsed : null;
  const topics = transport === "eventhub" ? topicsFor(sourceId) : null;
  const pasteCheck =
    descriptor !== null && rules !== null && topics !== null && topics.kind === "ok"
      ? checkPastedCredential(descriptor, { namespace: values.namespace, topics: topics.topics, rules, attested })
      : null;

  const busy = state.phase === "planning" || state.phase === "applying";
  const gateReason = createDisabledReason({
    groupId,
    busy,
    transport,
    credentialKind,
    rule,
    paste: credentialKind === "paste" ? parsed : null,
    pasteCheck,
    topics,
    hasClientSecret,
  });
  const disabledReason =
    gateReason ??
    (transport === "blob" && principal === null
      ? "The service principal's tenant and client id are not set up."
      : null);

  const key = armKey({ groupId, sourceId, credentialKind, rule, attested, values, readSeq, descriptor });
  useEffect(() => {
    dispatch({ type: "inputs", key });
  }, [key]);

  const armed = isArmed(state, key);
  const planResult = state.phase === "planned" ? state.result : null;
  const showAttestation = transport === "eventhub" && (attested || needsAttestation({ pasteCheck, planResult }));

  function planCredential(): PlanCredential | null {
    if (credentialKind === "listKeys") return { kind: "listKeys", rule };
    if (credentialKind === "paste") return descriptor === null ? null : { kind: "paste", descriptor, attested };
    if (credentialKind === "client-secret") {
      return principal === null ? null : { kind: "client-secret", ...principal };
    }
    return null;
  }

  async function onCreate(): Promise<void> {
    const action = createClick(state, key);
    if (action === "none") return;
    setWiringError("");
    if (action === "apply" && state.phase === "armed") {
      const ready = state.ready;
      dispatch({ type: "apply-start", key });
      const credential: ApplyCredential =
        credentialKind === "listKeys" ? { kind: "listKeys" } : { kind: "paste", value: () => secretRef.current };
      try {
        const outcome = await onApply(ready, credential);
        dispatch({ type: "apply-result", outcome });
      } catch (error) {
        setWiringError(
          `The create stopped before it reported an outcome: ${errorText(error)}. Check the worker group in Cribl for the secret and the source before retrying.`,
        );
        dispatch({ type: "reset" });
      } finally {
        clearSecret();
        setParsed(null);
        setHasClientSecret(false);
        onDescriptor?.(sourceId, null);
      }
      return;
    }
    if (disabledReason !== null) return;
    const credential = planCredential();
    if (credential === null) return;
    dispatch({ type: "plan-start", key });
    try {
      const result = await onPlan(sourceId, credential);
      dispatch({ type: "plan-result", key, result });
    } catch (error) {
      setWiringError(`The check before the create did not finish: ${errorText(error)}`);
      dispatch({ type: "reset" });
    }
  }

  function onPaste(value: string): void {
    secretRef.current = value;
    if (transport === "blob") {
      dispatch({ type: "secret-changed" });
      setHasClientSecret(value !== "");
      return;
    }
    const next = value === "" ? null : parseEventHubConnectionString(value);
    setParsed(next);
    onDescriptor?.(sourceId, next !== null && !isInvalidConnection(next) ? next : null);
  }

  const pasteView = credentialKind === "paste" ? pasteDescriptorView(parsed) : null;
  const ruleRows = rules !== null && rules.state === "read" ? listenRules(rules.rows) : [];
  const resultView: OutcomeView | null =
    state.phase === "done" ? outcomeView(state.outcome) : planResult !== null ? planResultView(planResult) : null;
  const usesPasteField = credentialKind === "paste" || credentialKind === "client-secret";

  return (
    <section className="azo-cribl-row" aria-label={`Cribl source for ${row.title}`}>
      <h4>
        {row.title} <InfoTip text={`${row.title} is received by a ${row.inputTypeLabel}.`} />
      </h4>
      <p className="field-hint">{`${row.inputTypeLabel}. ${row.status}`}</p>
      <CriblSideLine side={panel.criblSide ?? null} inputId={row.record?.inputId ?? null} />

      <div className="form-grid">
        {choices.length > 1 && (
          <fieldset>
            <legend>Credential</legend>
            {choices.map((c) => (
              <label key={c.kind} className="integrate-check">
                <input
                  type="radio"
                  name={`azo-cred-${sourceId}`}
                  checked={credentialKind === c.kind}
                  onChange={() => {
                    // A paste typed for one choice never carries into another.
                    clearSecret();
                    setParsed(null);
                    setHasClientSecret(false);
                    onDescriptor?.(sourceId, null);
                    setCredentialKind(c.kind);
                  }}
                />
                <span className="integrate-check-text">{c.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        {credentialKind === "listKeys" && (
          <label className="field">
            <span className="field-label">
              Listen rule <InfoTip text={RULE_TIP} />
            </span>
            <select
              aria-label={`Listen rule for ${row.title}`}
              value={rule}
              disabled={ruleRows.length === 0}
              onChange={(e) => setRule(e.target.value)}
            >
              <option value="">Choose a rule with Listen rights</option>
              {ruleRows.map((r) => (
                <option key={r.name} value={r.name}>
                  {`${r.name} (${r.rights.join(", ")})`}
                </option>
              ))}
            </select>
          </label>
        )}

        {usesPasteField && (
          <label className="field">
            <span className="field-label">
              {transport === "blob" ? "Client secret" : "Connection string"}{" "}
              {transport === "eventhub" && <InfoTip text={PASTE_TIP} />}
            </span>
            <input
              ref={fieldRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={transport === "blob" ? `Client secret for ${row.title}` : `Connection string for ${row.title}`}
              onChange={(e) => onPaste(e.target.value)}
            />
          </label>
        )}

        {pasteView !== null &&
          (pasteView.ok ? (
            <dl aria-label="Pasted connection string">
              {pasteView.rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="field-hint">{pasteView.text}</p>
          ))}

        {showAttestation && (
          <label className="integrate-check">
            <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
            <span className="integrate-check-text">{ATTESTATION_LABEL}</span>
          </label>
        )}
      </div>

      {armed && (
        <div className="azo-confirm" role="alert">
          {confirmText(state.ready).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={busy || (!armed && disabledReason !== null)}
          onClick={() => void onCreate()}
        >
          {state.phase === "planning"
            ? "Checking..."
            : state.phase === "applying"
              ? "Creating..."
              : armed
                ? "Confirm: create the source"
                : "Create the Cribl source"}
        </button>
        {armed && (
          <button type="button" className="run-button" onClick={() => dispatch({ type: "reset" })}>
            Cancel
          </button>
        )}
      </div>
      {!armed && !busy && disabledReason !== null && <p className="field-hint">{disabledReason}</p>}
      {wiringError !== "" && <p className="field-hint" role="alert">{wiringError}</p>}
      {resultView !== null && (
        <div role="status" data-tone={resultView.tone}>
          <p>
            <strong>{resultView.headline}</strong>
          </p>
          {resultView.detail !== "" && <p>{resultView.detail}</p>}
          {resultView.inCribl !== null && <p>{resultView.inCribl}</p>}
        </div>
      )}
    </section>
  );
}

function presenceText(p: InputPresence): string {
  switch (p.kind) {
    case "present":
      return p.disabled ? `present in Cribl (${p.type}), disabled` : `present in Cribl (${p.type})`;
    case "absent":
      return "not in the worker group's sources";
    case "unknown":
      return `could not be read (${p.detail})`;
  }
}

function routeText(r: RouteConsumption): string {
  switch (r.kind) {
    case "consumes": {
      const last = r.routes[r.routes.length - 1];
      return last === undefined
        ? "routed"
        : `routed by ${last.name}${last.output === undefined ? "" : ` to ${last.output}`}`;
    }
    case "cannot-evaluate":
      return `cannot check: route ${r.routeId} has a filter the app cannot evaluate`;
    case "not-routed":
      return "no final route receives it";
    case "quickconnect":
      return `sent by QuickConnect to ${r.connections.map((c) => c.output).join(", ") || "no destination"}`;
    case "unknown":
      return `routes could not be read (${r.detail})`;
  }
}

/** What the last "Read Cribl side" found for this lane's input; nothing before a read. */
function CriblSideLine({ side, inputId }: { readonly side: OnboardingCriblSide | null; readonly inputId: string | null }) {
  if (side === null || inputId === null) return null;
  const entry = side.inputs.find((i) => i.inputId === inputId);
  if (entry === undefined) return null;
  return (
    <p className="field-hint">{`In worker group ${side.groupId}: ${presenceText(entry.input)}; ${routeText(entry.route)}.`}</p>
  );
}
