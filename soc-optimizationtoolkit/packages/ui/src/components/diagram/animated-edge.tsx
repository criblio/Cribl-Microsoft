/**
 * AnimatedEdge - a diagram edge that moves ONLY on measured flow (AZR-30).
 *
 * Ported from the claude-kit cribl-dataflow-diagram reference
 * `FlowDiagram.tsx` (the edge group: base path, `df-pipe` overlay, packets
 * riding the exact path with <animateMotion><mpath>, MAX_ANIMATED_EDGES and
 * usePrefersReducedMotion).
 *
 * - `animated` must come from a MEASURED flow state (e.g. core's
 *   shouldAnimate on a lane read from Cribl metrics), never from
 *   configuration that could carry data. With `animated` false the edge
 *   draws its base path only: no pipe class, no packets.
 * - The moving dash is a CSS class the caller passes (`pipeClassName`), so
 *   CSS can stop it under prefers-reduced-motion. SMIL packets cannot be
 *   stopped by CSS, so reduced motion is read here in JS and drops them.
 * - Above {@link MAX_ANIMATED_EDGES} animated edges in one diagram
 *   (`animatedCount`, counted by the caller) packets are dropped: SMIL motion
 *   never idles and ~90 edges froze a tab (the reference's measurement).
 * - The path id the packets follow is scoped with useId(), so two diagrams
 *   on one page never share an id.
 * - Why CSS for the dash but SMIL for the packets: strict CSP. Animating
 *   stroke-dashoffset with SMIL <animate> needs unsafe-inline in Firefox;
 *   <animateMotion> is exempt.
 *
 * This file adds no class names: consumers pass their own.
 */

import { useEffect, useId, useState } from "react";

import type { ElementAttrs } from "./diagram-info";

export const MAX_ANIMATED_EDGES = 40;
export const PACKETS_PER_EDGE = 2;
export const PACKET_DURATION_S = 2.4;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function readReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION).matches;
}

/** prefers-reduced-motion, read in JS and kept current. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export interface AnimatedEdgeProps {
  readonly d: string;
  /** True ONLY for a measured flowing state. */
  readonly animated: boolean;
  /** How many edges in this diagram are animated (for the packet cap). */
  readonly animatedCount: number;
  readonly className: string;
  readonly pipeClassName: string;
  readonly packetClassName: string;
  readonly attrs?: ElementAttrs;
}

export function AnimatedEdge({ d, animated, animatedCount, className, pipeClassName, packetClassName, attrs }: AnimatedEdgeProps) {
  const pathId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-edge`;
  const reduced = usePrefersReducedMotion();
  const packets = animated && !reduced && animatedCount <= MAX_ANIMATED_EDGES;
  return (
    <g {...attrs}>
      <path id={pathId} d={d} className={className} />
      {animated && <path d={d} className={pipeClassName} />}
      {packets &&
        Array.from({ length: PACKETS_PER_EDGE }, (_, p) => (
          <circle key={p} r={3} className={packetClassName}>
            <animateMotion
              dur={`${PACKET_DURATION_S}s`}
              repeatCount="indefinite"
              begin={`${(p * PACKET_DURATION_S) / PACKETS_PER_EDGE}s`}
            >
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
        ))}
    </g>
  );
}
