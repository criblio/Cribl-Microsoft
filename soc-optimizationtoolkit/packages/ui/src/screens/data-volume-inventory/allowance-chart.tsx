/**
 * EligibleAppliedChart (MIG-15) - one grant's daily eligible volume against
 * the benefit Microsoft applied, over the inventory window. Inline SVG, no
 * chart dependency: two 2px lines on one axis (both are MB a day), a legend,
 * a hover readout per day and a per-day table for anyone who cannot read the
 * lines. Series colors are the dataviz reference slots 1 and 2 (blue, orange),
 * validated for CVD separation against both theme surfaces, held in the
 * --chart-series-* tokens so the dark theme selects its own steps.
 */

import { useState } from "react";
import { formatMB } from "./format-mb";

export interface EligibleAppliedChartProps {
  eligibleByDay: ReadonlyMap<string, number>;
  /** Null when the applied benefit is known only pooled, not per grant. */
  usedByDay: ReadonlyMap<string, number> | null;
  /** False when eligible volume was not read: its line is not drawn. */
  eligibleKnown: boolean;
}

const W = 600;
const H = 150;
const PAD = { left: 8, right: 8, top: 10, bottom: 20 };

export function EligibleAppliedChart({ eligibleByDay, usedByDay, eligibleKnown }: EligibleAppliedChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const days = [...new Set([...eligibleByDay.keys(), ...(usedByDay?.keys() ?? [])])].sort();
  if (days.length === 0) {
    return <p className="field-hint">No eligible volume and no applied benefit on any day in the window.</p>;
  }
  const eligible = days.map((d) => eligibleByDay.get(d) ?? 0);
  const used = days.map((d) => usedByDay?.get(d) ?? 0);
  const max = Math.max(1, ...(eligibleKnown ? eligible : []), ...(usedByDay !== null ? used : []));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const path = (values: number[]) => values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const step = days.length === 1 ? plotW : plotW / (days.length - 1);
  const readout =
    hover === null
      ? `Peak ${formatMB(max)} a day. Hover a day for its values.`
      : `${days[hover]}: eligible ${eligibleKnown ? formatMB(eligible[hover]!) : "not read"}, applied ${
          usedByDay === null ? "pooled only" : formatMB(used[hover]!)
        }`;

  return (
    <div className="allowance-chart">
      <div className="allowance-chart-legend">
        {eligibleKnown && (
          <span>
            <span className="allowance-swatch allowance-swatch-eligible" /> Eligible
          </span>
        )}
        {usedByDay !== null && (
          <span>
            <span className="allowance-swatch allowance-swatch-applied" /> Applied by Microsoft
          </span>
        )}
      </div>
      <div className="field-hint" aria-live="polite">
        {readout}
      </div>
      <svg
        className="allowance-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Daily eligible volume against the benefit applied"
        onMouseLeave={() => setHover(null)}
      >
        <line className="allowance-chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(max)} y2={y(max)} />
        <line className="allowance-chart-axis" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        <text className="allowance-chart-label" x={PAD.left} y={H - 4}>
          {days[0]}
        </text>
        <text className="allowance-chart-label" x={W - PAD.right} y={H - 4} textAnchor="end">
          {days[days.length - 1]}
        </text>
        {hover !== null && (
          <line className="allowance-chart-grid" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} />
        )}
        {eligibleKnown && <path className="allowance-line-eligible" d={path(eligible)} />}
        {usedByDay !== null && <path className="allowance-line-applied" d={path(used)} />}
        {days.map((d, i) => (
          <rect
            key={d}
            className="allowance-chart-hit"
            x={x(i) - step / 2}
            y={PAD.top}
            width={step}
            height={plotH}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <details className="gap-handles">
        <summary>Per-day values</summary>
        <div className="gap-handles-body">
          {days.map((d, i) => (
            <div key={d}>
              {d}: eligible {eligibleKnown ? formatMB(eligible[i]!) : "not read"}, applied{" "}
              {usedByDay === null ? "pooled only" : formatMB(used[i]!)}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
