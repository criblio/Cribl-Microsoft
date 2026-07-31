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
  applyDiagramRemovals,
  layoutDiagram,
  nodeBadge,
  polylineMidpoint,
  sourceTypeChips,
  type EdgePoint,
  type LaidOutNode,
} from "./arch-layout";
import type { DiagramEditState } from "./arch-edits";

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
  // Node-category colors (2026-07-31): mirrors the --tier-* light tokens.
  gold: "#ad8b00",
  goldBg: "#feffe6",
  violet: "#722ed1",
  violetBg: "#f9f0ff",
  magenta: "#c41d7f",
  magentaBg: "#fff0f6",
  // The Search send-path teal (mirrors --tone-search light): violet now
  // belongs to route NODES, so the tone gets its own hue.
  teal: "#08979c",
} as const;

/** Per-tier node styling (mirrors .arch-flow-node-* classes). */
const TIER_STYLE: Record<DiagramTier, { stroke: string; fill: string; badge: string }> = {
  source: { stroke: PALETTE.gold, fill: PALETTE.goldBg, badge: PALETTE.gold },
  route: { stroke: PALETTE.violet, fill: PALETTE.violetBg, badge: PALETTE.violet },
  pipeline: { stroke: PALETTE.magenta, fill: PALETTE.magentaBg, badge: PALETTE.magenta },
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
    return PALETTE.teal;
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


/** The legend strip every non-empty export carries (C4 practice: a diagram
 * that travels must carry its own key). */
const LEGEND_ITEMS: Array<{
  color: string;
  dash?: boolean;
  /** Set = a filled node-category swatch instead of an edge line sample. */
  fill?: string;
  text: string;
}> = [
  { color: PALETTE.gold, fill: PALETTE.goldBg, text: "source" },
  { color: PALETTE.violet, fill: PALETTE.violetBg, text: "route" },
  { color: PALETTE.magenta, fill: PALETTE.magentaBg, text: "pipeline / pack" },
  { color: PALETTE.ok, fill: PALETTE.okBg, text: "destination" },
  { color: PALETTE.warn, text: "premium: per-GB ingest billing" },
  { color: PALETTE.ok, text: "economical: low-cost store/egress" },
  { color: PALETTE.teal, text: "Search send path" },
  { color: PALETTE.faint, dash: true, text: "subdued: configured, not flowing" },
];

/** Legend items positioned left-to-right, wrapping at the artifact width. */
function legendLayout(
  width: number,
): Array<{ x: number; row: number; item: (typeof LEGEND_ITEMS)[number] }> {
  const placed: Array<{ x: number; row: number; item: (typeof LEGEND_ITEMS)[number] }> = [];
  let x = 12;
  let row = 0;
  for (const item of LEGEND_ITEMS) {
    const itemWidth = 25 + item.text.length * 4.6 + 18;
    if (x > 12 && x + itemWidth > width - 12) {
      x = 12;
      row++;
    }
    placed.push({ x, row, item });
    x += itemWidth;
  }
  return placed;
}

/** Wrap an annotation note's text into short lines for the sticky card. */
function wrapNoteText(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && (line + " " + word).length > 26) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
    if (lines.length === 8) {
      break;
    }
  }
  if (line !== "" && lines.length < 8) {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

const NOTE_W = 170;

/**
 * Render the unified diagram as a self-contained SVG document string.
 * When `edits` is provided (2026-07-30: what you arranged is what you
 * export), the user's canvas edits apply: removals, dragged positions,
 * bend routes, label offsets, and annotation notes.
 */
export function diagramToSvg(
  diagram: PatternDiagram,
  options?: { title?: string; edits?: DiagramEditState },
): string {
  const edits = options?.edits;
  const effective =
    edits !== undefined
      ? applyDiagramRemovals(
          diagram,
          new Set(edits.removedNodes),
          new Set(edits.removedEdges),
        )
      : diagram;
  const laidOut = layoutDiagram(effective);
  const moved = new Set<string>();
  if (edits !== undefined) {
    for (const node of laidOut.nodes) {
      const p = edits.positions[node.id];
      if (
        p !== undefined &&
        (Math.abs(p.x - node.x) > 1 || Math.abs(p.y - node.y) > 1)
      ) {
        node.x = p.x;
        node.y = p.y;
        moved.add(node.id);
      }
    }
  }
  const notes = edits?.notes ?? [];
  let contentWidth = Math.max(laidOut.width, 1);
  let contentHeight = Math.max(laidOut.height, 1);
  for (const node of laidOut.nodes) {
    contentWidth = Math.max(contentWidth, node.x + NODE_W + 12);
    contentHeight = Math.max(contentHeight, node.y + node.height + 12);
  }
  for (const note of notes) {
    contentWidth = Math.max(contentWidth, note.x + NOTE_W + 12);
    contentHeight = Math.max(
      contentHeight,
      note.y + 18 + wrapNoteText(note.text).length * 13 + 12,
    );
  }
  const empty = effective.nodes.length === 0 && notes.length === 0;
  // Title block above, legend strip below (only when there is content). The
  // legend wraps at the artifact width, so its height is layout-driven.
  const topPad = empty ? 0 : options?.title !== undefined ? 30 : 0;
  const width = Math.max(contentWidth, empty ? 1 : 560);
  const legendRows = empty
    ? 0
    : legendLayout(width)[LEGEND_ITEMS.length - 1].row + 1;
  const legendPad = empty ? 0 : 26 + (legendRows - 1) * 15;
  const height = contentHeight + topPad + legendPad;
  const nodeById = new Map(laidOut.nodes.map((n) => [n.id, n]));

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${PALETTE.surface}"/>`,
  ];
  if (!empty && options?.title !== undefined) {
    parts.push(
      `<text x="12" y="20" font-size="13" font-weight="700" ` +
        `fill="${PALETTE.text}">${esc(options.title)}</text>`,
    );
  }
  if (!empty) {
    parts.push(`<g data-layer="content" transform="translate(0,${topPad})">`);
  }
  // Stage bands and serpentine row dividers behind everything. Bands are
  // derived from the AUTOMATIC layout - once the user has moved cards, they
  // no longer describe the drawing, so they drop out.
  for (const band of moved.size > 0 ? [] : (laidOut.bands ?? [])) {
    parts.push(
      `<rect x="${round(band.left)}" y="2" width="${round(band.right - band.left)}" ` +
        `height="${contentHeight - 4}" rx="12" fill="${PALETTE.accentBg}" ` +
        `opacity="0.35" stroke="${PALETTE.border}" stroke-opacity="0.5"/>`,
      `<text x="${round((band.left + band.right) / 2)}" y="14" text-anchor="middle" ` +
        `font-size="9" font-weight="700" letter-spacing="1.2" ` +
        `fill="${PALETTE.faint}">${esc(band.label.toUpperCase())}</text>`,
    );
  }
  for (const dividerY of laidOut.rowDividers ?? []) {
    parts.push(
      `<line x1="0" y1="${round(dividerY)}" x2="${contentWidth}" y2="${round(dividerY)}" ` +
        `stroke="${PALETTE.border}" stroke-dasharray="5 5" stroke-opacity="0.7"/>`,
    );
  }

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
    // User edits take precedence (2026-07-30): a bent line exports its bend
    // route, an edge whose endpoint was dragged re-routes simply between
    // the live positions, and untouched edges keep dagre's routing with the
    // reserved label anchor.
    const edgeEdit = edits?.edges[`${edge.from}>${edge.to}`];
    const sourcePt = { x: from.x + NODE_W, y: from.y + from.height / 2 };
    const targetPt = { x: to.x, y: to.y + to.height / 2 };
    let points: EdgePoint[];
    let anchor: EdgePoint;
    if (edgeEdit !== undefined && edgeEdit.bends.length > 0) {
      // Bends are the INTERIOR CORNERS of the user's polyline - the export
      // draws exactly what the canvas drew.
      points = [sourcePt, ...edgeEdit.bends, targetPt];
      anchor = polylineMidpoint(points);
    } else if (moved.has(edge.from) || moved.has(edge.to)) {
      const jogX = (sourcePt.x + targetPt.x) / 2;
      points = [
        sourcePt,
        { x: jogX, y: sourcePt.y },
        { x: jogX, y: targetPt.y },
        targetPt,
      ];
      anchor = polylineMidpoint(points);
    } else {
      points = edgePoints(edge.points, from, to);
      anchor = edge.labelPoint ?? polylineMidpoint(points);
    }
    parts.push(
      `<path d="${routedPath(points)}" fill="none" ` +
        `stroke="${lineStroke(edge.tone, edge.cost)}" ` +
        `stroke-width="1.6"` +
        `${edge.muted === true ? ' stroke-opacity="0.3"' : ""}/>`,
    );
    const midX = round(anchor.x + (edgeEdit?.labelOffset?.dx ?? 0));
    const midY = round(anchor.y + (edgeEdit?.labelOffset?.dy ?? 0));
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
      `<g data-node transform="translate(${node.x},${node.y})"` +
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

  // Annotation notes render as sticky cards above everything.
  for (const note of notes) {
    const lines = wrapNoteText(note.text);
    const noteH = 14 + lines.length * 13;
    parts.push(
      `<g data-note transform="translate(${round(note.x)},${round(note.y)})">` +
        `<rect width="${NOTE_W}" height="${noteH}" rx="8" fill="${PALETTE.warnBg}" ` +
        `stroke="${PALETTE.warn}" stroke-opacity="0.45"/>` +
        `<text x="10" y="16" font-size="10.5" fill="${PALETTE.text}">` +
        lines
          .map((line, i) =>
            i === 0 ? esc(line) : `<tspan x="10" dy="13">${esc(line)}</tspan>`,
          )
          .join("") +
        `</text></g>`,
    );
  }
  if (!empty) {
    parts.push("</g>");
  }
  // The embedded legend strip: every export carries its own key.
  if (!empty) {
    const legendBase = topPad + contentHeight + 16;
    for (const { x, row, item } of legendLayout(width)) {
      const legendY = legendBase + row * 15;
      if (item.fill !== undefined) {
        // Node-category swatch: a bordered card chip, not an edge sample.
        parts.push(
          `<rect x="${x}" y="${legendY - 9}" width="16" height="11" rx="3" ` +
            `fill="${item.fill}" stroke="${item.color}" stroke-width="1.5"/>`,
        );
      } else {
        parts.push(
          `<line x1="${x}" y1="${legendY - 3}" x2="${x + 20}" y2="${legendY - 3}" ` +
            `stroke="${item.color}" stroke-width="2.2"` +
            `${item.dash === true ? ' stroke-dasharray="4 3" stroke-opacity="0.6"' : ""}/>`,
        );
      }
      parts.push(
        `<text x="${x + 25}" y="${legendY}" font-size="9" ` +
          `fill="${PALETTE.muted}">${esc(item.text)}</text>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}
