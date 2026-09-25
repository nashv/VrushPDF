/**
 * Producing the saved PDF.
 *
 * Two paths, both ending in the same `/Annots` surgery:
 *
 * - **Fast path** — the page plan still matches the file, so the original
 *   document is loaded and patched in place. Outlines, form fields, embedded
 *   files and every object we don't touch survive exactly as they were.
 * - **Rebuild path** — pages have been rotated, reordered, deleted or merged in,
 *   so a fresh document is assembled with `copyPages` in plan order.
 *
 * The fast path is strongly preferred: `copyPages` only brings the page tree
 * across, so rebuilding loses document-level structure such as the outline.
 */
import { degrees, PDFDocument, type PDFPage } from "pdf-lib";

import { applyFieldValues, registerFields, type FieldValues } from "./fields";
import { attachAnnots, prepareWrite, stripImported, type ImageSource } from "./write";
import type { Annot, PageEntry } from "./types";

export interface SourceBytes {
  bytes: Uint8Array;
  /** Object numbers of the dictionaries we took ownership of when importing. */
  managedRefs: Set<number>;
}

export interface SaveRequest {
  pages: PageEntry[];
  annots: Annot[];
  mainDocId: string;
  getSource: (sourceDocId: string) => SourceBytes | null;
  resolveImage: (id: string) => ImageSource | null;
  /** Filled-in form values for the main document's fields, by field name. */
  fields?: FieldValues;
  /** Skip the fast path even when the plan looks unchanged. */
  forceRebuild?: boolean;
}

export interface SaveResult {
  bytes: Uint8Array;
  strategy: "patched" | "rebuilt";
  annotationsWritten: number;
  /** Annotations dropped because their stamp image was unavailable. */
  annotationsSkipped: number;
  fieldsWritten: number;
  /** Fields that could not take their value, by name. */
  fieldsFailed: string[];
}

/** True when the plan is still a 1:1, unrotated view of the main document. */
function planIsUnchanged(pages: PageEntry[], mainDocId: string, mainPageCount: number) {
  return (
    pages.length === mainPageCount &&
    pages.every((p, i) => p.sourceDocId === mainDocId && p.srcIndex === i && p.rotation === 0)
  );
}

function groupByPage(annots: Annot[]): Map<string, Annot[]> {
  const map = new Map<string, Annot[]>();
  for (const a of annots) {
    const list = map.get(a.pageId);
    if (list) list.push(a);
    else map.set(a.pageId, [a]);
  }
  return map;
}

