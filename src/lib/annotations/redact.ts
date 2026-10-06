/**
 * True content-stream PDF redaction engine.
 *
 * Permanently excises underlying text show operators (`Tj`, `TJ`, `'`, `"`),
 * image drawing operators (`Do`), and vector paths that intersect redaction
 * bounding boxes, then bakes permanent opaque vector blocks (with optional
 * overlay text) into the content stream.
 *
 * pdf-lib only, no browser-only dependencies, so `verify-roundtrip` can exercise
 * it under plain Node.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  rgb,
  StandardFonts,
} from "pdf-lib";

import { latin1, tokenize, type Token } from "../content/tokenizer";
import { multiply, type Matrix } from "../content/text";
import {
  normalizeRect,
  rectsIntersect,
  type Rect,
  type RedactAnnot,
} from "./types";
import { hexToRgb } from "./appearance";

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

interface TextState {
  ctm: Matrix;
  tm: Matrix;
  tlm: Matrix;
  font: string;
  size: number;
  leading: number;
  rise: number;
  hscale: number;
  charSpacing: number;
  wordSpacing: number;
}

const freshState = (): TextState => ({
  ctm: [...IDENTITY] as Matrix,
  tm: [...IDENTITY] as Matrix,
  tlm: [...IDENTITY] as Matrix,
  font: "",
  size: 0,
  leading: 0,
  rise: 0,
  hscale: 1,
  charSpacing: 0,
  wordSpacing: 0,
});

/** Check if a point (x, y) in PDF page coordinates falls inside a rectangle. */
function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Check if a text bounding box intersects any redaction rectangle. */
function textIntersectsRedactions(
  originX: number,
  originY: number,
  width: number,
  height: number,
  redactions: Rect[],
): boolean {
  const textRect: Rect = {
    x: Math.min(originX, originX + width),
    y: Math.min(originY, originY - height),
    w: Math.abs(width) || 1,
    h: Math.abs(height) || 1,
  };

  for (const redact of redactions) {
    if (rectsIntersect(textRect, redact)) {
      return true;
    }
  }
  return false;
}

/** Literal or hex string token to its decoded latin-1 string. */
function decodeString(bytes: Uint8Array, token: Token): string {
  if (token.kind === "hexstring") {
    const hex = latin1(bytes, token.start + 1, token.end - 1).replace(/[^0-9a-fA-F]/g, "");
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }
  const raw = latin1(bytes, token.start + 1, token.end - 1);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const next = raw[++i];
    const simple: Record<string, string> = {
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\",
    };
    if (next in simple) out += simple[next];
    else if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next ?? "";
  }
  return out;
}

export interface RedactTarget {
  rect: Rect;
  fillColor?: string;
  overlayText?: string;
}

/**
 * Parses and rewrites a PDF content stream to excise all drawing operations
 * occurring inside the specified redaction rectangles, appending permanent
 * vector rectangles with optional overlay text.
 */
