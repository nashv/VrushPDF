/**
 * PDF annotation dictionaries -> model, via pdf-lib.
 *
 * pdf-lib is used rather than pdf.js's `getAnnotations()` because pdf.js
 * normalises some geometry on the way out — most damagingly it returns `/L` as
 * a normalised rectangle, which loses which end of a line the arrowhead is on.
 * Reading the raw dictionaries keeps the round trip exact.
 *
 * Stamp annotations are deliberately *not* imported: recovering editable pixels
 * from an appearance stream is not something we can do faithfully. They are
 * left untouched in the file and keep rendering from it, so nothing is lost —
 * they just aren't editable after a reopen.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";

import {
  DEFAULT_AUTHOR,
  newId,
  NOTE_SIZE,
  type Annot,
  type NoteAnnot,
  type PageEntry,
  type Point,
  type Quad,
  type Rect,
} from "./types";

export interface ImportResult {
  annots: Annot[];
  /**
   * pdf.js annotation ids (`"14R"`) for everything we took over, so the canvas
   * renderer can suppress them via `annotationStorage`.
   */
  suppress: string[];
  /**
   * Object numbers of every dictionary we took ownership of, including paired
   * `/Popup` objects.
   *
   * Captured once at import time and *not* derived from the live model, because
   * saving must also drop the original dictionary of an annotation the user has
   * since deleted.
   */
  managedRefs: Set<number>;
}

// ------------------------------------------------------------- dict accessors

const lookupNumber = (dict: PDFDict, key: string): number | null => {
  const v = dict.lookupMaybe(PDFName.of(key), PDFNumber);
  return v ? v.asNumber() : null;
};

const lookupName = (dict: PDFDict, key: string): string | null => {
  const v = dict.lookupMaybe(PDFName.of(key), PDFName);
  return v ? v.decodeText() : null;
};

function lookupText(dict: PDFDict, key: string): string | null {
  const v = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  return v ? v.decodeText() : null;
}

function lookupNumbers(dict: PDFDict, key: string): number[] | null {
  const arr = dict.lookupMaybe(PDFName.of(key), PDFArray);
  if (!arr) return null;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const item = arr.lookup(i);
    if (!(item instanceof PDFNumber)) return null;
    out.push(item.asNumber());
  }
  return out;
}

