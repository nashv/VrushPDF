/**
 * Appearance-stream (`/AP /N`) content builders.
 *
 * Every annotation we write gets a normal appearance so it renders identically
 * in Preview, Acrobat and Chrome rather than relying on each viewer to
 * synthesise one. The streams are emitted in **absolute page coordinates** with
 * `/BBox` equal to the annotation's `/Rect` and no `/Matrix`, which makes the
 * form-space mapping of PDF 32000-1 §12.5.5 the identity.
 *
 * Opacity is *not* baked in here: `/CA` on the annotation dictionary covers the
 * whole appearance, and applying it in both places would square it.
 */
import {
  isBoxShape,
  isFreeText,
  isInk,
  isLineShape,
  isStamp,
  isTextMarkup,
  rectFromQuad,
  type Annot,
  type Point,
  type Quad,
  type Rect,
  type Rotation,
} from "./types";

/** Bézier constant for approximating a quarter ellipse. */
const KAPPA = 0.5522847498;

/** Format a number for a content stream: no exponent notation, no noise digits. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 1e4) / 1e4;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(4).replace(/0+$/, "");
}

/** `#rrggbb` -> PDF components in 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const fillColor = (hex: string) => `${hexToRgb(hex).map(num).join(" ")} rg`;
const strokeColor = (hex: string) => `${hexToRgb(hex).map(num).join(" ")} RG`;

export type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** What a built appearance needs in its `/Resources`. */
export interface AppearanceNeeds {
  /** `/ExtGState` entries, keyed by resource name. */
  extGState?: Record<string, Record<string, string | number>>;
  /** True when the stream references `/Helv` in `/Font`. */
  font?: boolean;
  /** `/XObject` image resource name, when the stream draws an image. */
  image?: string;
}

export interface Appearance {
  ops: string;
  bbox: Rect;
  needs: AppearanceNeeds;
}

/** Measures a string so FreeText can be wrapped; supplied by the writer. */
export type Measure = (text: string, size: number) => number;
/** Encodes a string as a PDF hex-string literal, e.g. `<48656c6c6f>`. */
export type EncodeText = (text: string) => string;

// ------------------------------------------------------------------ primitives

function quadPath(q: Quad): string {
  // Upper-left -> upper-right -> lower-right -> lower-left.
  return [
    `${num(q.x1)} ${num(q.y1)} m`,
    `${num(q.x2)} ${num(q.y2)} l`,
    `${num(q.x4)} ${num(q.y4)} l`,
    `${num(q.x3)} ${num(q.y3)} l`,
    "h",
  ].join("\n");
}

function ellipsePath(r: Rect): string {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  const c = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
    `${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`;
  return [
    `${num(cx - rx)} ${num(cy)} m`,
    c(cx - rx, cy + oy, cx - ox, cy + ry, cx, cy + ry),
    c(cx + ox, cy + ry, cx + rx, cy + oy, cx + rx, cy),
    c(cx + rx, cy - oy, cx + ox, cy - ry, cx, cy - ry),
    c(cx - ox, cy - ry, cx - rx, cy - oy, cx - rx, cy),
    "h",
  ].join("\n");
}

function polyline(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // A single tap still deserves a visible dot.
    const p = points[0];
    return `${num(p.x)} ${num(p.y)} m ${num(p.x + 0.01)} ${num(p.y)} l`;
  }
  return points
    .map((p, i) => `${num(p.x)} ${num(p.y)} ${i === 0 ? "m" : "l"}`)
    .join("\n");
}

/** Filled triangle pointing along `from -> to`, centred on `to`. */
function arrowHead(from: Point, to: Point, width: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return "";

  const ux = dx / len;
  const uy = dy / len;
  const head = Math.max(width * 4, 6);
  const half = head * 0.45;
  const baseX = to.x - ux * head;
  const baseY = to.y - uy * head;

  return [
    `${num(to.x)} ${num(to.y)} m`,
    `${num(baseX - uy * half)} ${num(baseY + ux * half)} l`,
    `${num(baseX + uy * half)} ${num(baseY - ux * half)} l`,
    "h",
  ].join("\n");
}

