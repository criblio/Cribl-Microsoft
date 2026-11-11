/**
 * The tenant inventory heat map: one card per top category coloured by
 * coverage, with a collected bar and an archived bar. Opening a card shows a
 * grid of log-type tiles coloured the same way, each naming its collector,
 * destination and archive state. Reading changes nothing in Azure or Cribl.
 */

import { useState } from "react";
import { cellTone } from "@soc/core";
import type { InventoryCategoryId, TenantInventory } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { cardSummary, cellLabel, destinationLabel, shareLabel } from "./tenant-inventory-state";

export interface TenantInventoryHeatmapProps {
  inventory: TenantInventory | null;
  reading: boolean;
  /** Why the read button is disabled, or null when it can be used. */
  disabledReason: string | null;
  onRead: () => void;
}

const COLOUR_WORD = {
  green: "collected and archived",
  amber: "collected, not archived",
  red: "not collected",
  blue: "could not check",
  mixed: "a mix of states",
} as const;

const HEATMAP_TIP =
  "Each card is one kind of log. Green is collected and archived, amber is collected but not archived, red is not collected, and blue means the app could not check.\n" +
  "Open a card to see each log type, what collects it and where it goes. Reading only looks; it changes nothing.";

function Bar({ label, share }: { label: string; share: number | null }) {
  return (
    <div className="tih-bar-row">
      <span className="tih-bar-label">{label}</span>
      <span className="tih-bar" aria-hidden="true">
        <span className="tih-bar-fill" style={{ width: share === null ? "0%" : `${Math.round(share * 100)}%` }} />
      </span>
      <span className="tih-bar-value">{shareLabel(share)}</span>
    </div>
  );
}

export function TenantInventoryHeatmap({ inventory, reading, disabledReason, onRead }: TenantInventoryHeatmapProps) {
  const [open, setOpen] = useState<InventoryCategoryId | null>(null);
  const blocked = reading || disabledReason !== null;
  const openCard = inventory?.cards.find((c) => c.id === open) ?? null;
  const tiles = inventory?.cells.filter((c) => c.category === open) ?? [];

  return (
    <div className="tih">
      <div className="tih-head">
        <button type="button" className="run-button" onClick={onRead} disabled={blocked}>
          {reading ? "Reading the tenant's logging..." : "Read the tenant's logging"}
        </button>
        <InfoTip text={HEATMAP_TIP} label="About the logging heat map" />
        <span className="tih-note">Reading only looks. Nothing is changed in Azure or Cribl.</span>
      </div>
      {disabledReason !== null && <p className="tih-disabled-reason">{disabledReason}</p>}
      {inventory !== null && (
        <>
          <p className="tih-read-at">Read at {inventory.readAt}</p>
          {inventory.subscriptions.kind === "unread" && (
            <p className="tih-warning">Subscriptions could not be listed: {inventory.subscriptions.reason}</p>
          )}
          <div className="tih-cards">
            {inventory.cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className={`tih-card tih-tone-${card.colour}`}
                aria-expanded={open === card.id}
                onClick={() => setOpen(open === card.id ? null : card.id)}
              >
                <span className="tih-card-title">{card.title}</span>
                <span className="tih-card-state">{card.notChecked !== null ? "not checked yet" : COLOUR_WORD[card.colour]}</span>
                <span className="tih-card-summary">{cardSummary(card)}</span>
                {card.notChecked === null && (
                  <>
                    <Bar label="Collected" share={card.collectedShare} />
                    <Bar label="Archived" share={card.archivedShare} />
                  </>
                )}
              </button>
            ))}
          </div>
          {openCard !== null && (
            <section className="tih-detail" aria-label={`${openCard.title} log types`}>
              <h3 className="tih-detail-title">{openCard.title}</h3>
              {openCard.notChecked !== null ? (
                <p className="tih-detail-empty">{openCard.notChecked}</p>
              ) : tiles.length === 0 ? (
                <p className="tih-detail-empty">Could not check: no log types were read for this category.</p>
              ) : (
                <ul className="tih-tiles">
                  {tiles.map((cell) => (
                    <li key={cell.logType} className={`tih-tile tih-tone-${cellTone(cell)}`}>
                      <span className="tih-tile-title">{cell.title}</span>
                      <span className="tih-tile-state">{cellLabel(cell)}</span>
                      {cell.collectors.map((c, i) => (
                        <span key={`${c.scope}-${c.name}-${i}`} className="tih-tile-collector">
                          {c.name} ({c.scope})
                          {c.destinations.length > 0 && <> to {c.destinations.map(destinationLabel).join(", ")}</>}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
