/**
 * ListenAccessRemovePanel - Remove the Listen rule and consumer groups this
 * app created (AZR-36), shown inside "Remove or pause what this app created"
 * beside the Activity Log and Entra ID rows.
 *
 * Shown from the app's RECORDS, whatever is chosen now: one row per object the
 * app's own PUT created. Remove is TWO CLICKS: the first arms a confirm that
 * quotes the exact DELETE and what is checked; the second runs core
 * removeListenAccessObject, which reads the object now and deletes it only
 * when it is provably the app's (the record, the name, and the stamp - for a
 * rule, its rights still Listen alone) and no Cribl Event Hubs source the app
 * recorded remains (it may read with it: remove that first, above).
 */

import { useState } from "react";
import { removeListenAccessObject } from "@soc/core";
import type { EventHubAccessRecord, ListenAccessRemoveOutcome } from "@soc/core";
import { usePorts } from "../../../ports-context";
import { useReportBusy } from "../operation-busy";
import { PickerLine } from "../eventhub-prerequisite-section";
import { accessRecordTitle, accessRemoveConfirmText, accessRemoveMessage } from "./listen-access-state";

export interface ListenAccessRemovePanelProps {
  /** Every object the app recorded creating. */
  readonly records: readonly EventHubAccessRecord[];
  /** The Cribl Event Hubs sources the app still records (they may read with these). */
  readonly inUseBy: readonly string[];
  /** Called with every outcome, so the screen can forget a removed object's record. */
  readonly onRemoved: (record: EventHubAccessRecord, outcome: ListenAccessRemoveOutcome) => void;
}

export function ListenAccessRemovePanel({ records, inUseBy, onRemoved }: ListenAccessRemovePanelProps) {
  // The last outcome is kept here, not in its row: a removed object's record
  // goes, and its row with it, but what happened must still be said.
  const [last, setLast] = useState<ListenAccessRemoveOutcome | null>(null);
  if (records.length === 0 && last === null) return null;
  return (
    <>
      {records.map((record) => (
        <RemoveRow
          key={record.resourceId}
          record={record}
          records={records}
          inUseBy={inUseBy}
          onRemoved={(r, outcome) => {
            setLast(outcome);
            onRemoved(r, outcome);
          }}
        />
      ))}
      {last !== null && <PickerLine message={accessRemoveMessage(last)} />}
    </>
  );
}

function RemoveRow({
  record,
  records,
  inUseBy,
  onRemoved,
}: {
  readonly record: EventHubAccessRecord;
  readonly records: readonly EventHubAccessRecord[];
  readonly inUseBy: readonly string[];
  readonly onRemoved: ListenAccessRemovePanelProps["onRemoved"];
}) {
  const { ports } = usePorts();
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  useReportBusy("a Listen rule or consumer group removal", removing);
  const title = accessRecordTitle(record);

  async function confirmRemove(): Promise<void> {
    setArmed(false);
    setRemoving(true);
    ports.logger?.info("azure-onboarding: listen access remove confirmed", { kind: record.kind });
    try {
      const result = await removeListenAccessObject(ports.azure, { record, recorded: records, inUseBy }, ports.logger);
      onRemoved(record, result);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="azure-onboarding-subblock" aria-label={title}>
      <span className="field-label">{title}</span>
      <div className="panel-controls">
        <button type="button" className="run-button" disabled={removing || armed} onClick={() => setArmed(true)}>
          {removing ? "Removing..." : "Remove"}
        </button>
      </div>
      {armed && (
        <div className="azure-onboarding-confirm" role="group" aria-label={`Confirm removal of ${title}`}>
          <p className="panel-desc">{accessRemoveConfirmText(record)}</p>
          <div className="panel-controls">
            <button type="button" className="next-action-button" onClick={() => void confirmRemove()}>
              Confirm remove
            </button>
            <button type="button" className="run-button" onClick={() => setArmed(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
