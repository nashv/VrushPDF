/**
 * True redaction: remove what lies under each redaction box from the page's
 * content, not just cover it, then draw an opaque box (with optional label)
 * in its place.
 *
 * What is removed, and how precisely:
 *
 * - **Text**, glyph by glyph. The full text state is tracked (font, size,
 *   spacing, scaling, rise, text and graphics matrices, and the advance after
 *   every glyph), widths come from the font itself, and a glyph goes when its
 *   centre is under a redaction (see `glyphHit`). The glyphs around it stay exactly
 *   where they were: removed ones are replaced by an equal `TJ` displacement.
 *   For fonts whose widths can't be read reliably the whole run is removed
 *   instead, which can take too much but never leaves covered text behind.
 * - **Images**: removed when fully covered. When partly covered, the covered
 *   pixels are overwritten with the box colour. Raw and Flate images are
 *   edited here; JPEGs through `editImage`, which the app supplies from the
 *   browser. An image that can't be edited is removed entirely and counted
 *   in the result, never kept.
 * - **Form XObjects** are redacted recursively, into a per-page copy.
 * - **Inline images** touching a box are removed; **vector paths** lying wholly
 *   under a box are removed.
 * - **Annotations** touching a box are removed, and form fields lose their
 *   values.
 *
 * pdf-lib only, no browser-only dependencies, so `verify-roundtrip` can exercise
 * it under plain Node.
 */
import { Encodings, Font } from "@pdf-lib/standard-fonts";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";

import { latin1, tokenize, type Token } from "../content/tokenizer";
import { multiply, type Matrix } from "../content/text";
import { hexToRgb } from "./appearance";
import { normalizeRect, rectsIntersect, type Rect } from "./types";

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface RedactTarget {
  rect: Rect;
  fillColor?: string;
  overlayText?: string;
}

/** A partly covered image the engine can't decode itself (e.g. a JPEG). */
export interface ImageEditJob {
  /** The image stream's raw bytes, still encoded. */
  bytes: Uint8Array;
  /** Its `/Filter`, e.g. `DCTDecode`. */
  filter: string;
  width: number;
  height: number;
  /** Pixel rectangles to overwrite, origin top-left. */
  regions: { x: number; y: number; w: number; h: number }[];
  /** Box colour, 0..1 RGB. */
  fill: [number, number, number];
}

/** Returns the edited image re-encoded in the same format, or null if it can't. */
export type ImageEditor = (job: ImageEditJob) => Promise<Uint8Array | null>;

// ------------------------------------------------------------------ geometry

const round = (n: number) => Number(n.toFixed(4));

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Bounding box of a rectangle (in some space) mapped through `m`. */
function mapRect(m: Matrix, x0: number, y0: number, x1: number, y1: number): Rect {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  };
}

const contains = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

/**
 * Whether a glyph counts as under a redaction: what you see is what goes.
 * Across the line, the glyph's centre must be under the box, so a slightly
 * sloppy box doesn't take the first letter of the next word while one laid
 * over a single letter does take it. Up and down, the box must cover at
 * least 15% of the glyph's height, so a thin stripe across the middle of a
 * line takes the line, while a box nudging into the next line's descenders
 * leaves that line alone.
 */
function glyphHit(glyph: Rect, redactions: Rect[]): boolean {
  const cx = glyph.x + glyph.w / 2;
  for (const r of redactions) {
    if (cx < r.x || cx > r.x + r.w) continue;
    const o = overlap(glyph, r);
    if (o.h > 0 && o.h >= glyph.h * 0.15) return true;
  }
  return false;
}

// ---------------------------------------------------------------- fonts

/** What redaction needs to know about a font. */
interface FontMetrics {
  /** Bytes per character code. */
  codeBytes: 1 | 2;
  /** Advance width per unit font size (glyph space / 1000). */
  width(code: number): number;
  /** Glyph extent above and below the baseline, per unit font size. */
  ascent: number;
  descent: number;
  /** False when widths are guesses: then a touched run is removed whole. */
  reliable: boolean;
}

const BASE14_ALIASES: Record<string, string> = {
  Arial: "Helvetica",
  ArialMT: "Helvetica",
  "Arial,Bold": "Helvetica-Bold",
  "Arial-BoldMT": "Helvetica-Bold",
  "Arial,Italic": "Helvetica-Oblique",
  "Arial-ItalicMT": "Helvetica-Oblique",
  "Arial,BoldItalic": "Helvetica-BoldOblique",
  "Arial-BoldItalicMT": "Helvetica-BoldOblique",
  TimesNewRoman: "Times-Roman",
  TimesNewRomanPSMT: "Times-Roman",
  "TimesNewRoman,Bold": "Times-Bold",
  "TimesNewRomanPS-BoldMT": "Times-Bold",
  "TimesNewRoman,Italic": "Times-Italic",
  "TimesNewRomanPS-ItalicMT": "Times-Italic",
  CourierNew: "Courier",
  CourierNewPSMT: "Courier",
  "CourierNew,Bold": "Courier-Bold",
};
const BASE14 = new Set([
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats",
]);

/** Glyph names by code under WinAnsiEncoding, from pdf-lib's tables. */
let winAnsiNames: Map<number, string> | null = null;
function winAnsi(): Map<number, string> {
  if (winAnsiNames) return winAnsiNames;
  winAnsiNames = new Map();
  for (const cp of Encodings.WinAnsi.supportedCodePoints) {
    const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
    winAnsiNames.set(code, name);
  }
  return winAnsiNames;
}

