/**
 * Geometric hit-testing in PDF user space.
 *
 * Hit-testing is done against the model rather than the DOM so that thin ink
 * strokes and lines are grabbable along their length (a 1pt SVG path is nearly
 * impossible to click), and so the tolerance can be expressed in screen pixels
 * regardless of zoom.
 */
import {
  annotBounds,
  isBoxShape,
  isInk,
  isLineShape,
  isNote,
  isTextMarkup,
  rectFromQuad,
  type Annot,
  type Point,
  type Rect,
} from "./types";

export const containsPoint = (r: Rect, p: Point, pad = 0): boolean =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

/** Shortest distance from `p` to the segment `a`-`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToPolyline(p: Point, points: Point[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]));
    if (best === 0) break;
  }
  return best;
}

/** Whether `p` is on `annot`, with `tolerance` in PDF points. */
export function hits(annot: Annot, p: Point, tolerance: number): boolean {
  if (isTextMarkup(annot)) {
    return annot.quads.some((q) => containsPoint(rectFromQuad(q), p, tolerance));
  }
  if (isInk(annot)) {
    const reach = annot.width / 2 + tolerance;
    return annot.paths.some((path) => distanceToPolyline(p, path) <= reach);
  }
  if (isLineShape(annot)) {
    return distanceToSegment(p, annot.from, annot.to) <= annot.width / 2 + tolerance;
  }
  if (isBoxShape(annot) && annot.kind === "circle") {
    // Unfilled ellipses are only grabbable near their outline.
    const r = annot.rect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rx = Math.max(r.w / 2, 0.01);
    const ry = Math.max(r.h / 2, 0.01);
    const normalized = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2;
    if (annot.fill) return normalized <= 1.05;
    const band = (annot.width / 2 + tolerance) / Math.min(rx, ry);
    return Math.abs(Math.sqrt(normalized) - 1) <= Math.max(band, 0.06);
  }
  if (isNote(annot)) {
    return containsPoint(annotBounds(annot), p, tolerance);
  }
  // Squares, free text and stamps: their whole box is grabbable.
  return containsPoint(annotBounds(annot), p, tolerance);
}

/**
 * Topmost annotation under `p`. Later entries paint on top, so the search runs
 * in reverse.
 */
export function pick(annots: Annot[], p: Point, tolerance: number): Annot | null {
  for (let i = annots.length - 1; i >= 0; i--) {
    if (hits(annots[i], p, tolerance)) return annots[i];
  }
  return null;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Handle position in PDF space (`n` is the high-y edge). */
export function handlePoint(r: Rect, id: HandleId): Point {
  const midX = r.x + r.w / 2;
  const midY = r.y + r.h / 2;
  const top = r.y + r.h;
  const right = r.x + r.w;
  switch (id) {
    case "nw": return { x: r.x, y: top };
    case "n": return { x: midX, y: top };
    case "ne": return { x: right, y: top };
    case "e": return { x: right, y: midY };
    case "se": return { x: right, y: r.y };
    case "s": return { x: midX, y: r.y };
    case "sw": return { x: r.x, y: r.y };
    case "w": return { x: r.x, y: midY };
  }
}

/**
 * Apply a handle drag. `min` keeps a box from collapsing or inverting; the
 * dragged edges move and the opposite edges stay put.
 */
export function resizeRect(r: Rect, id: HandleId, p: Point, min = 4): Rect {
  let { x, y, w, h } = r;
  const right = x + w;
  const top = y + h;

  if (id.includes("w")) {
    const next = Math.min(p.x, right - min);
    w = right - next;
    x = next;
  }
  if (id.includes("e")) {
    w = Math.max(p.x - x, min);
  }
  if (id.includes("s")) {
    const next = Math.min(p.y, top - min);
    h = top - next;
    y = next;
  }
  if (id.includes("n")) {
    h = Math.max(p.y - y, min);
  }

  return { x, y, w, h };
}

/** Constrain a drag to a square, or to 45° steps for a line. */
export function constrainSquare(origin: Point, p: Point): Point {
  const size = Math.max(Math.abs(p.x - origin.x), Math.abs(p.y - origin.y));
  return {
    x: origin.x + Math.sign(p.x - origin.x) * size,
    y: origin.y + Math.sign(p.y - origin.y) * size,
  };
}

export function constrainAngle(origin: Point, p: Point): Point {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  const length = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

/**
 * Drop points that add no visible detail, to keep ink `/InkList` arrays and SVG
 * paths from exploding on a fast stroke.
 */
export function simplifyStroke(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const kept: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = kept[kept.length - 1];
    const next = points[i + 1];
    // Keep a point if it deviates from the line between its neighbours.
    if (distanceToSegment(points[i], last, next) > tolerance) kept.push(points[i]);
  }
  kept.push(points[points.length - 1]);
  return kept;
}
