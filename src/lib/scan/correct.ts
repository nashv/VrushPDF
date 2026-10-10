/**
 * Straightening scanned pages and correcting the perspective of photographed
 * ones.
 *
 * Both work on the page as the user sees it, rendered at 300 DPI, and produce
 * a new page image plus a function that carries points from the old page into
 * the new one, so annotations can follow their content.
 *
 * Browser-only (canvas); the measuring and the maths are in `analysis.ts` and
 * `geometry.ts`, the PDF surgery in `annotations/replacePage.ts`.
 */
import type { PageImage } from "$lib/annotations/replacePage";
import type { Point, Rotation } from "$lib/annotations/types";
import type { PDFPageProxy } from "$lib/pdf/pdfjs";
import { renderPageImage } from "$lib/pdf/render";

import { detectDocumentQuad, detectSkew, toGray, type NormQuad } from "./analysis";
import { homography, project, rotateAbout, sheetSizeFor } from "./geometry";

/** Output resolution, as agreed for corrected scans. */
const OUTPUT_DPI = 300;
const MAX_EDGE_PX = 5000;
const JPEG_QUALITY = 0.9;
/** Measuring needs far less resolution than the output. */
const ANALYSIS_DPI = 100;
/** Tilts smaller than this aren't worth a lossy re-render. */
export const MIN_SKEW_DEGREES = 0.1;

export type Correction =
  | { kind: "deskew"; degrees: number }
  /** Corners of the document on the page as seen, normalised 0..1. */
  | { kind: "perspective"; quad: NormQuad };

export interface CorrectedPage {
  image: PageImage;
  /** New page size, in points. */
  width: number;
  height: number;
  /** Old page's PDF space to the new page's. */
  mapPoint: (p: Point) => Point;
}

/** The page as the user sees it, in gray, at measuring resolution. */
async function grayOf(page: PDFPageProxy, rotation: Rotation) {
  const { canvas } = await renderPageImage(page, rotation, { dpi: ANALYSIS_DPI, maxEdge: 1400 });
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return toGray(data, canvas.width, canvas.height);
}

/** Tilt of the page's text, in degrees; see `detectSkew`. */
export const measureSkew = async (page: PDFPageProxy, rotation: Rotation) => detectSkew(await grayOf(page, rotation));

/** Where the paper's corners seem to be in a photographed page, or null. */
export const detectCorners = async (page: PDFPageProxy, rotation: Rotation): Promise<NormQuad | null> =>
  detectDocumentQuad(await grayOf(page, rotation));

async function toJpeg(canvas: HTMLCanvasElement): Promise<PageImage> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("could not encode the corrected page");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
}

function blankCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("could not acquire a 2D canvas context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

export async function correctPage(
  page: PDFPageProxy,
  rotation: Rotation,
  correction: Correction,
): Promise<CorrectedPage> {
  const { canvas: source, viewport } = await renderPageImage(page, rotation, {
    dpi: OUTPUT_DPI,
    maxEdge: MAX_EDGE_PX,
  });
  const scale = viewport.scale;
  const toSourcePx = (p: Point): Point => {
    const [x, y] = viewport.convertToViewportPoint(p.x, p.y);
    return { x, y };
  };

  if (correction.kind === "deskew") {
    // Turning the image clockwise by the measured tilt levels the text. The
    // page keeps its size; corners that turn out of frame are lost, the ones
    // that turn in are white.
    const { canvas, ctx } = blankCanvas(source.width, source.height);
    const centre = { x: source.width / 2, y: source.height / 2 };
    ctx.imageSmoothingQuality = "high";
    ctx.translate(centre.x, centre.y);
    ctx.rotate((correction.degrees * Math.PI) / 180);
    ctx.drawImage(source, -centre.x, -centre.y);

    const width = source.width / scale;
    const height = source.height / scale;
    return {
      image: await toJpeg(canvas),
      width,
      height,
      mapPoint: (p) => {
        const q = rotateAbout(toSourcePx(p), centre, correction.degrees);
        return { x: q.x / scale, y: height - q.y / scale };
      },
    };
  }

  // Perspective: warp the quad the user marked onto an upright sheet.
  const quadPx = correction.quad.map((c) => ({ x: c.x * source.width, y: c.y * source.height }));
  const sheet = sheetSizeFor(quadPx.map((p) => ({ x: p.x / scale, y: p.y / scale })));
  const outScale = Math.min(OUTPUT_DPI / 72, MAX_EDGE_PX / Math.max(sheet.width, sheet.height));
  const outW = Math.max(1, Math.round(sheet.width * outScale));
  const outH = Math.max(1, Math.round(sheet.height * outScale));
  const rect = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const back = homography(rect, quadPx);
  const forward = homography(quadPx, rect);
  if (!back || !forward) throw new Error("Those corners don't make a usable shape; move them apart.");

  const src = source.getContext("2d")!.getImageData(0, 0, source.width, source.height);
  const { canvas, ctx } = blankCanvas(outW, outH);
  const out = ctx.createImageData(outW, outH);
  warp(src, out, back);
  ctx.putImageData(out, 0, 0);

  return {
    image: await toJpeg(canvas),
    width: sheet.width,
    height: sheet.height,
    mapPoint: (p) => {
      const q = project(forward, toSourcePx(p));
      return { x: q.x / outScale, y: sheet.height - q.y / outScale };
    },
  };
}

/**
 * Fill `out` by sampling `src` through `back` (output pixel -> source pixel),
 * bilinearly. Outside the source is white, like paper.
 */
function warp(src: ImageData, out: ImageData, back: number[]) {
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const o = out.data;
  const [a, b, c, d, e, f, g, h, i] = back;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const w = g * x + h * y + i;
      const sx = (a * x + b * y + c) / w;
      const sy = (d * x + e * y + f) / w;
      const k = (y * out.width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        o[k] = o[k + 1] = o[k + 2] = 255;
        o[k + 3] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const p00 = (y0 * sw + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + sw * 4;
      const p11 = p01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = s[p00 + ch] + (s[p10 + ch] - s[p00 + ch]) * fx;
        const bottom = s[p01 + ch] + (s[p11 + ch] - s[p01 + ch]) * fx;
        o[k + ch] = top + (bottom - top) * fy;
      }
      o[k + 3] = 255;
    }
  }
}