const asNumber = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

/**
 * `dict[key]` if it is a `type`, else undefined. pdf-lib's `lookupMaybe`
 * throws on a type mismatch instead, and real files are full of those (an
 * `/Encoding` that is a name, not a dictionary); redaction must not fail on them.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function typed<T>(dict: PDFDict | undefined, key: string, type: Function & { prototype: T }): T | undefined {
  const value = dict?.lookup(PDFName.of(key));
  return value instanceof type ? (value as T) : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function typedAt<T>(array: PDFArray | undefined, index: number, type: Function & { prototype: T }): T | undefined {
  const value = array && index < array.size() ? array.lookup(index) : undefined;
  return value instanceof type ? (value as T) : undefined;
}

/** Metrics for the font a `Tf` named, given the resources it resolves in. */
function loadFontMetrics(context: PDFContext, fontDict: PDFDict | undefined): FontMetrics {
  const guess: FontMetrics = { codeBytes: 1, width: () => 1, ascent: 1, descent: -0.3, reliable: false };
  if (!fontDict) return guess;
  const subtype = typed(fontDict, "Subtype", PDFName)?.decodeText();

  const descriptorOf = (dict: PDFDict | undefined) => typed(dict, "FontDescriptor", PDFDict);
  const verticalFrom = (descriptor: PDFDict | undefined, fallback = { ascent: 0.9, descent: -0.25 }) => {
    const ascent = asNumber(descriptor?.lookup(PDFName.of("Ascent")));
    const descent = asNumber(descriptor?.lookup(PDFName.of("Descent")));
    // Some files carry zero or nonsense here; keep a sane band either way.
    return {
      ascent: ascent && ascent > 300 ? Math.min(ascent / 1000, 1.2) : fallback.ascent,
      descent: descent && descent < 0 ? Math.max(descent / 1000, -0.5) : fallback.descent,
    };
  };

  if (subtype === "Type0") {
    const encoding = typed(fontDict, "Encoding", PDFName)?.decodeText();
    const descendant = typedAt(typed(fontDict, "DescendantFonts", PDFArray), 0, PDFDict);
    if (encoding !== "Identity-H" || !descendant) return { ...guess, codeBytes: 2 };
    const dw = asNumber(descendant.lookup(PDFName.of("DW"))) ?? 1000;
    const widths = new Map<number, number>();
    const w = typed(descendant, "W", PDFArray);
    if (w) {
      for (let i = 0; i < w.size(); ) {
        const first = asNumber(w.lookup(i));
        const next = w.lookup(i + 1);
        if (first === undefined) break;
        if (next instanceof PDFArray) {
          for (let k = 0; k < next.size(); k++) widths.set(first + k, asNumber(next.lookup(k)) ?? dw);
          i += 2;
        } else {
          const last = asNumber(next) ?? first;
          const width = asNumber(w.lookup(i + 2)) ?? dw;
          for (let c = first; c <= last; c++) widths.set(c, width);
          i += 3;
        }
      }
    }
    return { codeBytes: 2, width: (code) => (widths.get(code) ?? dw) / 1000, ...verticalFrom(descriptorOf(descendant)), reliable: true };
  }

  if (subtype === "Type3") {
    const matrix = typed(fontDict, "FontMatrix", PDFArray);
    const scale = asNumber(matrix?.lookup(0)) ?? 0.001;
    const yScale = asNumber(matrix?.lookup(3)) ?? 0.001;
    const first = asNumber(fontDict.lookup(PDFName.of("FirstChar"))) ?? 0;
    const widths = typed(fontDict, "Widths", PDFArray);
    const bbox = typed(fontDict, "FontBBox", PDFArray);
    const low = (asNumber(bbox?.lookup(1)) ?? -200) * yScale;
    const high = (asNumber(bbox?.lookup(3)) ?? 800) * yScale;
    return {
      codeBytes: 1,
      width: (code) => (asNumber(widths?.lookup(code - first)) ?? 0) * scale,
      ascent: Math.max(high, 0.5),
      descent: Math.min(low, -0.1),
      reliable: !!widths,
    };
  }

  // Simple fonts: Type1, MMType1, TrueType.
  const descriptor = descriptorOf(fontDict);
  const first = asNumber(fontDict.lookup(PDFName.of("FirstChar"))) ?? 0;
  const widths = typed(fontDict, "Widths", PDFArray);
  const missing = asNumber(descriptor?.lookup(PDFName.of("MissingWidth")));
  if (widths) {
    const count = widths.size();
    return {
      codeBytes: 1,
      width: (code) => {
        const i = code - first;
        return ((i >= 0 && i < count ? asNumber(widths.lookup(i)) : undefined) ?? missing ?? 0) / 1000;
      },
      ...verticalFrom(descriptor),
      reliable: true,
    };
  }

  // No /Widths: only the standard 14 fonts are allowed to omit them.
  const raw = typed(fontDict, "BaseFont", PDFName)?.decodeText() ?? "";
  const stripped = raw.replace(/^[A-Z]{6}\+/, "");
  const base = BASE14_ALIASES[stripped] ?? stripped;
  if (!BASE14.has(base)) return guess;
  const font = Font.load(base as never);
  const names = new Map(winAnsi());
  const differences = typed(typed(fontDict, "Encoding", PDFDict), "Differences", PDFArray);
  if (differences) {
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const item = differences.lookup(i);
      if (item instanceof PDFNumber) code = item.asNumber();
      else if (item instanceof PDFName) names.set(code++, item.decodeText());
    }
  }
  return {
    codeBytes: 1,
    width: (code) => {
      const name = names.get(code);
      return ((name ? font.getWidthOfGlyph(name) : undefined) ?? missing ?? 0) / 1000;
    },
    ascent: Math.max((font.Ascender ?? 718) / 1000, 0.7),
    descent: Math.min((font.Descender ?? -207) / 1000, -0.15),
    reliable: true,
  };
}

