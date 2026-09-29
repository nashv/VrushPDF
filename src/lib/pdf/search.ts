/**
 * Whole-document text search.
 *
 * Matches are located in the text-item stream from `getTextContent()` and
 * turned into PDF-space rectangles from each item's own text matrix, so results
 * can be found and highlighted on pages that have never been rendered.
 *
 * Within an item, the match is placed by character-count proportion. That is
 * approximate for proportional fonts — good enough for a search highlight, and
 * it avoids needing per-glyph metrics. Rotated text runs are skipped for
 * highlighting (the match still reports its page).
 */
import type { PDFDocumentProxy } from "./pdfjs";
import type { PageEntry, Rect } from "$lib/annotations/types";

export interface SearchMatch {
  /** Index into the page plan. */
  pageIndex: number;
  /** Rects covering the match, in PDF user space. */
  rects: Rect[];
  /** Surrounding text for the results list. */
  snippet: string;
  /** Offset of the match within `snippet`. */
  snippetOffset: number;
  snippetLength: number;
}

export interface SearchOptions {
  matchCase: boolean;
  wholeWords: boolean;
}

interface ItemSpan {
  start: number;
  end: number;
  transform: number[];
  width: number;
  height: number;
}

const SNIPPET_PAD = 42;

/** Collapse whitespace so a query never has to match a line break. */
const normalize = (s: string) => s.replace(/\s+/g, " ");

/**
 * Compute the PDF user-space bounding rect for a slice `[from, to]` of an item
 * using its 2D affine transformation matrix. Supports rotated, vertical and skewed text.
 */
function computeSpanSliceRect(
  transform: number[],
  width: number,
  height: number,
  from: number,
  to: number,
  length: number,
): Rect {
  const spanLen = length <= 0 ? 1 : length;
  const t0 = Math.max(0, Math.min(1, from / spanLen));
  const t1 = Math.max(0, Math.min(1, to / spanLen));

  const [a, b, c, d, e, f] = transform;
  const scaleX = Math.hypot(a, b) || 1;
  const scaleY = Math.hypot(c, d) || 1;

  // Unit vector along the baseline
  const ux = a / scaleX;
  const uy = b / scaleX;

  // Unit vector perpendicular to baseline
  const hasPerp = Math.abs(c) > 1e-6 || Math.abs(d) > 1e-6;
  const vx = hasPerp ? c / scaleY : -uy;
  const vy = hasPerp ? d / scaleY : ux;

  const xStart = t0 * width;
  const xEnd = t1 * width;

  // In PDF font metric conventions, descent is ~0.2 of total font height
  const effectiveHeight = height > 0 ? height : scaleY;
  const yBottom = -0.2 * effectiveHeight;
  const yTop = 0.8 * effectiveHeight;

  const p1x = e + xStart * ux + yBottom * vx;
  const p1y = f + xStart * uy + yBottom * vy;

  const p2x = e + xEnd * ux + yBottom * vx;
  const p2y = f + xEnd * uy + yBottom * vy;

  const p3x = e + xEnd * ux + yTop * vx;
  const p3y = f + xEnd * uy + yTop * vy;

  const p4x = e + xStart * ux + yTop * vx;
  const p4y = f + xStart * uy + yTop * vy;

  const minX = Math.min(p1x, p2x, p3x, p4x);
  const maxX = Math.max(p1x, p2x, p3x, p4x);
  const minY = Math.min(p1y, p2y, p3y, p4y);
  const maxY = Math.max(p1y, p2y, p3y, p4y);

  return {
    x: minX,
    y: minY,
    w: Math.max(maxX - minX, 0.5),
    h: Math.max(maxY - minY, 0.5),
  };
}

async function indexPage(doc: PDFDocumentProxy, srcIndex: number) {
  const page = await doc.getPage(srcIndex + 1);
  const content = await page.getTextContent();

  let text = "";
  const spans: ItemSpan[] = [];

  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };
    const piece = normalize(item.str);
    if (piece.length > 0) {
      spans.push({
        start: text.length,
        end: text.length + piece.length,
        transform: item.transform,
        width: item.width,
        height: item.height,
      });
      text += piece;
    }
    // An end-of-line is a word boundary, which matters for `wholeWords`.
    if (item.hasEOL && !text.endsWith(" ")) text += " ";
  }

  return { text, spans };
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rects for the slice `[start, end)` of a page's normalized text. */
function rectsForRange(spans: ItemSpan[], start: number, end: number): Rect[] {
  const out: Rect[] = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    const from = Math.max(start, span.start) - span.start;
    const to = Math.min(end, span.end) - span.start;
    const length = span.end - span.start;
    out.push(computeSpanSliceRect(span.transform, span.width, span.height, from, to, length));
  }
  return out;
}

/**
 * Search the planned pages. Yields results page by page so the UI can show
 * early hits while a long document is still being scanned; `signal` aborts.
 */
export async function* searchDocument(
  pages: PageEntry[],
  getDoc: (sourceDocId: string) => PDFDocumentProxy | null,
  query: string,
  options: SearchOptions,
  signal?: AbortSignal,
): AsyncGenerator<SearchMatch[]> {
  const needle = normalize(query).trim();
  if (needle.length === 0) return;

  const body = escapeRegExp(needle);
  const pattern = options.wholeWords ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body;
  const flags = options.matchCase ? "gu" : "giu";

  for (const [pageIndex, entry] of pages.entries()) {
    if (signal?.aborted) return;

    const proxy = getDoc(entry.sourceDocId);
    if (!proxy) continue;

    const { text, spans } = await indexPage(proxy, entry.srcIndex);
    const found: SearchMatch[] = [];
    // Fresh RegExp per page so `lastIndex` never leaks between pages.
    const re = new RegExp(pattern, flags);

    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const snippetStart = Math.max(0, start - SNIPPET_PAD);
      found.push({
        pageIndex,
        rects: rectsForRange(spans, start, end),
        snippet: text.slice(snippetStart, Math.min(text.length, end + SNIPPET_PAD)),
        snippetOffset: start - snippetStart,
        snippetLength: m[0].length,
      });
    }

    if (found.length > 0) yield found;
  }
}
