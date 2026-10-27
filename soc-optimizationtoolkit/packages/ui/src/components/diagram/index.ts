/**
 * components/diagram - the ONE hand-SVG diagram canvas shell in this package
 * (AZR-30): pure geometry, the pan/zoom/fit viewport, the (i) affordance and
 * its popover, movable cards, and the measured-only animated edge. Screens
 * compose these and write no viewport, popover, drag or packet code of their
 * own. (React Flow, used by screens/architecture, is a separate engine and
 * out of scope here.)
 */

export {
  CARD_LINE_CHARS,
  LABEL_CHARS_PER_LINE,
  LABEL_MAX_LINES,
  MAX_ZOOM,
  MIN_LEGIBLE_ZOOM,
  MIN_ZOOM,
  clampZoom,
  edgePath,
  edgePathLR,
  fit,
  fitLine,
  wrapText,
  type Box,
  type FitLayout,
  type Point,
  type ViewTransform,
  type Viewport,
  type Wrapped,
} from "./geometry";
export {
  PAN_THRESHOLD_PX,
  WHEEL_STEP,
  ZOOM_STEP,
  useDiagramViewport,
  type DiagramPanHandlers,
  type DiagramView,
  type DiagramViewport,
  type DiagramViewportOptions,
} from "./use-diagram-viewport";
export {
  DiagramInfoPopover,
  INFO_GLYPH_R,
  INFO_HIT_R,
  InfoHitCircle,
  type DiagramInfoPopoverProps,
  type ElementAttrs,
  type InfoHitCircleClasses,
  type InfoHitCircleProps,
} from "./diagram-info";
export {
  DRAG_THRESHOLD_PX,
  useCardDrag,
  type CardDrag,
  type CardDragOptions,
  type CardPositions,
} from "./use-card-drag";
export {
  AnimatedEdge,
  MAX_ANIMATED_EDGES,
  PACKETS_PER_EDGE,
  PACKET_DURATION_S,
  type AnimatedEdgeProps,
} from "./animated-edge";