// ------------------------------------------------------------- resources

/**
 * A copy-on-write view of a resource dictionary: lookups read the original,
 * additions go into a private copy, so redacting one page never alters
 * another page or form that shares the same resources.
 */
class Resources {
  #copy: PDFDict | null = null;
  #counter = 0;
  #fonts = new Map<string, FontMetrics>();

  constructor(
    readonly context: PDFContext,
    readonly original: PDFDict | undefined,
  ) {}

  lookup(category: string, name: string): PDFObject | undefined {
    const dict = typed(this.#copy ?? this.original, category, PDFDict);
    return dict?.get(PDFName.of(name));
  }

  font(name: string): FontMetrics {
    let metrics = this.#fonts.get(name);
    if (!metrics) {
      const ref = this.lookup("Font", name);
      const resolved = ref ? this.context.lookup(ref) : undefined;
      const dict = resolved instanceof PDFDict ? resolved : undefined;
      metrics = loadFontMetrics(this.context, dict);
      this.#fonts.set(name, metrics);
    }
    return metrics;
  }

  /** Add an entry under a fresh name; returns the name, without the slash. */
  add(category: string, ref: PDFObject, prefix: string): string {
    if (!this.#copy) {
      this.#copy = this.original ? this.original.clone(this.context) : this.context.obj({});
    }
    const existing = typed(this.#copy, category, PDFDict);
    const dict = existing ? existing.clone(this.context) : this.context.obj({});
    this.#copy.set(PDFName.of(category), dict);
    let name: string;
    do name = `${prefix}${++this.#counter}`;
    while (dict.has(PDFName.of(name)));
    dict.set(PDFName.of(name), ref);
    return name;
  }

  /** The dictionary to write back, or null when nothing was added. */
  get changed(): PDFDict | null {
    return this.#copy;
  }
}

// ------------------------------------------------------------------ images

const COMPONENTS: Record<string, number> = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4, CalGray: 1, CalRGB: 3, Lab: 3 };

/** Components per pixel and how to paint the box colour, for a colour space. */
function colourSpaceOf(context: PDFContext, space: PDFObject | undefined, fill: [number, number, number]) {
  const resolved = space instanceof PDFRef ? context.lookup(space) : space;
  if (resolved instanceof PDFName) {
    const n = COMPONENTS[resolved.decodeText()];
    return n ? { components: n, value: fillValue(n, fill) } : null;
  }
  if (resolved instanceof PDFArray) {
    const family = typedAt(resolved, 0, PDFName)?.decodeText();
    if (family === "ICCBased") {
      const stream = resolved.lookup(1);
      const n = stream instanceof PDFStream ? asNumber(stream.dict.lookup(PDFName.of("N"))) : undefined;
      return n && [1, 3, 4].includes(n) ? { components: n, value: fillValue(n, fill) } : null;
    }
    if (family === "Indexed") {
      // Pick the palette entry closest to the box colour.
      const base = colourSpaceOf(context, resolved.lookup(1), fill);
      const hival = asNumber(resolved.lookup(2)) ?? 0;
      const lookupObj = resolved.lookup(3);
      let palette: Uint8Array | null = null;
      if (lookupObj instanceof PDFString) palette = lookupObj.asBytes();
      else if (lookupObj instanceof PDFRawStream) palette = decodePDFRawStream(lookupObj).decode();
      else if (lookupObj && "asBytes" in lookupObj) palette = (lookupObj as unknown as { asBytes(): Uint8Array }).asBytes();
      if (!base || !palette) return null;
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i <= hival; i++) {
        const entry = palette.subarray(i * base.components, (i + 1) * base.components);
        const distance = entry.reduce((sum, v, k) => sum + (v - base.value[k]) ** 2, 0);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
      return { components: 1, value: [best] };
    }
  }
  return null;
}

function fillValue(components: number, [r, g, b]: [number, number, number]): number[] {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  if (components === 1) return [to(0.299 * r + 0.587 * g + 0.114 * b)];
  if (components === 3) return [to(r), to(g), to(b)];
  const k = 1 - Math.max(r, g, b);
  const c = k < 1 ? (1 - r - k) / (1 - k) : 0;
  const m = k < 1 ? (1 - g - k) / (1 - k) : 0;
  const y = k < 1 ? (1 - b - k) / (1 - k) : 0;
  return [to(c), to(m), to(y), to(k)];
}

const PURE_FILTERS = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode", "Fl", "LZW", "A85", "AHx", "RL"]);

function filtersOf(dict: PDFDict): string[] {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) return filter.asArray().map((f) => (f instanceof PDFName ? f.decodeText() : "?"));
  return [];
}

