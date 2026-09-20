/**
 * Annotation model.
 *
 * All geometry is stored in **PDF user space**: origin at the page's bottom-left
 * corner, units of 1/72". That keeps annotations independent of zoom level and
 * of page rotation, and means writing them into the file needs no conversion.
 */

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned rectangle; `y` is the *bottom* edge. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A text-markup quadrilateral. Corner order matches the PDF `/QuadPoints`
 * convention as actually implemented by viewers: upper-left, upper-right,
 * lower-left, lower-right.
 */
export interface Quad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/**
 * One page of the document as currently planned.
 *
 * Annotations reference `PageEntry.id`, never a page index, so reordering,
 * deleting and inserting pages can never silently retarget an annotation.
 */
export interface PageEntry {
  id: string;
  /** Which loaded source document the page comes from. */
  sourceDocId: string;
  /** 0-based page index within that source document. */
  srcIndex: number;
  /** Rotation the user applied, *on top of* the page's intrinsic `/Rotate`. */
  rotation: Rotation;
}

export const TEXT_MARKUP_KINDS = ["highlight", "underline", "strikeout", "squiggly"] as const;
export const SHAPE_KINDS = ["square", "circle", "line", "arrow"] as const;

export type TextMarkupKind = (typeof TEXT_MARKUP_KINDS)[number];
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type AnnotKind = TextMarkupKind | ShapeKind | "ink" | "freetext" | "note" | "stamp";

interface AnnotBase {
  id: string;
  /** Stable `PageEntry.id`, never a page index — page ops reorder freely. */
  pageId: string;
  kind: AnnotKind;
  /** `#rrggbb`. Stroke colour for shapes, fill for markup and notes. */
  color: string;
  /** 0..1, written as `/CA`. */
  opacity: number;
  /** Popup / comment text, written as `/Contents`. */
  contents: string;
  author: string;
  createdAt: string;
  modifiedAt: string;
  /**
   * PDF object number this annotation was imported from, if it came out of the
   * opened file. Used on save to drop exactly the dictionaries we re-emit,
   * leaving annotations we never understood untouched.
   */
  sourceRef?: number;
}

export interface TextMarkupAnnot extends AnnotBase {
  kind: TextMarkupKind;
  quads: Quad[];
  /** The covered text, captured at creation time for the annotation list. */
  quotedText: string;
}

export interface InkAnnot extends AnnotBase {
  kind: "ink";
  /** One entry per stroke; `/InkList` is a list of polylines. */
  paths: Point[][];
  width: number;
}

export interface BoxShapeAnnot extends AnnotBase {
  kind: "square" | "circle";
  rect: Rect;
  width: number;
  /** `#rrggbb` interior colour, or `null` for unfilled. */
  fill: string | null;
}

export interface LineShapeAnnot extends AnnotBase {
  kind: "line" | "arrow";
  from: Point;
  to: Point;
  width: number;
}

export interface FreeTextAnnot extends AnnotBase {
  kind: "freetext";
  rect: Rect;
  /**
   * The text drawn in the box.
   *
   * For a FreeText annotation the PDF spec makes `/Contents` *be* the displayed
   * text, so there is no room for a separate comment. `contents` is kept in
   * sync with this field; use `setFreeTextText` rather than assigning either
   * one directly.
   */
  text: string;
  fontSize: number;
  align: "left" | "center" | "right";
  /** Box background, or `null` for transparent. */
  bgColor: string | null;
  /** Box border, or `null` for none. */
  borderColor: string | null;
  borderWidth: number;
}

export interface NoteAnnot extends AnnotBase {
  kind: "note";
  /** Top-left of the note icon. */
  point: Point;
  icon: "Comment" | "Note" | "Help" | "Key" | "NewParagraph" | "Paragraph" | "Insert";
}

export interface StampAnnot extends AnnotBase {
  kind: "stamp";
  rect: Rect;
  /** Key into the image store; `sig:<id>` for a saved signature. */
  imageId: string;
  /** Extra rotation of the stamp content within its rect. */
  rotation: Rotation;
  /** Distinguishes a signature stamp from a generic image stamp in the UI. */
  isSignature: boolean;
}

export type Annot =
  | TextMarkupAnnot
  | InkAnnot
  | BoxShapeAnnot
  | LineShapeAnnot
  | FreeTextAnnot
  | NoteAnnot
  | StampAnnot;

