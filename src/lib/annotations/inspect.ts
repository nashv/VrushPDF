/**
 * Cheap questions about a PDF's bytes, without opening it in the viewer.
 *
 * Used by the merge dialog to show page counts and, more usefully, to find out
 * that a file cannot be parsed *before* the merge starts rather than halfway
 * through it.
 */
import { PDFDocument } from "pdf-lib";

/** Number of pages in `bytes`. Throws if the file cannot be parsed. */
export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return doc.getPageCount();
}
