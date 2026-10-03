/**
 * Document splitting and page extraction utilities.
 */
import { buildSavedPdf, type SourceBytes } from "./save";
import type { Annot, PageEntry } from "./types";
import type { ImageSource } from "./write";
import type { FieldValues } from "./fields";

/**
 * Parses page ranges such as "1, 3-5, 8" into 0-based unique page indices.
 * Clamps indices between 0 and totalPages - 1.
 */
export function parsePageRange(rangeStr: string, totalPages: number): number[] {
  const indices = new Set<number>();
  if (!rangeStr.trim()) return [];

  const parts = rangeStr.split(/[,;\s]+/);
  for (const part of parts) {
    if (!part) continue;
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const lo = Math.max(1, Math.min(start, end));
        const hi = Math.min(totalPages, Math.max(start, end));
        for (let i = lo; i <= hi; i++) {
          indices.add(i - 1);
        }
      }
    } else {
      const num = Number.parseInt(part, 10);
      if (Number.isFinite(num) && num >= 1 && num <= totalPages) {
        indices.add(num - 1);
      }
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

export interface SplitRequest {
  pages: PageEntry[];
  annots: Annot[];
  mainDocId: string;
  getSource: (sourceDocId: string) => SourceBytes | null;
  resolveImage: (id: string) => ImageSource | null;
  fields?: FieldValues;
}

/**
 * Builds a PDF containing only the specified page indices.
 */
export async function extractPages(
  req: SplitRequest,
  indices: number[],
): Promise<Uint8Array> {
  if (indices.length === 0) throw new Error("No pages selected for extraction");

  const targetPages = indices.map((i) => req.pages[i]).filter(Boolean);
  const targetPageIds = new Set(targetPages.map((p) => p.id));
  const targetAnnots = req.annots.filter((a) => targetPageIds.has(a.pageId));

  const result = await buildSavedPdf({
    pages: targetPages,
    annots: targetAnnots,
    mainDocId: req.mainDocId,
    getSource: req.getSource,
    resolveImage: req.resolveImage,
    fields: req.fields,
    forceRebuild: true,
  });

  return result.bytes;
}

/**
 * Splits document into multiple PDF chunks by fixed page interval (e.g. every N pages).
 */
export async function splitByInterval(
  req: SplitRequest,
  interval: number,
): Promise<{ bytes: Uint8Array; rangeLabel: string }[]> {
  if (interval <= 0) throw new Error("Interval must be at least 1");
  const total = req.pages.length;
  const chunks: { bytes: Uint8Array; rangeLabel: string }[] = [];

  for (let i = 0; i < total; i += interval) {
    const end = Math.min(i + interval, total);
    const indices: number[] = [];
    for (let j = i; j < end; j++) indices.push(j);

    const bytes = await extractPages(req, indices);
    const rangeLabel = indices.length === 1 ? `Page ${i + 1}` : `Pages ${i + 1}-${end}`;
    chunks.push({ bytes, rangeLabel });
  }

  return chunks;
}