/** Fixed on-page size of a sticky-note icon, in points. */
export const NOTE_SIZE = 20;

// ------------------------------------------------------------------ type guards

export const isTextMarkup = (a: Annot): a is TextMarkupAnnot =>
  (TEXT_MARKUP_KINDS as readonly string[]).includes(a.kind);

export const isBoxShape = (a: Annot): a is BoxShapeAnnot =>
  a.kind === "square" || a.kind === "circle";

export const isLineShape = (a: Annot): a is LineShapeAnnot =>
  a.kind === "line" || a.kind === "arrow";

export const isInk = (a: Annot): a is InkAnnot => a.kind === "ink";
export const isFreeText = (a: Annot): a is FreeTextAnnot => a.kind === "freetext";
export const isNote = (a: Annot): a is NoteAnnot => a.kind === "note";
export const isStamp = (a: Annot): a is StampAnnot => a.kind === "stamp";

/** Annotations positioned by a resizable rectangle. */
export const hasRect = (a: Annot): a is BoxShapeAnnot | FreeTextAnnot | StampAnnot =>
  isBoxShape(a) || isFreeText(a) || isStamp(a);

// -------------------------------------------------------------------- geometry

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function rectFromQuad(q: Quad): Rect {
  const xs = [q.x1, q.x2, q.x3, q.x4];
  const ys = [q.y1, q.y2, q.y3, q.y4];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function unionRects(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const top = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: top - y };
}

export function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/** Bounding box in PDF space, used for hit-testing, `/Rect`, and selection UI. */
export function annotBounds(a: Annot): Rect {
  if (hasRect(a)) return a.rect;
  if (isTextMarkup(a)) return unionRects(a.quads.map(rectFromQuad));
  if (isNote(a)) return { x: a.point.x, y: a.point.y - NOTE_SIZE, w: NOTE_SIZE, h: NOTE_SIZE };
  if (isLineShape(a)) {
    return padRect(normalizeRect(a.from, a.to), Math.max(a.width, 4));
  }
  // Ink: bounds of every point, grown by the stroke radius.
  const pts = a.paths.flat();
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...pts.map((p) => p.x));
  const y = Math.min(...pts.map((p) => p.y));
  const right = Math.max(...pts.map((p) => p.x));
  const top = Math.max(...pts.map((p) => p.y));
  return padRect({ x, y, w: right - x, h: top - y }, a.width / 2 + 1);
}

/** Move an annotation by a PDF-space delta, returning a new object. */
export function translateAnnot<T extends Annot>(a: T, dx: number, dy: number): T {
  const shift = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  if (hasRect(a)) return { ...a, rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy } };
  if (isNote(a)) return { ...a, point: shift(a.point) };
  if (isLineShape(a)) return { ...a, from: shift(a.from), to: shift(a.to) };
  if (isInk(a)) return { ...a, paths: a.paths.map((p) => p.map(shift)) };
  if (isTextMarkup(a)) {
    return {
      ...a,
      quads: a.quads.map((q) => ({
        x1: q.x1 + dx, y1: q.y1 + dy,
        x2: q.x2 + dx, y2: q.y2 + dy,
        x3: q.x3 + dx, y3: q.y3 + dy,
        x4: q.x4 + dx, y4: q.y4 + dy,
      })),
    };
  }
  return a;
}

/**
 * Rescale an annotation so its bounds become `target`. Only meaningful for
 * kinds the UI offers resize handles for.
 */
export function scaleAnnotToRect<T extends Annot>(a: T, target: Rect): T {
  if (hasRect(a)) return { ...a, rect: target };
  if (isLineShape(a)) {
    const src = normalizeRect(a.from, a.to);
    const sx = src.w === 0 ? 1 : target.w / src.w;
    const sy = src.h === 0 ? 1 : target.h / src.h;
    const map = (p: Point): Point => ({
      x: target.x + (p.x - src.x) * sx,
      y: target.y + (p.y - src.y) * sy,
    });
    return { ...a, from: map(a.from), to: map(a.to) };
  }
  return a;
}

/** Set a FreeText's body, keeping `contents` (i.e. `/Contents`) in step. */
export function setFreeTextText(a: FreeTextAnnot, text: string): FreeTextAnnot {
  return { ...a, text, contents: text };
}

export const DEFAULT_AUTHOR = "VrushPDF";

export function newId(): string {
  return crypto.randomUUID();
}