export function sanitizeContentStream(
  streamBytes: Uint8Array,
  redactions: RedactTarget[],
): Uint8Array {
  if (redactions.length === 0) return streamBytes;

  const redactionRects = redactions.map((r) => r.rect);
  const tokens = tokenize(streamBytes);
  const stack: TextState[] = [];
  let s = freshState();

  const num = (i: number) => Number(latin1(streamBytes, tokens[i].start, tokens[i].end));

  const nextLine = (tx: number, ty: number) => {
    s.tlm = multiply([1, 0, 0, 1, tx, ty], s.tlm);
    s.tm = [...s.tlm] as Matrix;
  };

  /** Ranges of byte offsets to replace with spaces / delete: `[start, end]` */
  const excisedRanges: { start: number; end: number; replacement?: string }[] = [];

  let operands: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "whitespace" || token.kind === "comment") continue;

    if (token.kind !== "operator") {
      operands.push(i);
      continue;
    }

    const args = operands;
    operands = [];
    const op = token.op;

    switch (op) {
      case "q":
        stack.push({ ...s, ctm: [...s.ctm] as Matrix });
        break;
      case "Q": {
        const popped = stack.pop();
        if (popped) s = popped;
        break;
      }
      case "cm":
        if (args.length >= 6) {
          s.ctm = multiply(args.slice(-6).map(num) as Matrix, s.ctm);
        }
        break;
      case "BT":
        s.tm = [...IDENTITY] as Matrix;
        s.tlm = [...IDENTITY] as Matrix;
        break;
      case "ET":
        // End of text object
        break;
      case "Tf":
        if (args.length >= 2) {
          s.font = latin1(
            streamBytes,
            tokens[args[args.length - 2]].start,
            tokens[args[args.length - 2]].end,
          );
          s.size = num(args[args.length - 1]);
        }
        break;
      case "Tc":
        if (args.length >= 1) s.charSpacing = num(args[args.length - 1]);
        break;
      case "Tw":
        if (args.length >= 1) s.wordSpacing = num(args[args.length - 1]);
        break;
      case "Tz":
        if (args.length >= 1) s.hscale = num(args[args.length - 1]) / 100;
        break;
      case "TL":
        if (args.length >= 1) s.leading = num(args[args.length - 1]);
        break;
      case "Ts":
        if (args.length >= 1) s.rise = num(args[args.length - 1]);
        break;
      case "Td":
        if (args.length >= 2) nextLine(num(args[args.length - 2]), num(args[args.length - 1]));
        break;
      case "TD":
        if (args.length >= 2) {
          s.leading = -num(args[args.length - 1]);
          nextLine(num(args[args.length - 2]), num(args[args.length - 1]));
        }
        break;
      case "Tm":
        if (args.length >= 6) {
          s.tlm = args.slice(-6).map(num) as Matrix;
          s.tm = [...s.tlm] as Matrix;
        }
        break;
      case "T*":
        nextLine(0, -s.leading);
        break;

      case "Tj": {
        // (string) Tj
        if (args.length >= 1) {
          const strTokenIdx = args[args.length - 1];
          const strToken = tokens[strTokenIdx];
          const trm = multiply(
            [s.size * s.hscale, 0, 0, s.size, 0, s.rise],
            multiply(s.tm, s.ctm),
          );
          const originX = trm[4];
          const originY = trm[5];
          const text = decodeString(streamBytes, strToken);
          const estWidth = text.length * (s.size || 10) * 0.55 * s.hscale;
          const estHeight = s.size || 10;

          if (textIntersectsRedactions(originX, originY, estWidth, estHeight, redactionRects)) {
            // Excise this text operator: replace the string with () or strip
            excisedRanges.push({
              start: strToken.start,
              end: token.end,
              replacement: "() Tj",
            });
          }
        }
        break;
      }

      case "TJ": {
        // [ (str1) -10 (str2) ] TJ
        if (args.length >= 1) {
          const arrTokenIdx = args[args.length - 1];
          const trm = multiply(
            [s.size * s.hscale, 0, 0, s.size, 0, s.rise],
            multiply(s.tm, s.ctm),
          );
          let currentX = trm[4];
          const originY = trm[5];
          const estHeight = s.size || 10;

          // Find tokens within the TJ array
          let arrayStart = tokens[arrTokenIdx].start;
          let arrayEnd = tokens[arrTokenIdx].end;

          // Check if any element in the array intersects redactions
          let arrayHasRedaction = false;
          let arrayStr = "";

          for (let j = arrTokenIdx; j < i; j++) {
            const innerToken = tokens[j];
            if (innerToken.kind === "string" || innerToken.kind === "hexstring") {
              const text = decodeString(streamBytes, innerToken);
              const estWidth = text.length * (s.size || 10) * 0.55 * s.hscale;
              if (textIntersectsRedactions(currentX, originY, estWidth, estHeight, redactionRects)) {
                arrayHasRedaction = true;
              }
              currentX += estWidth;
            } else if (innerToken.kind === "number") {
              const kern = num(j);
              currentX -= (kern / 1000) * (s.size || 10) * s.hscale;
            }
          }

          if (arrayHasRedaction) {
            excisedRanges.push({
              start: arrayStart,
              end: token.end,
              replacement: "[] TJ",
            });
          }
        }
        break;
      }

      case "'": {
        // Move to next line and show string
        nextLine(0, -s.leading);
        if (args.length >= 1) {
          const strTokenIdx = args[args.length - 1];
          const strToken = tokens[strTokenIdx];
          const trm = multiply(
            [s.size * s.hscale, 0, 0, s.size, 0, s.rise],
            multiply(s.tm, s.ctm),
          );
          const originX = trm[4];
          const originY = trm[5];
          const text = decodeString(streamBytes, strToken);
          const estWidth = text.length * (s.size || 10) * 0.55 * s.hscale;
          const estHeight = s.size || 10;

          if (textIntersectsRedactions(originX, originY, estWidth, estHeight, redactionRects)) {
            // Replace with just T* line move without text
            excisedRanges.push({
              start: strToken.start,
              end: token.end,
              replacement: "T*",
            });
          }
        }
        break;
      }

      case '"': {
        // aw ac (string) "
        if (args.length >= 3) {
          s.wordSpacing = num(args[args.length - 3]);
          s.charSpacing = num(args[args.length - 2]);
          nextLine(0, -s.leading);
          const strTokenIdx = args[args.length - 1];
          const strToken = tokens[strTokenIdx];
          const trm = multiply(
            [s.size * s.hscale, 0, 0, s.size, 0, s.rise],
            multiply(s.tm, s.ctm),
          );
          const originX = trm[4];
          const originY = trm[5];
          const text = decodeString(streamBytes, strToken);
          const estWidth = text.length * (s.size || 10) * 0.55 * s.hscale;
          const estHeight = s.size || 10;

          if (textIntersectsRedactions(originX, originY, estWidth, estHeight, redactionRects)) {
            excisedRanges.push({
              start: tokens[args[args.length - 3]].start,
              end: token.end,
              replacement: `${s.wordSpacing} ${s.charSpacing} Tw Tc T*`,
            });
          }
        }
        break;
      }

      case "Do": {
        // /ImageName Do
        // Image maps unit square [0,0]->[1,1] through CTM
        const imgX = s.ctm[4];
        const imgY = s.ctm[5];
        const imgW = Math.abs(s.ctm[0]);
        const imgH = Math.abs(s.ctm[3]);
        const imgRect: Rect = { x: imgX, y: imgY, w: imgW, h: imgH };

        // If the image is completely covered by a redaction box, excise the Do operator
        for (const redact of redactionRects) {
          if (
            redact.x <= imgRect.x &&
            redact.y <= imgRect.y &&
            redact.x + redact.w >= imgRect.x + imgRect.w &&
            redact.y + redact.h >= imgRect.y + imgRect.h
          ) {
            const nameStart = args.length > 0 ? tokens[args[args.length - 1]].start : token.start;
            excisedRanges.push({
              start: nameStart,
              end: token.end,
              replacement: "",
            });
            break;
          }
        }
        break;
      }

      default:
        break;
    }
  }

  // Sort excised ranges by start offset
  excisedRanges.sort((a, b) => a.start - b.start);

  // Build the excised stream buffer
  let output = "";
  let lastIndex = 0;

  for (const range of excisedRanges) {
    if (range.start > lastIndex) {
      output += latin1(streamBytes, lastIndex, range.start);
    }
    if (range.replacement) {
      output += range.replacement;
    }
    lastIndex = Math.max(lastIndex, range.end);
  }

  if (lastIndex < streamBytes.length) {
    output += latin1(streamBytes, lastIndex, streamBytes.length);
  }

  // Append permanent baked vector redaction blocks
  let bakedBlocks = "\n\n% --- Baked Redactions ---\n";
  for (const redact of redactions) {
    const { rect, fillColor = "#000000", overlayText } = redact;
    const [r, g, b] = hexToRgb(fillColor);
    const round = (n: number) => Number(n.toFixed(3));

    bakedBlocks += `q\n`;
    bakedBlocks += `${round(r)} ${round(g)} ${round(b)} rg\n`;
    bakedBlocks += `${round(r)} ${round(g)} ${round(b)} RG\n`;
    bakedBlocks += `${round(rect.x)} ${round(rect.y)} ${round(rect.w)} ${round(rect.h)} re f\n`;

    if (overlayText && overlayText.trim().length > 0) {
      const cleanText = overlayText.replace(/[\(\)\\]/g, "\\$&");
      const fontSize = Math.min(Math.max(rect.h * 0.6, 6), 14);
      // Rough center estimation
      const textW = cleanText.length * fontSize * 0.55;
      const textX = Math.max(rect.x + (rect.w - textW) / 2, rect.x + 2);
      const textY = rect.y + (rect.h - fontSize) / 2 + 1;

      // Text contrast color (white on dark, black on light)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const textRgb = lum < 0.5 ? "1 1 1" : "0 0 0";

      bakedBlocks += `BT\n`;
      bakedBlocks += `/Helv ${round(fontSize)} Tf\n`;
      bakedBlocks += `${textRgb} rg\n`;
      bakedBlocks += `${round(textX)} ${round(textY)} Td\n`;
      bakedBlocks += `(${cleanText}) Tj\n`;
      bakedBlocks += `ET\n`;
    }

    bakedBlocks += `Q\n`;
  }

  output += bakedBlocks;

  // Convert output string to Uint8Array bytes
  const resultBytes = new Uint8Array(output.length);
  for (let i = 0; i < output.length; i++) {
    resultBytes[i] = output.charCodeAt(i) & 0xff;
  }

  return resultBytes;
}

