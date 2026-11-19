/**
 * ReceiverGrantRemovePanel - Remove the Azure Event Hubs Data Receiver role
 * assignments this app granted the Cribl principal (AZR-141), shown inside
 * "Remove or pause what this app created" beside the Activity Log, Entra ID
 * and Listen access rows.
 *
 * Shown from the app's RECORDS (progress.receiverGrants), whatever is chosen
 * now: one row per assignment the app's own PUT created.
 *
 * Remove is TWO CLICKS: the first arms a confirm quoting the exact DELETE,
 * the scope, the role and the principal; the second runs core
 * removeReceiverGrant, which reads the assignment by name and deletes it only
 * when the record, the deterministic name and the description stamp all prove
 * it the app's, then reads for the 404.
 *
 * IN USE. While a Cribl Event Hubs source the app created is still recorded,
 * it may sign in with Entra ID as this principal, so the removal is refused
 * (the source record says neither its credential nor its hub). The refusal
 * offers "Remove anyway", which arms a SECOND, separately worded confirm
 * naming those sources; only its confirm sends the override. The ownership
 * proof is never overridden.
 *
 * MUTUALLY EXCLUSIVE with the grant: Remove is off while a Check or grant runs
 * (`granting`), and a running Remove is reported (`onRunningChange`) so the
 * grant section keeps its Check and Grant off meanwhile - as the Activity
 * Log's Deploy and Remove are (AZR-121).
 *
 * PERMISSION. roleAssignments/delete is not measured: a note says so; never
 * a block - Azure's answer decides.
 */

import { useEffect, useState } from "react";
import { receiverGrantKey, removeReceiverGrant } from "@soc/core";
import type { ReceiverGrantRecord, ReceiverGrantRemoveOutcome } from "@soc/core";
import { usePorts } from "../../ports-context";
import { PickerLine } from "./eventhub-prerequisite-section";
import {
  RECEIVER_GRANT_REMOVE_PERMISSION_NOTE,
  receiverGrantOverrideConfirmText,
  receiverGrantRecordTitle,
  receiverGrantRemoveConfirmText,
  receiverGrantRemoveDisabledReason,
  receiverGrantRemoveMessage,
} from "./receiver-grant-state";

export interface ReceiverGrantRemovePanelProps {
  /** Every Data Receiver assignment the app recorded creating. */
  readonly records: readonly ReceiverGrantRecord[];
  /** The Cribl Event Hubs sources the app still records (they may read with these). */
  readonly inUseBy: readonly string[];
  /** A Data Receiver Check or grant is running in the grant section: Remove is off meanwhile. */
  readonly granting: boolean;
  /** Told when a Remove starts and finishes, so the grant section stays off meanwhile. */
  readonly onRunningChange: (running: boolean) => void;
  /** Called with every outcome, so the screen can forget a removed assignment's record. */
  readonly onRemoved: (outcome: ReceiverGrantRemoveOutcome) => void;
}

export function ReceiverGrantRemovePanel({ records, inUseBy, granting, onRunningChange, onRemoved }: ReceiverGrantRemovePanelProps) {
  const [removing, setRemoving] = useState(false);
  // The last outcome is kept here, not in its row: a removed assignment's
  // record goes, and its row with it, but what happened must still be said.
  const [last, setLast] = useState<ReceiverGrantRemoveOutcome | null>(null);
  if (records.length === 0 && last === null) return null;
  return (
    <>
      {records.map((record) => (
        <RemoveRow
          key={receiverGrantKey(record)}
          record={record}
          records={records}
          inUseBy={inUseBy}
          granting={granting}
          anyRemoving={removing}
          onRunning={(running) => {
            setRemoving(running);
            onRunningChange(running);
          }}
          onOutcome={(outcome) => {
            setLast(outcome);
            onRemoved(outcome);
          }}
        />
      ))}
      {last !== null && <PickerLine message={receiverGrantRemoveMessage(last)} />}
    </>
  );
}

type Arm = "none" | "remove" | "override";

function RemoveRow({
  record,
  records,
  inUseBy,
  granting,
  anyRemoving,
  onRunning,
  onOutcome,
}: {
  readonly record: ReceiverGrantRecord;
  readonly records: readonly ReceiverGrantRecord[];
  readonly inUseBy: readonly string[];
  readonly granting: boolean;
  readonly anyRemoving: boolean;
  readonly onRunning: (running: boolean) => void;
  readonly onOutcome: (outcome: ReceiverGrantRemoveOutcome) => void;
}) {
  const { ports } = usePorts();
  const [arm, setArm] = useState<Arm>("none");
  const [removing, setRemoving] = useState(false);
  // Set only by an in-use refusal: the sources it named, which the second confirm quotes.
  const [refusedFor, setRefusedFor] = useState<readonly string[] | null>(null);
  const title = receiverGrantRecordTitle(record);
  const reason = receiverGrantRemoveDisabledReason({ granting, removing: removing || anyRemoving });
  const azure = ports.azure;
  const noAzure = azure === undefined ? "There is no Azure connection configured." : null;
  const off = reason ?? noAzure;

  // A grant starting drops an armed confirm outright, so it does not come
  // back when the grant finishes; so does a change to the in-use sources.
  const inUseKey = inUseBy.join("|");
  useEffect(() => {
    if (granting) setArm("none");
  }, [granting]);
  useEffect(() => {
    setRefusedFor(null);
    setArm((a) => (a === "override" ? "none" : a));
  }, [inUseKey]);

  async function run(override: boolean): Promise<void> {
    if (azure === undefined || off !== null) return;
    setArm("none");
    setRemoving(true);
    onRunning(true);
    ports.logger?.info("azure-onboarding: receiver grant remove confirmed", { override });
    try {
      const outcome = await removeReceiverGrant(azure, { record, recorded: records, inUseBy, override }, ports.logger);
      setRefusedFor(outcome.kind === "in-use" ? inUseBy : null);
      onOutcome(outcome);
    } finally {
      setRemoving(false);
      onRunning(false);
    }
  }

  return (
    <div className="azure-onboarding-subblock" aria-label={title}>
      <span className="field-label">{title}</span>
      <div className="panel-controls">
        <button type="button" className="run-button" disabled={off !== null || arm !== "none"} onClick={() => setArm("remove")}>
          {removing ? "Removing..." : "Remove"}
        </button>
        {refusedFor !== null && arm === "none" && (
          <button type="button" className="run-button" disabled={off !== null} onClick={() => setArm("override")}>
            Remove anyway
          </button>
        )}
        {off !== null && !removing && <span className="field-hint">{off}</span>}
      </div>
      <p className="field-hint">{RECEIVER_GRANT_REMOVE_PERMISSION_NOTE}</p>
      {arm === "remove" && off === null && (
        <div className="azure-onboarding-confirm" role="group" aria-label={`Confirm removal of ${title}`}>
          <p className="panel-desc">{receiverGrantRemoveConfirmText(record)}</p>
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void run(false)}>
              Confirm remove
            </button>
            <button type="button" className="run-button" onClick={() => setArm("none")}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {arm === "override" && off === null && refusedFor !== null && (
        <div className="azure-onboarding-confirm" role="group" aria-label={`Confirm removal of ${title} while in use`}>
          <p className="panel-desc">{receiverGrantOverrideConfirmText(record, refusedFor)}</p>
          <p className="panel-desc">{receiverGrantRemoveConfirmText(record)}</p>
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void run(true)}>
              Confirm: remove although in use
            </button>
            <button type="button" className="run-button" onClick={() => setArm("none")}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