/** Components in 0..1 -> `#rrggbb`. */
function toHex(components: number[]): string {
  let rgb: [number, number, number];
  if (components.length === 1) {
    const g = components[0];
    rgb = [g, g, g];
  } else if (components.length === 3) {
    rgb = [components[0], components[1], components[2]];
  } else if (components.length === 4) {
    // DeviceCMYK -> RGB.
    const [c, m, y, k] = components;
    rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  } else {
    return "#000000";
  }
  const byte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${rgb.map(byte).join("")}`;
}

function colorOf(dict: PDFDict, key: string, fallback: string | null): string | null {
  const components = lookupNumbers(dict, key);
  if (!components || components.length === 0) return fallback;
  return toHex(components);
}

/** `D:YYYYMMDDHHmmSS±HH'mm'` -> ISO 8601. */
function parsePdfDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+-Z])(\d{2})'?(\d{2})?)?/.exec(
    raw.trim(),
  );
  if (!m) return null;

  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", sign, oh = "00", om = "00"] = m;
  const offset = !sign || sign === "Z" ? "Z" : `${sign}${oh}:${om}`;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Stroke width from `/BS /W`, falling back to `/Border`. */
function borderWidth(dict: PDFDict, fallback: number): number {
  const bs = dict.lookupMaybe(PDFName.of("BS"), PDFDict);
  const w = bs ? lookupNumber(bs, "W") : null;
  if (w !== null) return w;
  const border = lookupNumbers(dict, "Border");
  if (border && border.length >= 3) return border[2];
  return fallback;
}

function rectOf(dict: PDFDict): Rect | null {
  const r = lookupNumbers(dict, "Rect");
  if (!r || r.length < 4) return null;
  const x = Math.min(r[0], r[2]);
  const y = Math.min(r[1], r[3]);
  return { x, y, w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
}

/** Font size out of a `/DA` string like `/Helv 12 Tf 0 g`. */
function fontSizeOf(dict: PDFDict, fallback: number): number {
  const da = lookupText(dict, "DA");
  if (!da) return fallback;
  const m = /\/[^\s]+\s+([\d.]+)\s+Tf/.exec(da);
  const size = m ? Number.parseFloat(m[1]) : NaN;
  // A `/DA` size of 0 means "auto-size", which we materialise as the default.
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

/** The fill (`rg`, `g`) or stroke (`RG`, `G`) colour a `/DA` string sets. */
function daColor(da: string, stroke: boolean): string | null {
  const [rgbOp, grayOp] = stroke ? ["RG", "G"] : ["rg", "g"];
  const rgb = new RegExp(`([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+${rgbOp}\\b`).exec(da);
  if (rgb) return toHex(rgb.slice(1, 4).map(Number));
  const gray = new RegExp(`(?:^|\\s)([\\d.]+)\\s+${grayOp}\\b`).exec(da);
  return gray ? toHex([Number(gray[1])]) : null;
}

// ------------------------------------------------------------------ per-kind

function quadsOf(dict: PDFDict): Quad[] {
  const flat = lookupNumbers(dict, "QuadPoints");
  if (!flat || flat.length < 8) return [];
  const quads: Quad[] = [];
  for (let i = 0; i + 7 < flat.length; i += 8) {
    quads.push({
      x1: flat[i], y1: flat[i + 1],
      x2: flat[i + 2], y2: flat[i + 3],
      x3: flat[i + 4], y3: flat[i + 5],
      x4: flat[i + 6], y4: flat[i + 7],
    });
  }
  return quads;
}

function inkPathsOf(dict: PDFDict): Point[][] {
  const lists = dict.lookupMaybe(PDFName.of("InkList"), PDFArray);
  if (!lists) return [];
  const paths: Point[][] = [];
  for (let i = 0; i < lists.size(); i++) {
    const stroke = lists.lookup(i);
    if (!(stroke instanceof PDFArray)) continue;
    const pts: Point[] = [];
    for (let j = 0; j + 1 < stroke.size(); j += 2) {
      const x = stroke.lookup(j);
      const y = stroke.lookup(j + 1);
      if (x instanceof PDFNumber && y instanceof PDFNumber) {
        pts.push({ x: x.asNumber(), y: y.asNumber() });
      }
    }
    if (pts.length > 0) paths.push(pts);
  }
  return paths;
}

const NOTE_ICONS = new Set<NoteAnnot["icon"]>([
  "Comment", "Note", "Help", "Key", "NewParagraph", "Paragraph", "Insert",
]);

function noteIcon(dict: PDFDict): NoteAnnot["icon"] {
  const name = lookupName(dict, "Name");
  return name && NOTE_ICONS.has(name as NoteAnnot["icon"]) ? (name as NoteAnnot["icon"]) : "Comment";
}

/** Build one model annotation, or `null` if the dict can't be represented. */
function toAnnot(dict: PDFDict, subtype: string, pageId: string, objectNumber: number): Annot | null {
  const now = new Date().toISOString();
  const base = {
    // Reuse `/NM` when present so ids stay stable across save/reopen cycles.
    id: lookupText(dict, "NM") || newId(),
    pageId,
    color: colorOf(dict, "C", "#000000") ?? "#000000",
    opacity: lookupNumber(dict, "CA") ?? 1,
    contents: lookupText(dict, "Contents") ?? "",
    author: lookupText(dict, "T") ?? DEFAULT_AUTHOR,
    createdAt: parsePdfDate(lookupText(dict, "CreationDate")) ?? now,
    modifiedAt: parsePdfDate(lookupText(dict, "M")) ?? now,
    sourceRef: objectNumber,
  };

  switch (subtype) {
    case "Highlight":
    case "Underline":
    case "StrikeOut":
    case "Squiggly": {
      const quads = quadsOf(dict);
      if (quads.length === 0) return null;
      const kind = (
        { Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly" } as const
      )[subtype];
      return { ...base, kind, quads, quotedText: "" };
    }

    case "Ink": {
      const paths = inkPathsOf(dict);
      if (paths.length === 0) return null;
      return { ...base, kind: "ink", paths, width: borderWidth(dict, 2) };
    }

    case "Square":
    case "Circle": {
      const rect = rectOf(dict);
      if (!rect) return null;
      return {
        ...base,
        kind: subtype === "Square" ? "square" : "circle",
        rect,
        width: borderWidth(dict, 2),
        fill: colorOf(dict, "IC", null),
      };
    }

    case "Line": {
      const l = lookupNumbers(dict, "L");
      if (!l || l.length < 4) return null;
      // `/LE` tells us whether an end carries an arrowhead. Reading `/L`
      // directly (rather than via pdf.js) preserves the true direction.
      const endings = dict.lookupMaybe(PDFName.of("LE"), PDFArray);
      const tail = endings && endings.size() > 1 ? endings.lookup(1) : null;
      const isArrow =
        tail instanceof PDFName && /Arrow/i.test(tail.decodeText());
      return {
        ...base,
        kind: isArrow ? "arrow" : "line",
        from: { x: l[0], y: l[1] },
        to: { x: l[2], y: l[3] },
        width: borderWidth(dict, 2),
      };
    }

    case "FreeText": {
      const rect = rectOf(dict);
      if (!rect) return null;
      const q = lookupNumber(dict, "Q") ?? 0;
      const da = lookupText(dict, "DA") ?? "";
      const color = daColor(da, false) ?? base.color;
      const background = colorOf(dict, "C", null);
      const borderColor = daColor(da, true);
      return {
        ...base,
        kind: "freetext",
        color,
        rect,
        text: base.contents,
        fontSize: fontSizeOf(dict, 12),
        align: q === 1 ? "center" : q === 2 ? "right" : "left",
        // Earlier builds of this app wrote the text colour into `/C`. Text on a
        // background of its own colour cannot be read, so that means none.
        bgColor: background && background !== color ? background : null,
        borderColor,
        borderWidth: borderColor ? borderWidth(dict, 1) : 0,
      };
    }

    case "Text": {
      const rect = rectOf(dict);
      if (!rect) return null;
      // Our model anchors a note by its top-left corner.
      return {
        ...base,
        kind: "note",
        point: { x: rect.x, y: rect.y + Math.max(rect.h, NOTE_SIZE) },
        icon: noteIcon(dict),
      };
    }

    default:
      return null;
  }
}

/**
 * Import the annotations of one source document.
 *
 * `entries` selects which of its pages to read and supplies the page ids the
 * resulting annotations attach to.
 */
export async function importAnnots(
  bytes: Uint8Array,
  entries: PageEntry[],
): Promise<ImportResult> {
  const annots: Annot[] = [];
  const suppress: string[] = [];
  const managedRefs = new Set<number>();

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    // An unparseable-by-pdf-lib file can still be viewed; it just starts with
    // no editable annotations.
    return { annots, suppress, managedRefs };
  }

  const pages = pdf.getPages();

  for (const entry of entries) {
    const page = pages[entry.srcIndex];
    if (!page) continue;

    const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!array) continue;

    for (let i = 0; i < array.size(); i++) {
      const slot = array.get(i);
      // Direct (non-indirect) annotation dictionaries have no object number, so
      // there is no way to match them on save. Leave them in the file.
      if (!(slot instanceof PDFRef)) continue;

      let dict: PDFDict;
      try {
        dict = pdf.context.lookup(slot, PDFDict);
      } catch {
        continue;
      }

      const subtype = lookupName(dict, "Subtype");
      if (!subtype) continue;

      const annot = toAnnot(dict, subtype, entry.id, slot.objectNumber);
      if (!annot) continue;

      annots.push(annot);
      suppress.push(refId(slot));
      managedRefs.add(slot.objectNumber);

      // Take the paired popup with it, or saving would leave the popup behind
      // pointing at an annotation that no longer exists.
      const popup = dict.get(PDFName.of("Popup"));
      if (popup instanceof PDFRef) {
        suppress.push(refId(popup));
        managedRefs.add(popup.objectNumber);
      }
    }
  }

  return { annots, suppress, managedRefs };
}

/** pdf.js's id for an object: `"<num>R"`, plus the generation when non-zero. */
function refId(ref: PDFRef): string {
  return ref.generationNumber === 0
    ? `${ref.objectNumber}R`
    : `${ref.objectNumber}R${ref.generationNumber}`;
}