/**
 * A copy of `image` with `regions` (pixels, origin top-left) overwritten, or
 * null when it can't be done safely.
 */
async function blankImage(
  context: PDFContext,
  image: PDFRawStream,
  regions: { x: number; y: number; w: number; h: number }[],
  fill: [number, number, number],
  editImage: ImageEditor | undefined,
  /** For soft masks: the value to paint (opaque), ignoring colour. */
  maskValue?: number,
): Promise<PDFRef | null> {
  const dict = image.dict;
  const width = asNumber(dict.lookup(PDFName.of("Width"))) ?? 0;
  const height = asNumber(dict.lookup(PDFName.of("Height"))) ?? 0;
  const bpc = asNumber(dict.lookup(PDFName.of("BitsPerComponent"))) ?? 8;
  const filters = filtersOf(dict);
  const parms = dict.lookup(PDFName.of("DecodeParms"));
  const predictor = parms instanceof PDFDict ? asNumber(parms.lookup(PDFName.of("Predictor"))) ?? 1 : 1;
  if (!width || !height) return null;

  const newDict = dict.clone(context);
  let data: Uint8Array;

  if (filters.every((f) => PURE_FILTERS.has(f)) && predictor <= 1 && bpc === 8 && !(parms instanceof PDFArray)) {
    const isMask = maskValue !== undefined;
    const space = isMask ? { components: 1, value: [maskValue] } : colourSpaceOf(context, dict.lookup(PDFName.of("ColorSpace")), fill);
    if (!space || dict.lookup(PDFName.of("ImageMask"))) return null;
    data = decodePDFRawStream(image).decode().slice();
    if (data.length < width * height * space.components) return null;
    for (const r of regions) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const at = (y * width + x) * space.components;
          for (let k = 0; k < space.components; k++) data[at + k] = space.value[k];
        }
      }
    }
    newDict.delete(PDFName.of("DecodeParms"));
    newDict.delete(PDFName.of("Filter"));
    const stream = context.flateStream(data, Object.fromEntries(newDict.entries().map(([k, v]) => [k.decodeText(), v])));
    return context.register(stream);
  }

  if (editImage && filters.length === 1 && filters[0] === "DCTDecode" && maskValue === undefined) {
    const edited = await editImage({ bytes: image.contents, filter: "DCTDecode", width, height, regions, fill });
    if (!edited) return null;
    // The editor re-encodes as RGB whatever came in (gray, CMYK, ICC).
    newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    newDict.delete(PDFName.of("Decode"));
    newDict.delete(PDFName.of("DecodeParms"));
    newDict.set(PDFName.of("Length"), PDFNumber.of(edited.length));
    return context.register(PDFRawStream.of(newDict, edited));
  }
  return null;
}

// ----------------------------------------------------------- content streams

