/**
 * architecture-svg-export - the unified diagram as a standalone SVG string
 * (2026-07-29). Pure: reuses the arch-layout dagre geometry (identical
 * coordinates to the on-screen canvas), no DOM access, deterministic. The
 * artifact is static (no animation) and always renders the LIGHT palette so
 * it stays legible in docs, wikis, and print regardless of the app theme.
 */

import type {
  DiagramTier,
  EdgeCostTier,
  EdgeFlowTone,
  PatternDiagram,
} from "@soc/core";
import {
  NODE_W,
  layoutDiagram,
  nodeBadge,
  polylineMidpoint,
  sourceTypeChips,
  type EdgePoint,
  type LaidOutNode,
} from "./arch-layout";

/**
 * The LIGHT theme tokens from styles.css, hardcoded: getComputedStyle would
 * make the exporter DOM-bound and theme-dependent. Keep in sync with the
 * :root light block.
 */
const PALETTE = {
  surface: "#ffffff",
  border: "#d9d9d9",
  text: "#262626",
  muted: "#595959",
  faint: "#8c8c8c",
  accent: "#1890ff",
  accentBg: "#e6f4ff",
  infoCyan: "#0e7fc2",
  ok: "#52c41a",
  okBg: "#f6ffed",
  okStrong: "#389e0d",
  warn: "#d46b08",
  warnBg: "#fff7e6",
} as const;

/** Per-tier node styling (mirrors .arch-flow-node-* classes). */
const TIER_STYLE: Record<DiagramTier, { stroke: string; fill: string; badge: string }> = {
  source: { stroke: PALETTE.faint, fill: PALETTE.surface, badge: PALETTE.faint },
  cribl: { stroke: PALETTE.accent, fill: PALETTE.accentBg, badge: PALETTE.accent },
  azure: { stroke: PALETTE.infoCyan, fill: PALETTE.surface, badge: PALETTE.infoCyan },
  destination: { stroke: PALETTE.ok, fill: PALETTE.okBg, badge: PALETTE.okStrong },
};

function edgeStroke(cost: EdgeCostTier | undefined): string {
  if (cost === "premium") {
    return PALETTE.warn;
  }
  if (cost === "economical") {
    return PALETTE.ok;
  }
  return PALETTE.faint;
}

/** The LINE color: a flow tone (the violet Search send path) beats cost. */
function lineStroke(
  tone: EdgeFlowTone | undefined,
  cost: EdgeCostTier | undefined,
): string {
  if (tone === "search") {
    return "#722ed1";
  }
  return edgeStroke(cost);
}

/** Escape a label for XML text/attribute contexts. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Split a long label at the space (or _ / - / .) nearest its middle; a long
 * UNBROKEN token hard-splits at the midpoint so it never overhangs the card
 * (user report 2026-07-30: Reduction_Zscaler_Internet_firewall).
 */
function splitLabel(label: string): [string] | [string, string] {
  if (label.length <= 26) {
    return [label];
  }
  const middle = Math.floor(label.length / 2);
  let split = -1;
  for (let i = 1; i < label.length - 1; i++) {
    if (
      " _-.".includes(label[i]) &&
      (split === -1 || Math.abs(i - middle) < Math.abs(split - middle))
    ) {
      split = i;
    }
  }
  if (split === -1) {
    return [label.slice(0, middle), label.slice(middle)];
  }
  return label[split] === " "
    ? [label.slice(0, split), label.slice(split + 1)]
    : [label.slice(0, split + 1), label.slice(split + 1)];
}

/**
 * The waypoints an edge is drawn through: dagre's routed points (which
 * dodge node columns via virtual nodes) when present, else a straight
 * right-center -> left-center fallback.
 */
function edgePoints(
  points: EdgePoint[],
  from: LaidOutNode,
  to: LaidOutNode,
): EdgePoint[] {
  if (points.length >= 2) {
    return points;
  }
  return [
    { x: from.x + NODE_W, y: from.y + from.height / 2 },
    { x: to.x, y: to.y + to.height / 2 },
  ];
}

/** Round a coordinate to keep the document byte-stable and small. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A smoothed path through the waypoints (quadratic joins at interior points). */
function routedPath(points: EdgePoint[]): string {
  const first = points[0];
  let d = `M ${round(first.x)} ${round(first.y)}`;
  const r = 8;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (inLen < 1 || outLen < 1) {
      continue;
    }
    const inT = Math.max(0, 1 - r / inLen);
    const outT = Math.min(1, r / outLen);
    const before = {
      x: prev.x + (corner.x - prev.x) * inT,
      y: prev.y + (corner.y - prev.y) * inT,
    };
    const after = {
      x: corner.x + (next.x - corner.x) * outT,
      y: corner.y + (next.y - corner.y) * outT,
    };
    d +=
      ` L ${round(before.x)} ${round(before.y)}` +
      ` Q ${round(corner.x)} ${round(corner.y)} ${round(after.x)} ${round(after.y)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${round(last.x)} ${round(last.y)}`;
  return d;
}


