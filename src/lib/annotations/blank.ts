/**
 * Generating empty pages.
 *
 * A blank page is not a special kind of `PageEntry` — it is an ordinary page of
 * an ordinary source document that happens to have been generated rather than
 * opened. That keeps rendering, thumbnails, rotation and both save paths
 * completely unaware of it: `save.ts` already copies each planned page out of
 * whatever source it names.
 */
import { PDFDocument } from "pdf-lib";

/** US Letter, used when there is no page to take a size from. */
export const DEFAULT_PAGE_SIZE = { width: 612, height: 792 };

/** A one-page PDF of the given size, in points. */
export async function blankPdfBytes(width: number, height: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return doc.save({ useObjectStreams: false });
}