/** Wrap `text` to `width`, honouring existing newlines. */
export function wrapText(text: string, width: number, size: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (word.length === 0) continue;
      const candidate = current + word;
      if (current !== "" && measure(candidate.trimEnd(), size) > width) {
        lines.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

// --------------------------------------------------------------- per-kind ops

function textMarkupAppearance(a: Annot): Appearance | null {
  if (!isTextMarkup(a)) return null;
  const rects = a.quads.map(rectFromQuad);
  if (rects.length === 0) return null;

  const bbox = {
    x: Math.min(...rects.map((r) => r.x)),
    y: Math.min(...rects.map((r) => r.y)),
    w: 0,
    h: 0,
  };
  bbox.w = Math.max(...rects.map((r) => r.x + r.w)) - bbox.x;
  bbox.h = Math.max(...rects.map((r) => r.y + r.h)) - bbox.y;

  if (a.kind === "highlight") {
    const ops = [
      "/GsMul gs",
      fillColor(a.color),
      ...a.quads.map((q) => `${quadPath(q)}\nf`),
    ].join("\n");
    // Multiply blending is what stops a highlight from hiding the text under it.
    // Names here are bare: pdf-lib's `context.obj` adds the `/` itself.
    return {
      ops,
      bbox,
      needs: { extGState: { GsMul: { BM: "Multiply" } } },
    };
  }

  const segments: string[] = [];
  for (const quad of a.quads) {
    const r = rectFromQuad(quad);
    const thickness = Math.max(r.h * 0.07, 0.6);

    if (a.kind === "squiggly") {
      const amplitude = Math.max(r.h * 0.1, 1);
      const period = Math.max(amplitude * 2, 3);
      const baseline = r.y + amplitude;
      let up = true;
      const pts: Point[] = [{ x: r.x, y: baseline }];
      for (let x = r.x + period / 2; x < r.x + r.w; x += period / 2) {
        pts.push({ x, y: baseline + (up ? amplitude : -amplitude) });
        up = !up;
      }
      segments.push(`${num(thickness)} w\n${polyline(pts)}\nS`);
    } else {
      // Underline sits just above the descender line; strikeout at mid-height.
      const y = a.kind === "underline" ? r.y + r.h * 0.08 : r.y + r.h * 0.45;
      segments.push(
        `${num(thickness)} w\n${num(r.x)} ${num(y)} m ${num(r.x + r.w)} ${num(y)} l\nS`,
      );
    }
  }

  return { ops: [strokeColor(a.color), "1 J", ...segments].join("\n"), bbox, needs: {} };
}

function inkAppearance(a: Annot): Appearance | null {
  if (!isInk(a)) return null;
  const paths = a.paths.filter((p) => p.length > 0);
  if (paths.length === 0) return null;

  const all = paths.flat();
  const pad = a.width / 2 + 1;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const bbox = {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };

  const ops = [
    strokeColor(a.color),
    `${num(a.width)} w`,
    "1 J", // round caps
    "1 j", // round joins
    ...paths.map((p) => `${polyline(p)}\nS`),
  ].join("\n");

  return { ops, bbox, needs: {} };
}

function boxShapeAppearance(a: Annot): Appearance | null {
  if (!isBoxShape(a)) return null;

  // Inset by half the stroke so the whole stroke stays inside /Rect.
  const inset = a.width / 2;
  const r: Rect = {
    x: a.rect.x + inset,
    y: a.rect.y + inset,
    w: Math.max(a.rect.w - a.width, 0.1),
    h: Math.max(a.rect.h - a.width, 0.1),
  };

  const path =
    a.kind === "square"
      ? `${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)} re`
      : ellipsePath(r);

  const paint = a.fill && a.width > 0 ? "B" : a.fill ? "f" : "S";
  const ops = [
    ...(a.fill ? [fillColor(a.fill)] : []),
    ...(a.width > 0 ? [strokeColor(a.color), `${num(a.width)} w`] : []),
    path,
    paint,
  ].join("\n");

  return { ops, bbox: a.rect, needs: {} };
}

function lineAppearance(a: Annot): Appearance | null {
  if (!isLineShape(a)) return null;

  const pad = Math.max(a.width * 3, 6);
  const bbox: Rect = {
    x: Math.min(a.from.x, a.to.x) - pad,
    y: Math.min(a.from.y, a.to.y) - pad,
    w: Math.abs(a.to.x - a.from.x) + pad * 2,
    h: Math.abs(a.to.y - a.from.y) + pad * 2,
  };

  const ops = [strokeColor(a.color), fillColor(a.color), `${num(a.width)} w`, "1 J"];

  if (a.kind === "arrow") {
    // Stop the shaft at the base of the head so the tip stays sharp.
    const dx = a.to.x - a.from.x;
    const dy = a.to.y - a.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const head = Math.max(a.width * 4, 6);
    const stopAt = Math.max(len - head * 0.9, 0);
    const end = { x: a.from.x + (dx / len) * stopAt, y: a.from.y + (dy / len) * stopAt };
    ops.push(`${num(a.from.x)} ${num(a.from.y)} m ${num(end.x)} ${num(end.y)} l`, "S");
    ops.push(`${arrowHead(a.from, a.to, a.width)}\nf`);
  } else {
    ops.push(`${num(a.from.x)} ${num(a.from.y)} m ${num(a.to.x)} ${num(a.to.y)} l`, "S");
  }

  return { ops: ops.join("\n"), bbox, needs: {} };
}

/** Horizontal padding between the FreeText box edge and its text. */
export const FREETEXT_PADDING = 2;

function freeTextAppearance(
  a: Annot,
  measure: Measure,
  encode: EncodeText,
): Appearance | null {
  if (!isFreeText(a)) return null;

  const ops: string[] = [];
  const bw = a.borderColor ? a.borderWidth : 0;

  if (a.bgColor) {
    ops.push(fillColor(a.bgColor));
    ops.push(`${num(a.rect.x)} ${num(a.rect.y)} ${num(a.rect.w)} ${num(a.rect.h)} re`, "f");
  }
  if (a.borderColor && bw > 0) {
    const i = bw / 2;
    ops.push(strokeColor(a.borderColor), `${num(bw)} w`);
    ops.push(
      `${num(a.rect.x + i)} ${num(a.rect.y + i)} ${num(a.rect.w - bw)} ${num(a.rect.h - bw)} re`,
      "S",
    );
  }

  const inner = a.rect.w - (FREETEXT_PADDING + bw) * 2;
  const lines = wrapText(a.text, Math.max(inner, 1), a.fontSize, measure);
  const leading = a.fontSize * 1.18;

  if (lines.length > 0 && a.text.length > 0) {
    ops.push("q");
    // Clip to the box so overflowing text is hidden rather than bleeding out.
    ops.push(`${num(a.rect.x)} ${num(a.rect.y)} ${num(a.rect.w)} ${num(a.rect.h)} re`, "W", "n");
    ops.push("BT", `/Helv ${num(a.fontSize)} Tf`, fillColor(a.color));

    // First baseline sits one ascent below the inner top edge. Each line gets an
    // absolute `Tm` so per-line alignment can shift x freely.
    const firstBaseline = a.rect.y + a.rect.h - (FREETEXT_PADDING + bw) - a.fontSize * 0.85;
    const left = a.rect.x + FREETEXT_PADDING + bw;

    lines.forEach((line, i) => {
      if (line.length === 0) return;
      const width = measure(line, a.fontSize);
      const x =
        a.align === "center"
          ? left + (inner - width) / 2
          : a.align === "right"
            ? left + inner - width
            : left;
      ops.push(`1 0 0 1 ${num(x)} ${num(firstBaseline - i * leading)} Tm`);
      ops.push(`${encode(line)} Tj`);
    });
    ops.push("ET", "Q");
  }

  return { ops: ops.join("\n"), bbox: a.rect, needs: { font: true } };
}

/**
 * Matrix mapping the unit square onto a stamp's rect, rotated about its centre.
 *
 * Shared with the on-screen overlay (`AnnotLayer.svelte`) so what the user drags
 * around is placed by exactly the same maths that gets written to the file.
 */
export function stampMatrix(rect: Rect, rotation: Rotation): Matrix {
  const { x, y, w, h } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // At 90/270 the content is rotated into the rect, so its pre-rotation extent
  // swaps.
  const swapped = rotation === 90 || rotation === 270;
  const sw = swapped ? h : w;
  const sh = swapped ? w : h;

  const radians = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(radians));
  const sin = Math.round(Math.sin(radians));

  // Unit square -> scale -> centre on origin -> rotate -> translate to the rect.
  let m: Matrix = [sw, 0, 0, sh, 0, 0];
  m = multiply([1, 0, 0, 1, -sw / 2, -sh / 2], m);
  m = multiply([cos, sin, -sin, cos, 0, 0], m);
  return multiply([1, 0, 0, 1, cx, cy], m);
}

function stampAppearance(a: Annot, imageName: string): Appearance | null {
  if (!isStamp(a)) return null;
  const m = stampMatrix(a.rect, a.rotation);
  const ops = ["q", `${m.map(num).join(" ")} cm`, `/${imageName} Do`, "Q"].join("\n");
  return { ops, bbox: a.rect, needs: { image: imageName } };
}

/**
 * Build the appearance for `annot`, or `null` when the kind doesn't use one
 * (sticky notes rely on the viewer's own note icon).
 */
export function buildAppearance(
  annot: Annot,
  ctx: { measure: Measure; encode: EncodeText; imageName?: string },
): Appearance | null {
  if (isTextMarkup(annot)) return textMarkupAppearance(annot);
  if (isInk(annot)) return inkAppearance(annot);
  if (isBoxShape(annot)) return boxShapeAppearance(annot);
  if (isLineShape(annot)) return lineAppearance(annot);
  if (isFreeText(annot)) return freeTextAppearance(annot, ctx.measure, ctx.encode);
  if (isStamp(annot)) return stampAppearance(annot, ctx.imageName ?? "Im0");
  return null;
}

export type { Rotation };
