/** Factories turning a tool gesture into a model annotation. */
import type { AnnotStyle } from "$lib/state/viewer.svelte";
import {
  DEFAULT_AUTHOR,
  newId,
  normalizeRect,
  type Annot,
  type FreeTextAnnot,
  type InkAnnot,
  type NoteAnnot,
  type Point,
  type Quad,
  type Rect,
  type StampAnnot,
  type TextMarkupKind,
} from "./types";

function baseOf(pageId: string, style: AnnotStyle) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    pageId,
    color: style.color,
    opacity: style.opacity,
    contents: "",
    author: DEFAULT_AUTHOR,
    createdAt: now,
    modifiedAt: now,
  };
}

export function createTextMarkup(
  kind: TextMarkupKind,
  pageId: string,
  quads: Quad[],
  quotedText: string,
  style: AnnotStyle,
): Annot {
  return { ...baseOf(pageId, style), kind, quads, quotedText };
}

export function createInk(pageId: string, paths: Point[][], style: AnnotStyle): InkAnnot {
  return { ...baseOf(pageId, style), kind: "ink", paths, width: style.width };
}

export function createBoxShape(
  kind: "square" | "circle",
  pageId: string,
  rect: Rect,
  style: AnnotStyle,
): Annot {
  return { ...baseOf(pageId, style), kind, rect, width: style.width, fill: style.fill };
}

export function createLineShape(
  kind: "line" | "arrow",
  pageId: string,
  from: Point,
  to: Point,
  style: AnnotStyle,
): Annot {
  return { ...baseOf(pageId, style), kind, from, to, width: style.width };
}

/**
 * Rect for a FreeText placed by a single click: compact height sized to
 * the font size, anchored at the click point.
 */
export function freeTextRectAt(point: Point, fontSize = 12, width = 160): Rect {
  const height = Math.max(18, Math.round(fontSize * 1.5));
  return { x: point.x, y: point.y - height, w: width, h: height };
}

export function createFreeText(pageId: string, rect: Rect, style: AnnotStyle): FreeTextAnnot {
  return {
    ...baseOf(pageId, style),
    kind: "freetext",
    rect: {
      x: rect.x,
      y: rect.y,
      w: Math.max(rect.w, 4),
      h: Math.max(rect.h, 4),
    },
    text: "",
    fontSize: style.fontSize,
    fontFamily: style.fontFamily ?? "Helvetica",
    bold: style.bold ?? false,
    italic: style.italic ?? false,
    align: style.align ?? "left",
    bgColor: style.fill ?? null,
    borderColor: style.width > 0 ? style.color : null,
    borderWidth: style.width > 0 ? style.width : 0,
    padding: style.padding ?? 2,
  };
}

/** `point` is the top-left of the icon, matching the model. */
export function createNote(pageId: string, point: Point, style: AnnotStyle): NoteAnnot {
  return { ...baseOf(pageId, style), kind: "note", point, icon: "Comment", contents: "" };
}

export function createStamp(
  pageId: string,
  rect: Rect,
  imageId: string,
  isSignature: boolean,
  style: AnnotStyle,
): StampAnnot {
  return {
    ...baseOf(pageId, style),
    kind: "stamp",
    rect,
    imageId,
    rotation: 0,
    isSignature,
  };
}

/**
 * Rect for a stamp placed by a single click: natural aspect ratio at a
 * comfortable default width, anchored at the click point.
 */
export function stampRectAt(point: Point, aspect: number, width = 160): Rect {
  const height = aspect > 0 ? width / aspect : width / 2;
  return { x: point.x, y: point.y - height, w: width, h: height };
}

/** Rect for a dragged stamp placement, letter-boxed to the natural aspect. */
export function stampRectFromDrag(from: Point, to: Point, aspect: number): Rect {
  const dragged = normalizeRect(from, to);
  if (dragged.w < 4 || dragged.h < 4 || aspect <= 0) return dragged;
  const fitted =
    dragged.w / dragged.h > aspect
      ? { w: dragged.h * aspect, h: dragged.h }
      : { w: dragged.w, h: dragged.w / aspect };
  return {
    x: dragged.x + (dragged.w - fitted.w) / 2,
    y: dragged.y + (dragged.h - fitted.h) / 2,
    ...fitted,
  };
}

