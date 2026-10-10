/**
 * Optical character recognition with Tesseract, compiled to WebAssembly.
 *
 * Runs in a Web Worker inside the webview, so every platform gets the same
 * engine and the same results. The worker, the engine and the language models
 * are served from the bundle (see `scripts/copy-ocr-assets.mjs`), so nothing is
 * downloaded and OCR works offline, like the rest of the app.
 *
 * Browser-only (it renders to a canvas), which is why it sits outside
 * `annotations/`. The PDF side, writing what this finds into the file, lives
 * in `annotations/ocrText.ts`.
 */
import type { PageViewport } from "pdfjs-dist";
import type { Worker as TesseractWorker } from "tesseract.js";

import type { OcrWord } from "$lib/annotations/ocrText";
import type { Rect, Rotation } from "$lib/annotations/types";
import type { PDFPageProxy } from "$lib/pdf/pdfjs";
import { renderPageImage } from "$lib/pdf/render";

/** Must match `LANGUAGES` in `scripts/copy-ocr-assets.mjs`. */
export const OCR_LANGUAGES = [
  { code: "eng", label: "English" },
  { code: "deu", label: "German" },
  { code: "fra", label: "French" },
  { code: "spa", label: "Spanish" },
  { code: "ita", label: "Italian" },
  { code: "nld", label: "Dutch" },
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]["code"];

const LANGS_KEY = "vrushpdf.ocr.langs.v1";
const BY_LOCALE: Record<string, OcrLanguage> = { de: "deu", fr: "fra", es: "spa", it: "ita", nl: "nld" };

/** The languages last used, or English plus the system language if bundled. */
export function loadOcrLanguages(): OcrLanguage[] {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(LANGS_KEY) ?? "null");
    const known = new Set<string>(OCR_LANGUAGES.map((l) => l.code));
    if (Array.isArray(saved)) {
      const valid = saved.filter((code): code is OcrLanguage => known.has(code));
      if (valid.length > 0) return valid;
    }
  } catch {
    // Corrupt storage: fall through to the defaults.
  }
  const local = BY_LOCALE[(globalThis.navigator?.language ?? "en").slice(0, 2).toLowerCase()];
  return local ? ["eng", local] : ["eng"];
}

export function saveOcrLanguages(langs: OcrLanguage[]) {
  try {
    globalThis.localStorage?.setItem(LANGS_KEY, JSON.stringify(langs));
  } catch {
    // Non-fatal: the choice just won't be remembered.
  }
}

/** Scans are read at 300 DPI, Tesseract's sweet spot... */
const OCR_DPI = 300;
/** ...unless the page is huge, where memory wins. */
const MAX_EDGE_PX = 5000;
/** Words Tesseract is less sure of than this are left out of the text layer. */
const MIN_CONFIDENCE = 25;
/**
 * A read is taken as the right way up when at least this share of its
 * characters sit in horizontal words of two or more letters, read with at
 * least this mean confidence. Sideways text comes out as scattered single
 * characters (often confidently) or, in page mode, as Tesseract's own turned
 * lines with tall word boxes; upside-down text comes out as low-confidence
 * gibberish.
 */
const UPRIGHT_WORD_SHARE = 0.6;
const UPRIGHT_CONFIDENCE = 70;
/** Free the worker (a few hundred MB with models loaded) after this long idle. */
const IDLE_MS = 60_000;

let worker: TesseractWorker | null = null;
let workerLangs = "";
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** Serialises jobs: one worker, one recognition at a time. */
let queue: Promise<unknown> = Promise.resolve();
let progressSink: ((fraction: number) => void) | null = null;