interface GState {
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

const freshState = (ctm: Matrix): GState => ({
  ctm: [...ctm] as Matrix,
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

/** Literal or hex string token to its raw bytes. */
function stringBytes(bytes: Uint8Array, token: Token): Uint8Array {
  if (token.kind === "hexstring") {
    let hex = latin1(bytes, token.start + 1, token.end - 1).replace(/[^0-9a-fA-F]/g, "");
    if (hex.length % 2) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const raw = latin1(bytes, token.start + 1, token.end - 1);
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out.push(raw.charCodeAt(i));
      continue;
    }
    const next = raw[++i];
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (next in simple) out.push(simple[next]);
    else if (next === "\r" || next === "\n") {
      if (next === "\r" && raw[i + 1] === "\n") i++; // line continuation
    } else if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (next !== undefined) out.push(next.charCodeAt(0));
  }
  return Uint8Array.from(out);
}

const hex = (bytes: number[]) => `<${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}>`;

/** Counts of what a pass removed or changed. */
export interface RedactionStats {
  glyphsRemoved: number;
  runsRemovedWhole: number;
  imagesEdited: number;
  imagesRemoved: number;
  pathsRemoved: number;
  formsRedacted: number;
}

const emptyStats = (): RedactionStats => ({
  glyphsRemoved: 0,
  runsRemovedWhole: 0,
  imagesEdited: 0,
  imagesRemoved: 0,
  pathsRemoved: 0,
  formsRedacted: 0,
});

interface PassOptions {
  resources: Resources;
  /** Box colour for blanking image pixels, 0..1 RGB. */
  fill: [number, number, number];
  editImage?: ImageEditor;
  stats: RedactionStats;
  depth: number;
}

/**
 * Rewrite a content stream with everything under `redactions` (in the
 * stream's own space) removed. Returns the new bytes; resources added
 * along the way go into `options.resources`.
 */
async function redactStream(bytes: Uint8Array, redactions: Rect[], options: PassOptions): Promise<Uint8Array> {
  const { resources, stats } = options;
  const tokens = tokenize(bytes);
  const edits: { start: number; end: number; text: string }[] = [];
  const stack: GState[] = [];
  let s = freshState(IDENTITY);
  let operands: number[] = [];

  // Path being built: its token span, page-space bounds, and whether it clips.
  let pathStart = -1;
  let pathBox: Rect | null = null;
  let pathClips = false;
  const growPath = (points: number[]) => {
    for (let k = 0; k + 1 < points.length; k += 2) {
      const [x, y] = apply(s.ctm, points[k], points[k + 1]);
      if (!pathBox) pathBox = { x, y, w: 0, h: 0 };
      else {
        const right = Math.max(pathBox.x + pathBox.w, x);
        const top = Math.max(pathBox.y + pathBox.h, y);
        pathBox.x = Math.min(pathBox.x, x);
        pathBox.y = Math.min(pathBox.y, y);
        pathBox.w = right - pathBox.x;
        pathBox.h = top - pathBox.y;
      }
    }
  };

  const num = (i: number) => Number(latin1(bytes, tokens[i].start, tokens[i].end));
  const nums = (args: number[]) => args.filter((i) => tokens[i].kind === "number").map(num);
  const nextLine = (tx: number, ty: number) => {
    s.tlm = multiply([1, 0, 0, 1, tx, ty], s.tlm);
    s.tm = [...s.tlm] as Matrix;
  };

  /**
   * Measure and, if needed, rewrite one text-showing operation. `items` are
   * the strings and TJ adjustments in order. Returns the replacement for the
   * strings part (a `[...] TJ`), or null to leave the original untouched.
   */
  const show = (items: ({ bytes: Uint8Array } | { adjust: number })[]): string | null => {
    const font = resources.font(s.font);
    const fs = s.size;
    const th = s.hscale;
    const textToPage = multiply(s.tm, s.ctm);
    const lo = s.rise + font.descent * fs;
    const hi = s.rise + font.ascent * fs;
    let x = 0;
    let touched = false;
    // Kept output: strings of codes and numeric displacements, in order.
    const out: (number[] | number)[] = [];
    let removedHere = 0;

    const pushCodes = (codes: number[]) => {
      const last = out[out.length - 1];
      if (Array.isArray(last)) last.push(...codes);
      else out.push([...codes]);
    };
    const pushAdjust = (n: number) => {
      const last = out[out.length - 1];
      if (typeof last === "number") out[out.length - 1] = last + n;
      else out.push(n);
    };

    for (const item of items) {
      if ("adjust" in item) {
        x -= (item.adjust / 1000) * fs * th;
        pushAdjust(item.adjust);
        continue;
      }
      const b = item.bytes;
      for (let i = 0; i + font.codeBytes <= b.length; i += font.codeBytes) {
        const code = font.codeBytes === 2 ? (b[i] << 8) | b[i + 1] : b[i];
        const w0 = font.width(code);
        const spacing = s.charSpacing + (font.codeBytes === 1 && code === 32 ? s.wordSpacing : 0);
        const advance = (w0 * fs + spacing) * th;
        // Ink box: the glyph's own width (or a sliver for zero-width glyphs).
        const box = mapRect(textToPage, x, lo, x + Math.max(w0 * fs * th, 0.01), hi);
        const codes = font.codeBytes === 2 ? [b[i], b[i + 1]] : [b[i]];
        if (glyphHit(box, redactions)) {
          touched = true;
          removedHere++;
          // Same displacement as the glyph, so what follows stays put.
          if (fs * th !== 0) pushAdjust((-advance / (fs * th)) * 1000);
        } else {
          pushCodes(codes);
        }
        x += advance;
      }
    }

    // Advance the text matrix as the viewer will.
    s.tm = multiply([1, 0, 0, 1, x, 0], s.tm);
    if (!touched) return null;
    if (!font.reliable || fs * th === 0) {
      stats.runsRemovedWhole++;
      return "[] TJ";
    }
    stats.glyphsRemoved += removedHere;
    const parts = out.map((p) => (typeof p === "number" ? String(round(p)) : hex(p)));
    return `[${parts.join(" ")}] TJ`;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "whitespace" || token.kind === "comment") continue;

    if (token.kind === "inline-image") {
      // Unit square through the CTM, like an image XObject.
      const box = mapRect(s.ctm, 0, 0, 1, 1);
      if (redactions.some((r) => rectsIntersect(box, r))) {
        edits.push({ start: token.start, end: token.end, text: "" });
        stats.imagesRemoved++;
      }
      operands = [];
      continue;
    }
    if (token.kind !== "operator") {
      operands.push(i);
      continue;
    }

    const args = operands;
    operands = [];
    const op = token.op!;
    const firstArg = args.length > 0 ? tokens[args[0]].start : token.start;

    switch (op) {
      case "q":
        stack.push({ ...s, ctm: [...s.ctm] as Matrix, tm: [...s.tm] as Matrix, tlm: [...s.tlm] as Matrix });
        break;
      case "Q": {
        const popped = stack.pop();
        if (popped) s = { ...popped, tm: s.tm, tlm: s.tlm };
        break;
      }
      case "cm": {
        const m = nums(args);
        if (m.length >= 6) s.ctm = multiply(m.slice(-6) as Matrix, s.ctm);
        break;
      }

      // ---- paths
      case "m":
      case "l":
        if (pathStart < 0) pathStart = firstArg;
        growPath(nums(args).slice(-2));
        break;
      case "c":
        if (pathStart < 0) pathStart = firstArg;
        growPath(nums(args).slice(-6));
        break;
      case "v":
      case "y":
        if (pathStart < 0) pathStart = firstArg;
        growPath(nums(args).slice(-4));
        break;
      case "re": {
        if (pathStart < 0) pathStart = firstArg;
        const [x, y, w, h] = nums(args).slice(-4);
        growPath([x, y, x + w, y, x, y + h, x + w, y + h]);
        break;
      }
      case "h":
        break;
      case "W":
      case "W*":
        pathClips = true;
        break;
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
      case "n": {
        // A painted path wholly under a box goes; clipping paths stay, since
        // dropping one would reveal whatever it hides.
        const box = pathBox as Rect | null;
        if (pathStart >= 0 && box && !pathClips && op !== "n" && redactions.some((r) => contains(r, box))) {
          edits.push({ start: pathStart, end: token.end, text: "" });
          stats.pathsRemoved++;
        }
        pathStart = -1;
        pathBox = null;
        pathClips = false;
        break;
      }

      // ---- text state
      case "BT":
        s.tm = [...IDENTITY] as Matrix;
        s.tlm = [...IDENTITY] as Matrix;
        break;
      case "Tf": {
        const name = args.find((a) => tokens[a].kind === "name");
        if (name !== undefined) s.font = latin1(bytes, tokens[name].start + 1, tokens[name].end);
        const size = nums(args).pop();
        if (size !== undefined) s.size = size;
        break;
      }
      case "Tc":
        s.charSpacing = nums(args).pop() ?? s.charSpacing;
        break;
      case "Tw":
        s.wordSpacing = nums(args).pop() ?? s.wordSpacing;
        break;
      case "Tz":
        s.hscale = (nums(args).pop() ?? 100) / 100;
        break;
      case "TL":
        s.leading = nums(args).pop() ?? s.leading;
        break;
      case "Ts":
        s.rise = nums(args).pop() ?? s.rise;
        break;
      case "Td": {
        const [tx, ty] = nums(args).slice(-2);
        nextLine(tx ?? 0, ty ?? 0);
        break;
      }
      case "TD": {
        const [tx, ty] = nums(args).slice(-2);
        s.leading = -(ty ?? 0);
        nextLine(tx ?? 0, ty ?? 0);
        break;
      }
      case "Tm": {
        const m = nums(args);
        if (m.length >= 6) {
          s.tlm = m.slice(-6) as Matrix;
          s.tm = [...s.tlm] as Matrix;
        }
        break;
      }
      case "T*":
        nextLine(0, -s.leading);
        break;

      // ---- text showing
      case "Tj": {
        const str = args.find((a) => tokens[a].kind === "string" || tokens[a].kind === "hexstring");
        if (str === undefined) break;
        const replacement = show([{ bytes: stringBytes(bytes, tokens[str]) }]);
        if (replacement) edits.push({ start: firstArg, end: token.end, text: replacement });
        break;
      }
      case "TJ": {
        const open = args.findIndex((a) => tokens[a].kind === "array-open");
        if (open < 0) break;
        const items: ({ bytes: Uint8Array } | { adjust: number })[] = [];
        for (const a of args.slice(open + 1)) {
          const t = tokens[a];
          if (t.kind === "string" || t.kind === "hexstring") items.push({ bytes: stringBytes(bytes, t) });
          else if (t.kind === "number") items.push({ adjust: num(a) });
        }
        const replacement = show(items);
        if (replacement) edits.push({ start: tokens[args[open]].start, end: token.end, text: replacement });
        break;
      }
      case "'": {
        nextLine(0, -s.leading);
        const str = args.find((a) => tokens[a].kind === "string" || tokens[a].kind === "hexstring");
        if (str === undefined) break;
        const replacement = show([{ bytes: stringBytes(bytes, tokens[str]) }]);
        if (replacement) edits.push({ start: firstArg, end: token.end, text: `T* ${replacement}` });
        break;
      }
      case '"': {
        const [aw, ac] = nums(args);
        s.wordSpacing = aw ?? s.wordSpacing;
        s.charSpacing = ac ?? s.charSpacing;
        nextLine(0, -s.leading);
        const str = args.find((a) => tokens[a].kind === "string" || tokens[a].kind === "hexstring");
        if (str === undefined) break;
        const replacement = show([{ bytes: stringBytes(bytes, tokens[str]) }]);
        if (replacement) {
          edits.push({ start: firstArg, end: token.end, text: `${round(s.wordSpacing)} Tw ${round(s.charSpacing)} Tc T* ${replacement}` });
        }
        break;
      }

      // ---- XObjects
      case "Do": {
        const nameArg = args.find((a) => tokens[a].kind === "name");
        if (nameArg === undefined) break;
        const name = latin1(bytes, tokens[nameArg].start + 1, tokens[nameArg].end);
        const ref = resources.lookup("XObject", name);
        const xobject = ref ? resources.context.lookup(ref) : undefined;
        if (!(xobject instanceof PDFRawStream)) break;
        const subtype = typed(xobject.dict, "Subtype", PDFName)?.decodeText();
        const remove = () => edits.push({ start: tokens[nameArg].start, end: token.end, text: "" });
        const rename = (newName: string) =>
          edits.push({ start: tokens[nameArg].start, end: tokens[nameArg].end, text: `/${newName}` });

        if (subtype === "Image") {
          const placed = mapRect(s.ctm, 0, 0, 1, 1);
          const hits = redactions.filter((r) => rectsIntersect(placed, r));
          if (hits.length === 0) break;
          if (hits.some((r) => contains(r, placed))) {
            remove();
            stats.imagesRemoved++;
            break;
          }
          const inverse = invert(s.ctm);
          const width = asNumber(xobject.dict.lookup(PDFName.of("Width"))) ?? 0;
          const height = asNumber(xobject.dict.lookup(PDFName.of("Height"))) ?? 0;
          let edited: PDFRef | null = null;
          if (inverse && width && height) {
            // Redaction boxes in image pixels (row 0 at the top).
            const regions = hits.map((r) => {
              const unit = mapRect(inverse, r.x, r.y, r.x + r.w, r.y + r.h);
              const x0 = Math.max(0, Math.floor(unit.x * width));
              const x1 = Math.min(width, Math.ceil((unit.x + unit.w) * width));
              const y0 = Math.max(0, Math.floor((1 - unit.y - unit.h) * height));
              const y1 = Math.min(height, Math.ceil((1 - unit.y) * height));
              return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
            });
            edited = await blankImage(resources.context, xobject, regions, options.fill, options.editImage);
            // The soft mask is image data too; make the region opaque there.
            const smaskRef = xobject.dict.get(PDFName.of("SMask"));
            const smask = smaskRef ? resources.context.lookup(smaskRef) : undefined;
            if (edited && smask instanceof PDFRawStream) {
              const maskW = asNumber(smask.dict.lookup(PDFName.of("Width"))) ?? width;
              const maskH = asNumber(smask.dict.lookup(PDFName.of("Height"))) ?? height;
              const scaled = regions.map((g) => ({
                x: Math.floor((g.x * maskW) / width),
                y: Math.floor((g.y * maskH) / height),
                w: Math.ceil((g.w * maskW) / width),
                h: Math.ceil((g.h * maskH) / height),
              }));
              const newMask = await blankImage(resources.context, smask, scaled, options.fill, undefined, 255);
              const editedStream = resources.context.lookup(edited);
              if (editedStream instanceof PDFRawStream) {
                if (newMask) editedStream.dict.set(PDFName.of("SMask"), newMask);
                else editedStream.dict.delete(PDFName.of("SMask"));
              }
            }
          }
          if (edited) {
            rename(resources.add("XObject", edited, "VrushRedactIm"));
            stats.imagesEdited++;
          } else {
            remove();
            stats.imagesRemoved++;
          }
          break;
        }

        if (subtype === "Form") {
          const matrixArr = typed(xobject.dict, "Matrix", PDFArray);
          const formMatrix = (matrixArr ? matrixArr.asArray().map((n) => asNumber(n) ?? 0) : IDENTITY) as Matrix;
          const toPage = multiply(formMatrix, s.ctm);
          const bbox = typed(xobject.dict, "BBox", PDFArray);
          const [bx0, by0, bx1, by1] = bbox ? bbox.asArray().map((n) => asNumber(n) ?? 0) : [0, 0, 0, 0];
          const placed = bbox ? mapRect(toPage, bx0, by0, bx1, by1) : null;
          if (placed && !redactions.some((r) => rectsIntersect(placed, r))) break;
          const inverse = invert(toPage);
          if (!inverse || options.depth >= 6) {
            remove();
            stats.imagesRemoved++;
            break;
          }
          // The boxes in the form's own space, then redact a copy of it.
          const local = redactions.map((r) => mapRect(inverse, r.x, r.y, r.x + r.w, r.y + r.h));
          const formResourcesDict = typed(xobject.dict, "Resources", PDFDict) ?? resources.original;
          const formResources = new Resources(resources.context, formResourcesDict);
          const content = decodePDFRawStream(xobject).decode();
          const redacted = await redactStream(content, local, { ...options, resources: formResources, depth: options.depth + 1 });
          const dict = xobject.dict.clone(resources.context);
          dict.delete(PDFName.of("Filter"));
          dict.delete(PDFName.of("DecodeParms"));
          if (formResources.changed) dict.set(PDFName.of("Resources"), formResources.changed);
          else if (formResourcesDict) dict.set(PDFName.of("Resources"), formResourcesDict);
          const copy = resources.context.flateStream(redacted, Object.fromEntries(dict.entries().map(([k, v]) => [k.decodeText(), v])));
          rename(resources.add("XObject", resources.context.register(copy), "VrushRedactFm"));
          stats.formsRedacted++;
        }
        break;
      }

      default:
        break;
    }
  }

  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const e of edits) {
    if (e.start < last) continue; // nested inside an earlier edit (a removed path)
    out += latin1(bytes, last, e.start) + e.text;
    last = e.end;
  }
  out += latin1(bytes, last, bytes.length);
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

/** The opaque boxes and labels, drawn on top of the cleaned page. */
function bakedBoxes(redactions: RedactTarget[], fontName: string | null): string {
  let out = "\n% VrushPDF redactions\n";
  for (const { rect, fillColor = "#000000", overlayText } of redactions) {
    const [r, g, b] = hexToRgb(fillColor);
    out += `q\n${round(r)} ${round(g)} ${round(b)} rg\n${round(rect.x)} ${round(rect.y)} ${round(rect.w)} ${round(rect.h)} re f\n`;
    const label = overlayText?.trim();
    if (label && fontName) {
      const size = Math.min(Math.max(rect.h * 0.6, 6), 14);
      const width = label.length * size * 0.55;
      const x = Math.max(rect.x + (rect.w - width) / 2, rect.x + 2);
      const y = rect.y + (rect.h - size) / 2 + 1;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const escaped = label.replace(/[()\\]/g, "\\$&");
      out += `BT\n/${fontName} ${round(size)} Tf\n${lum < 0.5 ? "1 1 1" : "0 0 0"} rg\n${round(x)} ${round(y)} Td\n(${escaped}) Tj\nET\n`;
    }
    out += "Q\n";
  }
  return out;
}

const bytesOf = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Redact one content stream with no resources at hand: fonts are unknown, so
 * any touched text run is removed whole. Kept for callers and tests that
 * work on bare streams; documents go through `applyRedactionsToDocument`.
 */
export async function sanitizeContentStream(streamBytes: Uint8Array, redactions: RedactTarget[]): Promise<Uint8Array> {
  if (redactions.length === 0) return streamBytes;
  const doc = await PDFDocument.create();
  const cleaned = await redactStream(streamBytes, redactions.map((r) => r.rect), {
    resources: new Resources(doc.context, undefined),
    fill: hexToRgb(redactions[0].fillColor ?? "#000000") as [number, number, number],
    stats: emptyStats(),
    depth: 0,
  });
  return concat([bytesOf("q\n"), cleaned, bytesOf("\nQ\n"), bytesOf(bakedBoxes(redactions, null))]);
}

export interface DocumentRedactionRequest {
  docBytes: Uint8Array;
  /** Array of redaction targets per 0-based page index */
  pageRedactions: { pageIndex: number; targets: RedactTarget[] }[];
  /** Edits partly covered images the engine can't decode itself (JPEG). */
  editImage?: ImageEditor;
}

export interface DocumentRedactionResult extends RedactionStats {
  bytes: Uint8Array;
  redactionsApplied: number;
}

/** Whether an annotation is a form field widget, and clear its value if so. */
function clearFieldValue(dict: PDFDict) {
  let field: PDFDict | undefined = dict;
  for (let depth = 0; field && depth < 8; depth++) {
    if (field.has(PDFName.of("V"))) field.set(PDFName.of("V"), PDFString.of(""));
    field.delete(PDFName.of("AP"));
    field = typed(field, "Parent", PDFDict);
  }
}

/**
 * Apply permanent redactions across a document: clean each affected page's
 * content (and the forms and images it draws), draw the boxes, and drop
 * annotations and field values under them.
 */
export async function applyRedactionsToDocument(request: DocumentRedactionRequest): Promise<DocumentRedactionResult> {
  const { docBytes, pageRedactions, editImage } = request;
  const stats = emptyStats();
  if (pageRedactions.length === 0) return { bytes: docBytes, redactionsApplied: 0, ...stats };

  const doc = await PDFDocument.load(docBytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const needsFont = pageRedactions.some((p) => p.targets.some((t) => t.overlayText?.trim()));
  const labelFont = needsFont ? doc.embedStandardFont(StandardFonts.Helvetica) : null;
  let applied = 0;

  for (const { pageIndex, targets } of pageRedactions) {
    if (pageIndex < 0 || pageIndex >= pages.length || targets.length === 0) continue;
    const page = pages[pageIndex];
    applied += targets.length;
    page.node.normalize();

    const resources = new Resources(doc.context, page.node.Resources());
    const contents = page.node.get(PDFName.of("Contents"));
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    const chunks: Uint8Array[] = [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) {
        chunks.push(decodePDFRawStream(stream).decode());
        // Keep tokens from gluing across stream boundaries.
        chunks.push(bytesOf("\n"));
      }
    }
    const cleaned = await redactStream(concat(chunks), targets.map((t) => t.rect), {
      resources,
      fill: hexToRgb(targets[0].fillColor ?? "#000000") as [number, number, number],
      editImage,
      stats,
      depth: 0,
    });

    const fontName = labelFont ? resources.add("Font", labelFont.ref, "VrushRedactF") : null;
    if (resources.changed) page.node.set(PDFName.of("Resources"), resources.changed);
    // The original content may leave the graphics state changed (a stray `cm`
    // or clip); wrap it so the boxes land where they should.
    const content = concat([bytesOf("q\n"), cleaned, bytesOf("\nQ\n"), bytesOf(bakedBoxes(targets, fontName))]);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));

