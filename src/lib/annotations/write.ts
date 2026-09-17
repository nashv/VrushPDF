/**
 * Model -> PDF annotation dictionaries, via pdf-lib.
 *
 * pdf-lib has no high-level markup-annotation API, so the dictionaries are
 * assembled directly with `context.obj` / `context.register`. Each one carries
 * a real appearance stream (see `appearance.ts`) plus the standard keys, so the
 * result is an ordinary annotation that any conforming viewer can show, edit or
 * delete.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import { buildAppearance, hexToRgb, type Appearance } from "./appearance";
import {
  annotBounds,
  isBoxShape,
  isFreeText,
  isInk,
  isLineShape,
  isNote,
  isStamp,
  isTextMarkup,
  type Annot,
  type Rect,
} from "./types";

const SUBTYPE: Record<Annot["kind"], string> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
  squiggly: "Squiggly",
  ink: "Ink",
  square: "Square",
  circle: "Circle",
  line: "Line",
  arrow: "Line",
  freetext: "FreeText",
  note: "Text",
  stamp: "Stamp",
};

/** Annotation flag bit 3: print the annotation. */
const FLAG_PRINT = 4;

export interface ImageSource {
  id: string;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

export interface WriteContext {
  doc: PDFDocument;
  font: PDFFont;
  /** Embedded image refs by image id. */
  images: Map<string, PDFRef>;
}

/**
 * Embed the shared resources (Helvetica, plus every image referenced by a stamp)
 * once per save rather than once per annotation.
 */
export async function prepareWrite(
  doc: PDFDocument,
  annots: Annot[],
  resolveImage: (id: string) => ImageSource | null,
): Promise<WriteContext> {
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const images = new Map<string, PDFRef>();

  const wanted = new Set(annots.filter(isStamp).map((a) => a.imageId));
  for (const id of wanted) {
    const source = resolveImage(id);
    if (!source) continue;
    const embedded =
      source.mime === "image/jpeg"
        ? await doc.embedJpg(source.bytes)
        : await doc.embedPng(source.bytes);
    images.set(id, embedded.ref);
  }

  return { doc, font, images };
}

/** `D:YYYYMMDDHHmmSS+HH'mm'` as required for PDF date strings. */
function pdfDate(iso: string): string {
  const d = new Date(iso);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n: number, len = 2) => String(Math.abs(Math.trunc(n))).padStart(len, "0");

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";

  return (
    `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}` +
    `${sign}${p(offsetMinutes / 60)}'${p(offsetMinutes % 60)}'`
  );
}

const rectArray = (r: Rect) => [r.x, r.y, r.x + r.w, r.y + r.h];

/** The literal shape `context.obj` accepts; pdf-lib doesn't export the type. */
type ObjLiteral = Parameters<PDFDocument["context"]["obj"]>[0];

const literal = (v: Record<string, unknown> | unknown[]) => v as ObjLiteral;

/**
 * Register the `/AP /N` form XObject for an appearance.
 *
 * Every name literal below is bare — `context.obj` turns a string into a
 * `PDFName` and prepends the `/` itself, so writing `"/ExtGState"` here would
 * serialise as `//ExtGState`.
 */
function registerAppearance(ctx: WriteContext, ap: Appearance, imageRef?: PDFRef): PDFRef {
  const resources: Record<string, unknown> = {};

  if (ap.needs.font) {
    resources.Font = ctx.doc.context.obj({ Helv: ctx.font.ref });
  }
  if (ap.needs.extGState) {
    const states: Record<string, unknown> = {};
    for (const [name, entries] of Object.entries(ap.needs.extGState)) {
      states[name] = ctx.doc.context.obj({ Type: "ExtGState", ...entries });
    }
    resources.ExtGState = ctx.doc.context.obj(literal(states));
  }
  if (ap.needs.image && imageRef) {
    resources.XObject = ctx.doc.context.obj({ [ap.needs.image]: imageRef });
  }

  const stream = ctx.doc.context.flateStream(ap.ops, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: rectArray(ap.bbox),
    Resources: ctx.doc.context.obj(literal(resources)),
  });
  return ctx.doc.context.register(stream);
}