async function ensureWorker(langs: OcrLanguage[]): Promise<TesseractWorker> {
  clearTimeout(idleTimer);
  const key = langs.join("+");
  if (worker && workerLangs === key) return worker;
  if (worker) {
    await worker.reinitialize(key);
    workerLangs = key;
    return worker;
  }
  // Loaded on first use: ~1 MB of script nobody pays for until they OCR.
  const { createWorker, OEM } = await import("tesseract.js");
  worker = await createWorker(key, OEM.LSTM_ONLY, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/core",
    langPath: "/ocr/lang",
    // The models are local files; caching them again in IndexedDB only wastes disk.
    cacheMethod: "none",
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text") progressSink?.(m.progress);
    },
  });
  workerLangs = key;
  return worker;
}

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void worker?.terminate();
    worker = null;
    workerLangs = "";
  }, IDLE_MS);
}

/** Run `job` on the shared worker once any earlier job has finished. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run.finally(scheduleIdleShutdown);
}

/**
 * Render a page the way the user sees it (so a scan they turned upright is
 * read upright) at OCR resolution. The searchable layer leaves out
 * annotations, so their text isn't added to the page twice; the region tool
 * reads what the user sees.
 */
const renderForOcr = (page: PDFPageProxy, rotation: Rotation, withAnnotations: boolean) =>
  renderPageImage(page, rotation, { dpi: OCR_DPI, maxEdge: MAX_EDGE_PX, withAnnotations });

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Baseline height at `x`, from a line's baseline segment, in canvas pixels. */
function baselineAt(line: { baseline: Box & { has_baseline?: boolean }; bbox: Box }, x: number): number {
  const b = line.baseline;
  if (b.has_baseline === false || b.x1 === b.x0) return line.bbox.y1;
  return b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);
}

/** Tesseract's word boxes (canvas pixels, y down) -> `OcrWord`s in PDF space. */
function wordsInPdfSpace(blocks: any[] | null, viewport: PageViewport): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const kept = (line.words ?? []).filter(
          (w: any) => w.text?.trim() && w.confidence >= MIN_CONFIDENCE,
        );
        // Ascender-to-descender height suits Helvetica's em box better than
        // the line's ink box, which shrinks on lines without descenders.
        const rowPx = line.rowAttributes?.row_height || line.bbox.y1 - line.bbox.y0;
        kept.forEach((w: any, i: number) => {
          const [x0, y0] = viewport.convertToPdfPoint(w.bbox.x0, baselineAt(line, w.bbox.x0));
          const [x1, y1] = viewport.convertToPdfPoint(w.bbox.x1, baselineAt(line, w.bbox.x1));
          const width = Math.hypot(x1 - x0, y1 - y0);
          if (width <= 0) return;
          words.push({
            text: w.text,
            x: x0,
            y: y0,
            dirX: (x1 - x0) / width,
            dirY: (y1 - y0) / width,
            width,
            size: rowPx / viewport.scale,
            lineEnd: i === kept.length - 1,
          });
        });
      }
    }
  }
  return words;
}

export interface PageOcr {
  words: OcrWord[];
  text: string;
}

/** The view's rotation first, then the other three quarter-turns. */
function orientations(rotation: Rotation): Rotation[] {
  return [0, 90, 180, 270].map((turn) => ((rotation + turn) % 360) as Rotation);
}

interface ReadQuality {
  /** Confidence-weighted letters inside real, horizontal words. */
  score: number;
  /** Looks like text read the right way up. */
  upright: boolean;
  /** Nothing legible: a blank area reads the same whichever way up. */
  empty: boolean;
}

/**
 * How much of a read is real words running left to right on the image. Only
 * such reads map back onto the page correctly (`wordsInPdfSpace` assumes
 * horizontal baselines), so only they can win.
 */
