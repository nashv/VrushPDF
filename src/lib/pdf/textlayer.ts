/**
 * The selectable text layer, and turning a DOM text selection into PDF-space
 * quadrilaterals for the text-markup tools.
 */
import { pdfjs, type PDFPageProxy } from "./pdfjs";
import type { PageViewport } from "pdfjs-dist";
import type { Quad } from "$lib/annotations/types";

export interface TextLayerHandle {
  /** Reflow for a new zoom level without re-extracting the text. */
  update(viewport: PageViewport): void;
  cancel(): void;
  /** Per-text-item strings, index-aligned with `divs`. */
  readonly items: string[];
  readonly divs: HTMLElement[];
}

/**
 * Build the text layer inside `container`.
 *
 * `--total-scale-factor` is the variable pdf.js's stylesheet uses to size the
 * text runs, so it has to track the viewport scale.
 */
export async function mountTextLayer(
  page: PDFPageProxy,
  container: HTMLElement,
  viewport: PageViewport,
): Promise<TextLayerHandle> {
  container.style.setProperty("--total-scale-factor", String(viewport.scale));

  const layer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport,
  });
  await layer.render();

  return {
    update(next: PageViewport) {
      container.style.setProperty("--total-scale-factor", String(next.scale));
      layer.update({ viewport: next });
    },
    cancel: () => layer.cancel(),
    get items() {
      return layer.textContentItemsStr;
    },
    get divs() {
      return layer.textDivs;
    },
  };
}

// --------------------------------------------------------- selection -> quads

/** Rects on the same visual line, merged left-to-right. */
function mergeIntoLines(rects: DOMRect[]): DOMRect[] {
  const usable = rects.filter((r) => r.width > 0.5 && r.height > 0.5);
  if (usable.length === 0) return [];

  // Group by vertical overlap rather than exact top, since sub- and superscripts
  // and mixed font sizes on one line do not share a top edge.
  const lines: DOMRect[][] = [];
  for (const rect of [...usable].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find((group) => {
      const ref = group[0];
      const overlap = Math.min(ref.bottom, rect.bottom) - Math.max(ref.top, rect.top);
      return overlap > Math.min(ref.height, rect.height) * 0.5;
    });
    if (line) line.push(rect);
    else lines.push([rect]);
  }

  const merged: DOMRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
    let current = line[0];
    for (const rect of line.slice(1)) {
      // A gap of a couple of pixels is inter-character spacing, not a break.
      if (rect.left <= current.right + 2) {
        const left = Math.min(current.left, rect.left);
        const top = Math.min(current.top, rect.top);
        current = new DOMRect(
          left,
          top,
          Math.max(current.right, rect.right) - left,
          Math.max(current.bottom, rect.bottom) - top,
        );
      } else {
        merged.push(current);
        current = rect;
      }
    }
    merged.push(current);
  }
  return merged;
}

/**
 * Clip `range` to the portion inside `node`. Returns `null` when they don't
 * overlap. This is what makes a selection spanning several pages produce one
 * annotation per page instead of one annotation with everybody's rects.
 */
function clipToNode(range: Range, node: Node): Range | null {
  if (!range.intersectsNode(node)) return null;

  const bounds = document.createRange();
  bounds.selectNodeContents(node);

  const clipped = range.cloneRange();
  if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
    clipped.setStart(bounds.startContainer, bounds.startOffset);
  }
  if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
    clipped.setEnd(bounds.endContainer, bounds.endOffset);
  }
  bounds.detach();

  return clipped.collapsed ? null : clipped;
}

/** Screen-space rect -> PDF-space quad, keeping the spec's UL/UR/LL/LR order. */
function rectToQuad(rect: DOMRect, origin: DOMRect, viewport: PageViewport): Quad {
  const at = (x: number, y: number) => viewport.convertToPdfPoint(x - origin.left, y - origin.top);
  const [x1, y1] = at(rect.left, rect.top);
  const [x2, y2] = at(rect.right, rect.top);
  const [x3, y3] = at(rect.left, rect.bottom);
  const [x4, y4] = at(rect.right, rect.bottom);
  return { x1, y1, x2, y2, x3, y3, x4, y4 };
}

export interface PageSelection {
  quads: Quad[];
  text: string;
}

/**
 * The part of the current selection that falls inside `layerEl`, as PDF-space
 * quads. Returns `null` when nothing on this page is selected.
 */
export function selectionOnPage(
  layerEl: HTMLElement,
  viewport: PageViewport,
): PageSelection | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const origin = layerEl.getBoundingClientRect();
  const rects: DOMRect[] = [];
  let text = "";

  for (let i = 0; i < selection.rangeCount; i++) {
    const clipped = clipToNode(selection.getRangeAt(i), layerEl);
    if (!clipped) continue;
    rects.push(...Array.from(clipped.getClientRects()));
    text += clipped.toString();
  }

  if (rects.length === 0) return null;
  const quads = mergeIntoLines(rects).map((r) => rectToQuad(r, origin, viewport));
  if (quads.length === 0) return null;

  return { quads, text: text.replace(/\s+/g, " ").trim() };
}

export function clearSelection() {
  document.getSelection()?.removeAllRanges();
}