/** Kind-specific keys. */
function geometryEntries(annot: Annot): Record<string, unknown> {
  if (isTextMarkup(annot)) {
    const quadPoints = annot.quads.flatMap((q) => [
      q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4,
    ]);
    return { QuadPoints: quadPoints };
  }

  if (isInk(annot)) {
    return {
      InkList: annot.paths.map((path) => path.flatMap((p) => [p.x, p.y])),
      BS: { W: annot.width },
    };
  }

  if (isBoxShape(annot)) {
    return {
      BS: { W: annot.width },
      ...(annot.fill ? { IC: hexToRgb(annot.fill) } : {}),
    };
  }

  if (isLineShape(annot)) {
    return {
      L: [annot.from.x, annot.from.y, annot.to.x, annot.to.y],
      BS: { W: annot.width },
      // `/LE` records which end carries the arrowhead, and is also what the
      // importer reads back to recover the line's direction.
      LE: annot.kind === "arrow" ? ["None", "OpenArrow"] : ["None", "None"],
    };
  }

  if (isFreeText(annot)) {
    const [r, g, b] = hexToRgb(annot.color);
    return {
      // `/DA` is what viewers use if they regenerate the appearance themselves.
      DA: PDFString.of(`/Helv ${annot.fontSize} Tf ${r} ${g} ${b} rg`),
      Q: annot.align === "center" ? 1 : annot.align === "right" ? 2 : 0,
    };
  }

  if (isNote(annot)) {
    return { Name: annot.icon, Open: false };
  }

  if (isStamp(annot)) {
    // A custom stamp still needs a `/Name`; the appearance stream is what
    // actually gets drawn.
    return { Name: "Draft" };
  }

  return {};
}

/**
 * Build and register one annotation dictionary, returning its ref.
 *
 * Returns `null` for annotations that cannot be represented — currently only a
 * stamp whose image failed to embed.
 */
export function writeAnnot(ctx: WriteContext, annot: Annot, page: PDFPage): PDFRef | null {
  const imageRef = isStamp(annot) ? ctx.images.get(annot.imageId) : undefined;
  if (isStamp(annot) && !imageRef) return null;

  const appearance = buildAppearance(annot, {
    measure: (text, size) => safeWidth(ctx.font, text, size),
    encode: (text) => ctx.font.encodeText(sanitize(text)).toString(),
    imageName: "Im0",
  });

  // Keep /Rect and the appearance BBox identical so the form-space mapping of
  // §12.5.5 is the identity and nothing gets scaled unexpectedly.
  const rect = appearance?.bbox ?? annotBounds(annot);

  const entries: Record<string, unknown> = {
    Type: "Annot",
    Subtype: SUBTYPE[annot.kind],
    Rect: rectArray(rect),
    F: FLAG_PRINT,
    C: hexToRgb(annot.color),
    CA: clamp01(annot.opacity),
    // UTF-16BE hex strings so non-Latin comments and author names survive.
    // A FreeText's `/Contents` *is* its displayed text, not a side comment.
    Contents: PDFHexString.fromText((isFreeText(annot) ? annot.text : annot.contents) ?? ""),
    T: PDFHexString.fromText(annot.author ?? ""),
    M: PDFString.of(pdfDate(annot.modifiedAt)),
    CreationDate: PDFString.of(pdfDate(annot.createdAt)),
    // `/NM` carries our own id, which makes a saved file re-importable with
    // stable identity instead of freshly minted ids each time.
    NM: PDFString.of(annot.id),
    P: page.ref,
    ...geometryEntries(annot),
  };

  // `literal()` widens to the array|object union, so the result needs a nudge.
  const dict = ctx.doc.context.obj(literal(entries)) as unknown as PDFDict;

  if (appearance) {
    const apRef = registerAppearance(ctx, appearance, imageRef);
    dict.set(PDFName.of("AP"), ctx.doc.context.obj({ N: apRef }));
  }

  return ctx.doc.context.register(dict);
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Helvetica's WinAnsi encoding cannot represent every character. Substituting
 * up front keeps a stray emoji from failing the whole save.
 */
export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code > 0 && code < 0x2000 ? ch : "?";
  }
  return out;
}

function safeWidth(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(sanitize(text), size);
  } catch {
    // Fall back to a rough average advance rather than aborting the save.
    return text.length * size * 0.5;
  }
}

// ------------------------------------------------------- page /Annots surgery

/** The page's `/Annots` array, creating it if absent. */
function annotsArray(doc: PDFDocument, page: PDFPage): PDFArray {
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) return existing;
  const created = doc.context.obj([]) as PDFArray;
  page.node.set(PDFName.of("Annots"), created);
  return created;
}

/**
 * Remove the annotation dictionaries we are about to re-emit.
 *
 * Only objects whose numbers are in `importedRefs` are dropped, so links, form
 * widgets, stamps and any subtype we never imported are left exactly as they
 * were found.
 */
export function stripImported(doc: PDFDocument, page: PDFPage, importedRefs: Set<number>) {
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return;

  for (let i = annots.size() - 1; i >= 0; i--) {
    const entry = annots.get(i);
    if (entry instanceof PDFRef && importedRefs.has(entry.objectNumber)) {
      annots.remove(i);
    }
  }
}

/** Append annotations to a page. */
export function attachAnnots(ctx: WriteContext, page: PDFPage, annots: Annot[]): number {
  if (annots.length === 0) return 0;
  const array = annotsArray(ctx.doc, page);
  let written = 0;
  for (const annot of annots) {
    const ref = writeAnnot(ctx, annot, page);
    if (ref) {
      array.push(ref);
      written++;
    }
  }
  return written;
}

export { PDFName, PDFArray, PDFDict, PDFRef };
