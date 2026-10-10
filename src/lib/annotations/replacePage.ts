/**
 * Replace a page's content with a single full-page image: what a straightened
 * or perspective-corrected scan becomes.
 *
 * The page keeps its place, its `/Annots` and everything else in its
 * dictionary; its drawing, resources and boxes are replaced. Annotations are
 * expected to have been moved into the new geometry before saving (see
 * `transformAnnot`), since the old coordinates no longer mean anything.
 */
import { degrees, PDFName, type PDFDocument, type PDFPage } from "pdf-lib";

export interface PageImage {
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
}

/** Boxes that would crop or offset the new page if left over from the old one. */
const STALE_BOXES = ["CropBox", "BleedBox", "TrimBox", "ArtBox"];

export async function replaceWithImage(
  doc: PDFDocument,
  page: PDFPage,
  image: PageImage,
  width: number,
  height: number,
) {
  const embedded = image.mime === "image/png" ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);

  page.setMediaBox(0, 0, width, height);
  for (const box of STALE_BOXES) page.node.delete(PDFName.of(box));
  // The image is already the right way up, as the user saw the page.
  page.setRotation(degrees(0));

  // Fresh resources: the old fonts and images are no longer drawn.
  page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im0: embedded.ref } }));
  const content = doc.context.flateStream(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`);
  page.node.set(PDFName.of("Contents"), doc.context.register(content));
}