export async function buildSavedPdf(request: SaveRequest): Promise<SaveResult> {
  const { pages, annots, mainDocId, getSource, resolveImage } = request;

  const main = getSource(mainDocId);
  if (!main) throw new Error("no document is open");

  const mainDoc = await PDFDocument.load(main.bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  const unchanged =
    !request.forceRebuild && planIsUnchanged(pages, mainDocId, mainDoc.getPageCount());

  // Each path is responsible for removing the annotations we are about to
  // re-emit, because *where* that has to happen differs: patching can match the
  // original object numbers directly, while `copyPages` renumbers everything,
  // so the rebuild path has to strip each source before copying out of it.
  const prepared = unchanged
    ? patchInPlace(mainDoc, pages, main.managedRefs)
    : await rebuild(mainDoc, mainDocId, pages, getSource);

  const ctx = await prepareWrite(prepared.doc, annots, resolveImage);
  const byPage = groupByPage(annots);

  let written = 0;
  let requested = 0;

  for (const { entry, page } of prepared.pagePairs) {
    const pageAnnots = byPage.get(entry.id) ?? [];
    requested += pageAnnots.length;
    written += attachAnnots(ctx, page, pageAnnots);
  }

  const fields = await applyFieldValues(prepared.doc, request.fields ?? {});

  // Appearances were regenerated field by field above, where one that cannot
  // be drawn in Helvetica is left to the viewer. pdf-lib's own pass would
  // throw on that field and fail the whole save.
  const bytes = await prepared.doc.save({ useObjectStreams: false, updateFieldAppearances: false });

  return {
    bytes,
    strategy: prepared.strategy,
    annotationsWritten: written,
    annotationsSkipped: requested - written,
    fieldsWritten: fields.written,
    fieldsFailed: fields.failed,
  };
}

interface Prepared {
  doc: PDFDocument;
  pagePairs: { entry: PageEntry; page: PDFPage }[];
  strategy: SaveResult["strategy"];
}

/** Fast path: patch the original document in place. */
function patchInPlace(doc: PDFDocument, pages: PageEntry[], managedRefs: Set<number>): Prepared {
  const existing = doc.getPages();
  if (managedRefs.size > 0) {
    for (const page of existing) stripImported(doc, page, managedRefs);
  }
  return {
    doc,
    pagePairs: pages.map((entry, i) => ({ entry, page: existing[i] })),
    strategy: "patched",
  };
}

/** Rebuild path: copy pages into a new document in plan order. */
async function rebuild(
  mainDoc: PDFDocument,
  mainDocId: string,
  pages: PageEntry[],
  getSource: (id: string) => SourceBytes | null,
): Promise<Prepared> {
  const out = await PDFDocument.create();
  out.setProducer("VrushPDF");

  // `copyPages` only moves the page tree, so carry over what metadata we can.
  try {
    const title = mainDoc.getTitle();
    if (title) out.setTitle(title);
    const author = mainDoc.getAuthor();
    if (author) out.setAuthor(author);
    const subject = mainDoc.getSubject();
    if (subject) out.setSubject(subject);
  } catch {
    // Damaged metadata is not worth failing a save over.
  }

  // Load each source once and note which of its pages the plan wants.
  const loaded = new Map<string, PDFDocument>([[mainDocId, mainDoc]]);
  const wanted = new Map<string, number[]>();

  for (const entry of pages) {
    if (!loaded.has(entry.sourceDocId)) {
      const source = getSource(entry.sourceDocId);
      if (!source) continue;
      loaded.set(
        entry.sourceDocId,
        await PDFDocument.load(source.bytes, { ignoreEncryption: true, updateMetadata: false }),
      );
    }
    const list = wanted.get(entry.sourceDocId);
    if (list) list.push(entry.srcIndex);
    else wanted.set(entry.sourceDocId, [entry.srcIndex]);
  }

  // Strip the annotations we own *before* copying: object numbers are still the
  // ones `managedRefs` recorded, and whatever is removed here never reaches the
  // output document.
  for (const [sourceId, source] of loaded) {
    const managedRefs = getSource(sourceId)?.managedRefs;
    if (!managedRefs || managedRefs.size === 0) continue;
    for (const page of source.getPages()) stripImported(source, page, managedRefs);
  }

  // One `copyPages` call per source so shared resources de-duplicate. A page
  // used twice is copied twice, which is what we want — each planned page is an
  // independent annotation target.
  const copies = new Map<string, Map<number, PDFPage[]>>();
  for (const [sourceId, indices] of wanted) {
    const source = loaded.get(sourceId);
    if (!source) continue;
    const copied = await out.copyPages(source, indices);
    const bucket = new Map<number, PDFPage[]>();
    indices.forEach((srcIndex, i) => {
      const list = bucket.get(srcIndex);
      if (list) list.push(copied[i]);
      else bucket.set(srcIndex, [copied[i]]);
    });
    copies.set(sourceId, bucket);
  }

  const pagePairs: Prepared["pagePairs"] = [];
  for (const entry of pages) {
    const page = copies.get(entry.sourceDocId)?.get(entry.srcIndex)?.shift();
    if (!page) continue;
    out.addPage(page);
    if (entry.rotation !== 0) {
      // Plan rotation is relative to the page's intrinsic /Rotate.
      const current = page.getRotation().angle;
      page.setRotation(degrees((((current + entry.rotation) % 360) + 360) % 360));
    }
    pagePairs.push({ entry, page });
  }

  registerFields(
    out,
    mainDoc,
    pagePairs.filter((p) => p.entry.sourceDocId === mainDocId).map((p) => p.page),
  );

  return { doc: out, pagePairs, strategy: "rebuilt" };
}