function readQuality(blocks: any[] | null): ReadQuality {
  let score = 0;
  let wordChars = 0;
  let wordLetters = 0;
  let allChars = 0;
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text: string = word.text?.trim() ?? "";
          const letters = text.match(/\p{L}/gu)?.length ?? 0;
          const horizontal = word.bbox.x1 - word.bbox.x0 >= (word.bbox.y1 - word.bbox.y0) * 0.8;
          allChars += text.length;
          if (letters >= 2 && horizontal) {
            wordChars += text.length;
            wordLetters += letters;
            score += letters * (word.confidence / 100);
          }
        }
      }
    }
  }
  const confidence = wordLetters > 0 ? (score / wordLetters) * 100 : 0;
  return {
    score,
    upright: allChars > 0 && wordChars / allChars >= UPRIGHT_WORD_SHARE && confidence >= UPRIGHT_CONFIDENCE,
    empty: allChars === 0,
  };
}

/**
 * Read at each orientation until one looks upright, keeping the best. Scans
 * come in sideways and upside down; Tesseract's own orientation detection
 * needs the legacy engine, which isn't bundled. An upright page costs one
 * read; only a doubtful one pays for the other turns.
 */
async function bestOrientation<T>(
  rotation: Rotation,
  read: (rotation: Rotation) => Promise<{ quality: ReadQuality; result: T }>,
): Promise<T> {
  let best: { quality: ReadQuality; result: T } | null = null;
  for (const turn of orientations(rotation)) {
    const attempt = await read(turn);
    if (!best || attempt.quality.score > best.quality.score) best = attempt;
    // Empty isn't a reason to stop: sideways text can read as nothing at all.
    if (attempt.quality.upright) break;
  }
  return best!.result;
}

/**
 * Recognise a whole page. `onProgress` gets 0..1 for this page.
 */
export function recognizePage(
  page: PDFPageProxy,
  rotation: Rotation,
  langs: OcrLanguage[],
  onProgress?: (fraction: number) => void,
): Promise<PageOcr> {
  return enqueue(async () => {
    const w = await ensureWorker(langs);
    await w.setParameters({ tessedit_pageseg_mode: "3" as any, preserve_interword_spaces: "1" });
    progressSink = onProgress ?? null;
    try {
      return await bestOrientation(rotation, async (turn) => {
        const { canvas, viewport } = await renderForOcr(page, turn, false);
        const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });
        return {
          quality: readQuality(data.blocks),
          result: { words: wordsInPdfSpace(data.blocks, viewport), text: data.text },
        };
      });
    } finally {
      progressSink = null;
    }
  });
}

/** Recognise the text inside `rect` (PDF space) on a page, for copying. */
export function recognizeRegion(
  page: PDFPageProxy,
  rotation: Rotation,
  rect: Rect,
  langs: OcrLanguage[],
): Promise<string> {
  return enqueue(async () => {
    const w = await ensureWorker(langs);
    // A dragged box is one block of text, not a page layout to analyse.
    await w.setParameters({ tessedit_pageseg_mode: "6" as any, preserve_interword_spaces: "1" });
    return bestOrientation(rotation, async (turn) => {
      const { canvas, viewport } = await renderForOcr(page, turn, true);
      const [ax, ay] = viewport.convertToViewportPoint(rect.x, rect.y);
      const [bx, by] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h);
      const left = Math.max(0, Math.floor(Math.min(ax, bx)));
      const top = Math.max(0, Math.floor(Math.min(ay, by)));
      const width = Math.min(canvas.width - left, Math.ceil(Math.abs(bx - ax)));
      const height = Math.min(canvas.height - top, Math.ceil(Math.abs(by - ay)));
      if (width < 4 || height < 4) return { quality: { score: 0, upright: false, empty: true }, result: "" };
      const { data } = await w.recognize(canvas, { rectangle: { left, top, width, height } }, { blocks: true, text: true });
      return { quality: readQuality(data.blocks), result: data.text.trim() };
    });
  });
}

/** Whether a page already carries real text, so OCR would only duplicate it. */
export async function pageHasText(page: PDFPageProxy, minChars = 24): Promise<boolean> {
  const content = await page.getTextContent();
  let chars = 0;
  for (const item of content.items) {
    if ("str" in item) chars += item.str.trim().length;
    if (chars >= minChars) return true;
  }
  return false;
}