/** Render the unified diagram as a self-contained SVG document string. */
export function diagramToSvg(diagram: PatternDiagram): string {
  const laidOut = layoutDiagram(diagram);
  const width = Math.max(laidOut.width, 1);
  const height = Math.max(laidOut.height, 1);
  const nodeById = new Map(laidOut.nodes.map((n) => [n.id, n]));

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${PALETTE.surface}"/>`,
    `<defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" ` +
      `markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="${PALETTE.faint}"/></marker></defs>`,
  ];

  // THREE passes so nothing strikes through anything (review 2026-07-29):
  // every edge PATH first, then every label/cost caption (backed) on top of
  // the lines, then the node cards on top of everything. Labels anchor at
  // the half-length point of the ROUTED polyline so they sit on their line.
  const labelParts: string[] = [];
  for (const edge of laidOut.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const points = edgePoints(edge.points, from, to);
    parts.push(
      `<path d="${routedPath(points)}" fill="none" ` +
        `stroke="${lineStroke(edge.tone, edge.cost)}" ` +
        `stroke-width="1.6" marker-end="url(#arch-arrow)"` +
        `${edge.muted === true ? ' stroke-opacity="0.3"' : ""}/>`,
    );
    // Labels anchor at DAGRE'S reserved label point when present (the layout
    // keeps that spot clear of cards and other labels - user report
    // 2026-07-30: overlap); unlabeled edges fall back to the path midpoint.
    const anchor = edge.labelPoint ?? polylineMidpoint(points);
    const midX = round(anchor.x);
    const midY = round(anchor.y);
    let costTop = midY + 1;
    if (edge.label !== undefined && edge.label !== "") {
      const lines = splitLabel(edge.label);
      const backW =
        Math.max(...lines.map((line) => line.length)) * 5.5 + 10;
      const backH = lines.length * 12 + 4;
      const backTop = midY - backH / 2;
      labelParts.push(
        `<rect x="${round(midX - backW / 2)}" y="${round(backTop)}" ` +
          `width="${round(backW)}" height="${backH}" rx="3" ` +
          `fill="${PALETTE.surface}" opacity="0.92"/>`,
        `<text x="${midX}" y="${round(backTop + 11)}" text-anchor="middle" ` +
          `font-size="10" fill="${PALETTE.muted}">${esc(lines[0])}` +
          (lines.length > 1
            ? `<tspan x="${midX}" dy="12">${esc(lines[1] ?? "")}</tspan>`
            : "") +
          `</text>`,
      );
      costTop = midY + backH / 2 + 1;
    }
    if (edge.cost !== undefined) {
      const capW = edge.cost.length * 6 + 8;
      labelParts.push(
        `<rect x="${round(midX - capW / 2)}" y="${round(costTop)}" ` +
          `width="${round(capW)}" height="12" rx="3" ` +
          `fill="${PALETTE.surface}" opacity="0.92"/>`,
        `<text x="${midX}" y="${round(costTop + 9)}" text-anchor="middle" ` +
          `font-size="8" font-weight="700" letter-spacing="0.5" ` +
          `fill="${edgeStroke(edge.cost)}">${edge.cost.toUpperCase()}</text>`,
      );
    }
  }
  parts.push(...labelParts);

  for (const node of laidOut.nodes) {
    const style = TIER_STYLE[node.tier];
    const lines = splitLabel(node.label);
    const label =
      lines.length === 1
        ? `<text x="${NODE_W / 2}" y="38" text-anchor="middle" font-size="12.5" ` +
          `font-weight="600" fill="${PALETTE.text}">${esc(lines[0])}</text>`
        : `<text x="${NODE_W / 2}" y="32" text-anchor="middle" font-size="12" ` +
          `font-weight="600" fill="${PALETTE.text}">${esc(lines[0])}` +
          `<tspan x="${NODE_W / 2}" dy="14">${esc(lines[1] ?? "")}</tspan></text>`;
    const chips =
      node.sourceTypes.length > 0
        ? `<text x="${NODE_W / 2}" y="${node.height - 8}" text-anchor="middle" ` +
          `font-size="8" font-weight="700" letter-spacing="0.4" fill="${PALETTE.accent}">` +
          `${esc(sourceTypeChips(node.sourceTypes).join("  "))}</text>`
        : "";
    // Service tags (e.g. Sentinel on the workspace) overlap the card's
    // bottom-right corner - drawn after the rect so they sit on top.
    const overlays = (node.overlays ?? [])
      .map((overlay, index) => {
        const tagW = overlay.length * 5.8 + 14;
        const tagY = node.height - 10 + index * 18;
        return (
          `<rect x="${round(NODE_W - tagW + 10)}" y="${tagY}" width="${round(tagW)}" ` +
          `height="16" rx="8" fill="${PALETTE.infoCyan}"/>` +
          `<text x="${round(NODE_W - tagW / 2 + 10)}" y="${tagY + 11}" ` +
          `text-anchor="middle" font-size="8.5" font-weight="700" ` +
          `letter-spacing="0.4" fill="#ffffff">${esc(overlay.toUpperCase())}</text>`
        );
      })
      .join("");
    parts.push(
      `<g transform="translate(${node.x},${node.y})"` +
        `${node.muted === true ? ' opacity="0.5"' : ""}>` +
        `<rect width="${NODE_W}" height="${node.height}" rx="12" fill="${style.fill}" ` +
        `stroke="${style.stroke}" stroke-width="1.4"/>` +
        `<text x="${NODE_W / 2}" y="16" text-anchor="middle" font-size="9" ` +
        `font-weight="700" letter-spacing="0.8" fill="${style.badge}">` +
        `${esc((node.badge ?? nodeBadge(node.label, node.tier)).toUpperCase())}</text>` +
        label +
        chips +
        overlays +
        `</g>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}