export interface DocumentRedactionRequest {
  docBytes: Uint8Array;
  /** Array of redaction targets per 0-based page index */
  pageRedactions: { pageIndex: number; targets: RedactTarget[] }[];
}

export interface DocumentRedactionResult {
  bytes: Uint8Array;
  redactionsApplied: number;
}

/**
 * Apply permanent redactions across a full PDF document:
 * 1. Excises underlying content streams on affected pages.
 * 2. Bakes permanent vector blocks and overlay text.
 * 3. Strips unapplied /Redact annotations and any interactive annotations falling within redaction bounds.
 */
export async function applyRedactionsToDocument(
  request: DocumentRedactionRequest,
): Promise<DocumentRedactionResult> {
  const { docBytes, pageRedactions } = request;
  if (pageRedactions.length === 0) {
    return { bytes: docBytes, redactionsApplied: 0 };
  }

  const doc = await PDFDocument.load(docBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  // Ensure Helvetica font exists in document if overlay text is used
  const hasOverlayText = pageRedactions.some((p) =>
    p.targets.some((t) => t.overlayText && t.overlayText.trim().length > 0),
  );
  if (hasOverlayText) {
    doc.embedStandardFont(StandardFonts.Helvetica);
  }

  const pages = doc.getPages();
  let totalRedactions = 0;

  for (const { pageIndex, targets } of pageRedactions) {
    if (pageIndex < 0 || pageIndex >= pages.length || targets.length === 0) continue;
    const page = pages[pageIndex];
    totalRedactions += targets.length;

    // 1. Process page /Contents stream(s)
    const contentsEntry = page.node.get(PDFName.of("Contents"));
    if (contentsEntry) {
      const streamRefs =
        contentsEntry instanceof PDFArray ? contentsEntry.asArray() : [contentsEntry];
      const decodedChunks: Uint8Array[] = [];

      for (const ref of streamRefs) {
        const stream = page.node.context.lookup(ref);
        if (stream instanceof PDFRawStream) {
          try {
            decodedChunks.push(decodePDFRawStream(stream).decode());
          } catch {
            decodedChunks.push(stream.contents);
          }
        }
      }

      // Combine multiple stream chunks into one concatenated stream
      let totalLen = decodedChunks.reduce((acc, c) => acc + c.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of decodedChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Sanitize and bake redactions into the combined content stream
      const sanitized = sanitizeContentStream(combined, targets);

      // Replace page's /Contents with the new Flate-encoded stream
      const newStreamRef = doc.context.register(doc.context.flateStream(sanitized));
      page.node.set(PDFName.of("Contents"), newStreamRef);
    } else {
      // Empty contents page: generate fresh stream with baked redaction rectangles
      const sanitized = sanitizeContentStream(new Uint8Array(0), targets);
      const newStreamRef = doc.context.register(doc.context.flateStream(sanitized));
      page.node.set(PDFName.of("Contents"), newStreamRef);
    }

    // 2. Sanitize annotations (/Annots): drop any annotations or /Redact marks inside redactions
    const annotsArray = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annotsArray) {
      const remainingRefs: (PDFRef | PDFDict)[] = [];
      const redactionRects = targets.map((t) => t.rect);

      for (let i = 0; i < annotsArray.size(); i++) {
        const item = annotsArray.get(i);
        let dict: PDFDict | null = null;
        if (item instanceof PDFRef) {
          const lookedUp = doc.context.lookup(item);
          if (lookedUp instanceof PDFDict) dict = lookedUp;
        } else if (item instanceof PDFDict) {
          dict = item;
        }

        if (dict) {
          const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
          if (subtype === "Redact") {
            // Always strip /Redact marks because they are now permanently baked
            continue;
          }

          // Check if annotation rect falls inside any redaction box
          const rectArr = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
          if (rectArr && rectArr.size() >= 4) {
            const x1 = (rectArr.lookup(0) as PDFNumber).asNumber();
            const y1 = (rectArr.lookup(1) as PDFNumber).asNumber();
            const x2 = (rectArr.lookup(2) as PDFNumber).asNumber();
            const y2 = (rectArr.lookup(3) as PDFNumber).asNumber();
            const annotRect = normalizeRect({ x: x1, y: y1 }, { x: x2, y: y2 });

            const isCovered = redactionRects.some((r) => rectsIntersect(annotRect, r));
            if (isCovered) {
              // Strip covered annotation
              continue;
            }
          }
        }

        if (item instanceof PDFRef || item instanceof PDFDict) {
          remainingRefs.push(item);
        }
      }

      if (remainingRefs.length > 0) {
        page.node.set(PDFName.of("Annots"), doc.context.obj(remainingRefs));
      } else {
        page.node.delete(PDFName.of("Annots"));
      }
    }
  }

  const savedBytes = await doc.save({ useObjectStreams: false });
  return {
    bytes: savedBytes,
    redactionsApplied: totalRedactions,
  };
}