    // Annotations under a box go; form fields also lose their values.
    const annots = typed(page.node, "Annots", PDFArray);
    if (annots) {
      const kept: (PDFRef | PDFDict)[] = [];
      const rects = targets.map((t) => t.rect);
      for (let i = 0; i < annots.size(); i++) {
        const item = annots.get(i);
        const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
        const dict = resolved instanceof PDFDict ? resolved : undefined;
        if (dict) {
          const subtype = typed(dict, "Subtype", PDFName)?.decodeText();
          if (subtype === "Redact") continue;
          const r = typed(dict, "Rect", PDFArray);
          if (r && r.size() >= 4) {
            const [x1, y1, x2, y2] = [0, 1, 2, 3].map((k) => asNumber(r.lookup(k)) ?? 0);
            const box = normalizeRect({ x: x1, y: y1 }, { x: x2, y: y2 });
            if (rects.some((t) => rectsIntersect(box, t))) {
              if (subtype === "Widget") clearFieldValue(dict);
              continue;
            }
          }
        }
        if (item instanceof PDFRef || item instanceof PDFDict) kept.push(item);
      }
      if (kept.length > 0) page.node.set(PDFName.of("Annots"), doc.context.obj(kept));
      else page.node.delete(PDFName.of("Annots"));
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, redactionsApplied: applied, ...stats };
}
