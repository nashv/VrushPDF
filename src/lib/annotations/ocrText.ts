/**
 * The invisible text layer that makes a scanned page searchable.
 *
 * Each recognised word is drawn in text render mode 3 (neither filled nor
 * stroked) over the spot in the scan where it appears, so the page looks
 * exactly as before but every viewer can search, select and copy the text,
 * as with Acrobat's "Make searchable" or ocrmypdf.
 *
 * Words are placed with a full text matrix rather than a font size: the
 * matrix stretches each word to the width the scan shows and turns it to the
 * scan's direction, so selection highlights line up even on rotated pages.
 *
 * Plain Helvetica with WinAnsi encoding covers the bundled languages (English,
 * German, French, Spanish, Italian, Dutch) without embedding a font. Anything
 * it cannot encode becomes "?", which still keeps word positions intact.
 */
import {
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  StandardFonts,
  TextRenderingMode,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

/** A recognised word, already mapped into the page's PDF user space. */
export interface OcrWord {
  text: string;
  /** Left end of the word's baseline. */
  x: number;
  y: number;
  /** Unit vector along the baseline, in reading direction. */
  dirX: number;
  dirY: number;
  /** Baseline length the word covers, in points. */
  width: number;
  /** Font size to draw at: roughly the text line's height, in points. */
  size: number;
  /** True for the last word on its line: no trailing space is written. */
  lineEnd: boolean;
}

/** Letters that are really two, as Tesseract sometimes reports them. */
const LIGATURES: Record<string, string> = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
};

/** `text` reduced to what `font` can encode. */
function encodable(text: string, charset: Set<number>): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const expanded = LIGATURES[ch] ?? ch;
    for (const c of expanded) out += charset.has(c.codePointAt(0)!) ? c : "?";
  }
  return out;
}

/** Wrap the page's existing content in q/Q so its graphics state can't leak into ours. */
function isolateExistingContent(doc: PDFDocument, page: PDFPage) {
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

/**
 * Add `words` to `page` as invisible text. `font` is the document's embedded
 * Helvetica (see `embedOcrFont`), shared across pages.
 */
export function addOcrText(doc: PDFDocument, page: PDFPage, words: OcrWord[], font: PDFFont): number {
  if (words.length === 0) return 0;
  const charset = new Set(font.getCharacterSet());
  const key = page.node.newFontDictionary("VrushOCR", font.ref);

  isolateExistingContent(doc, page);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setFontAndSize(key, 1)];
  let written = 0;

  for (const word of words) {
    const text = encodable(word.text.trim(), charset);
    if (!text || word.width <= 0 || word.size <= 0) continue;
    // Width of the word at size 1; the matrix scales it to the scan's width.
    const natural = font.widthOfTextAtSize(text, 1);
    if (natural <= 0) continue;
    const sx = word.width / natural;
    // Up is the baseline direction turned a quarter-turn anticlockwise.
    const upX = -word.dirY;
    const upY = word.dirX;
    ops.push(
      setTextMatrix(word.dirX * sx, word.dirY * sx, upX * word.size, upY * word.size, word.x, word.y),
      // A trailing space lets text extraction and search see word breaks.
      showText(font.encodeText(word.lineEnd ? text : `${text} `)),
    );
    written++;
  }

  ops.push(endText(), popGraphicsState());
  // A stream of our own, after the wrapped content. `page.pushOperators` could
  // append to a stream pdf-lib already holds open inside that q…Q instead.
  page.node.addContentStream(doc.context.register(doc.context.contentStream(ops)));
  return written;
}

/** Embed the font `addOcrText` draws with. Standard 14, so nothing is embedded. */
export function embedOcrFont(doc: PDFDocument): Promise<PDFFont> {
  return doc.embedFont(StandardFonts.Helvetica);
}

/** Marks a document as OCR'd in its metadata, as ocrmypdf does. */
export function markOcrProducer(doc: PDFDocument) {
  const producer = doc.getProducer();
  const tag = "VrushPDF OCR (Tesseract)";
  if (!producer?.includes(tag)) doc.setProducer(producer ? `${producer}; ${tag}` : tag);
}
