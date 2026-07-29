/**
 * architecture-svg-export - the unified diagram as a standalone SVG string
 * (2026-07-29). Pure: reuses the arch-layout dagre geometry (identical
 * coordinates to the on-screen canvas), no DOM access, deterministic. The
 * artifact is static (no animation) and always renders the LIGHT palette so
 * it stays legible in docs, wikis, and print regardless of the app theme.
 */

import type { DiagramTier, EdgeCostTier, PatternDiagram } from "@soc/core";
import { NODE_H, NODE_W, layoutDiagram, nodeBadge, type LaidOutNode } from "./arch-layout";

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

/** Escape a label for XML text/attribute contexts. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Split a long label at the space nearest its middle (two-line rendering). */
function splitLabel(label: string): [string] | [string, string] {
  if (label.length <= 26) {
    return [label];
  }
  const middle = Math.floor(label.length / 2);
  let split = -1;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === " " && (split === -1 || Math.abs(i - middle) < Math.abs(split - middle))) {
      split = i;
    }
  }
  if (split === -1) {
    return [label];
  }
  return [label.slice(0, split), label.slice(split + 1)];
}

/** An orthogonal elbow path from a node's right-center to another's left-center. */
function elbowPath(from: LaidOutNode, to: LaidOutNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  if (Math.abs(y1 - y2) < 1) {
    return `M ${x1} ${y1} H ${x2}`;
  }
  const midX = (x1 + x2) / 2;
  const r = 10;
  const down = y2 > y1;
  const sign = down ? 1 : -1;
  return (
    `M ${x1} ${y1} H ${midX - r} ` +
    `Q ${midX} ${y1} ${midX} ${y1 + sign * r} ` +
    `V ${y2 - sign * r} ` +
    `Q ${midX} ${y2} ${midX + r} ${y2} H ${x2}`
  );
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

  // Edges under nodes; labels + cost captions at the midpoint.
  for (const edge of laidOut.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    parts.push(
      `<path d="${elbowPath(from, to)}" fill="none" stroke="${edgeStroke(edge.cost)}" ` +
        `stroke-width="1.6" marker-end="url(#arch-arrow)"/>`,
    );
    const midX = (from.x + NODE_W + to.x) / 2;
    const midY = (from.y + NODE_H / 2 + (to.y + NODE_H / 2)) / 2;
    if (edge.label !== undefined && edge.label !== "") {
      const backW = edge.label.length * 5.5 + 10;
      parts.push(
        `<rect x="${midX - backW / 2}" y="${midY - 14}" width="${backW}" height="14" ` +
          `fill="${PALETTE.surface}" opacity="0.9"/>`,
        `<text x="${midX}" y="${midY - 4}" text-anchor="middle" font-size="10" ` +
          `fill="${PALETTE.muted}">${esc(edge.label)}</text>`,
      );
    }
    if (edge.cost !== undefined) {
      parts.push(
        `<text x="${midX}" y="${midY + 10}" text-anchor="middle" font-size="8" ` +
          `font-weight="700" letter-spacing="0.5" fill="${edgeStroke(edge.cost)}">` +
          `${edge.cost.toUpperCase()}</text>`,
      );
    }
  }

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
    parts.push(
      `<g transform="translate(${node.x},${node.y})">` +
        `<rect width="${NODE_W}" height="${NODE_H}" rx="12" fill="${style.fill}" ` +
        `stroke="${style.stroke}" stroke-width="1.4"/>` +
        `<text x="${NODE_W / 2}" y="16" text-anchor="middle" font-size="9" ` +
        `font-weight="700" letter-spacing="0.8" fill="${style.badge}">` +
        `${esc(nodeBadge(node.label, node.tier).toUpperCase())}</text>` +
        label +
        `</g>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}
