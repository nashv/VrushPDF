/** Canvas rendering and the viewport maths shared by the page and thumbnail views. */
import { pdfjs, type PDFPageProxy } from "./pdfjs";
import type { PageViewport } from "pdfjs-dist";
import type { Point, Rect, Rotation } from "$lib/annotations/types";

/**
 * Retina rendering is capped: beyond 2x the memory cost of a full-page canvas
 * grows faster than the visible sharpness.
 */
const MAX_PIXEL_RATIO = 2;

export const pixelRatio = () => Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO);

/**
 * Total rotation for a page: the page's own `/Rotate` plus whatever the user
 * has applied in the app.
 */
export function totalRotation(page: PDFPageProxy, extra: Rotation): number {
  return (((page.rotate + extra) % 360) + 360) % 360;
}

export function viewportFor(page: PDFPageProxy, scale: number, extra: Rotation): PageViewport {
  return page.getViewport({ scale, rotation: totalRotation(page, extra) });
}

/** Unrotated page size in points — the space annotations are stored in. */
export function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const [x1, y1, x2, y2] = page.view;
  return { width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export class RenderCancelled extends Error {}

/**
 * A single-slot render queue for one canvas. Starting a new render cancels the
 * one in flight, which is what makes continuous zooming and fast scrolling
 * cheap instead of piling up work.
 */
export class PageRenderer {
  #task: ReturnType<PDFPageProxy["render"]> | null = null;

  async render(page: PDFPageProxy, canvas: HTMLCanvasElement, viewport: PageViewport) {
    this.cancel();

    const ratio = pixelRatio();
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));

    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Establish an opaque backing store before pdf.js takes the context, so
    // compositing skips the alpha channel.
    if (!canvas.getContext("2d", { alpha: false })) {
      throw new Error("could not acquire a 2D canvas context");
    }

    const task = page.render({
      canvas,
      viewport,
      background: "#ffffff",
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      // ENABLE_STORAGE lets `annotationStorage` suppress individual annotations.
      // Anything we imported into our own model is marked `noView` (see
      // `annotations/import.ts`) and drawn by our overlay instead; anything we
      // could not represent keeps rendering straight from the file.
      annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
    });
    this.#task = task;

    try {
      await task.promise;
    } catch (err) {
      if (err instanceof pdfjs.RenderingCancelledException) throw new RenderCancelled();
      throw err;
    } finally {
      if (this.#task === task) this.#task = null;
    }
  }

  cancel() {
    this.#task?.cancel();
    this.#task = null;
  }
}

// ------------------------------------------------------- coordinate conversion

/** Viewport (CSS px, origin top-left) -> PDF user space (origin bottom-left). */
export function toPdfPoint(viewport: PageViewport, x: number, y: number): Point {
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return { x: px, y: py };
}

/** PDF user space -> viewport CSS px. */
export function toViewportPoint(viewport: PageViewport, p: Point): Point {
  const [x, y] = viewport.convertToViewportPoint(p.x, p.y);
  return { x, y };
}

/**
 * PDF-space rect -> viewport CSS-px box. Both corners are converted and then
 * normalised, because rotation can flip either axis.
 */
export function toViewportRect(
  viewport: PageViewport,
  r: Rect,
): { left: number; top: number; width: number; height: number } {
  const a = toViewportPoint(viewport, { x: r.x, y: r.y });
  const b = toViewportPoint(viewport, { x: r.x + r.w, y: r.y + r.h });
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** `viewport.transform` as an SVG `matrix(...)`, mapping PDF space to the overlay. */
export function svgMatrix(viewport: PageViewport): string {
  return `matrix(${viewport.transform.join(" ")})`;
}

/**
 * How many PDF points one CSS pixel covers. Used to keep hit-test slop and
 * selection handles a constant on-screen size across zoom levels.
 */
export function pdfPerCssPixel(viewport: PageViewport): number {
  return 1 / viewport.scale;
}

// ------------------------------------------------------------------ thumbnails

/** Render a page to a PNG blob URL. Caller owns the URL and must revoke it. */
export async function renderThumbnail(page: PDFPageProxy, extra: Rotation, maxEdge = 200) {
  const base = viewportFor(page, 1, extra);
  const scale = maxEdge / Math.max(base.width, base.height);
  const viewport = viewportFor(page, scale, extra);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  if (!canvas.getContext("2d", { alpha: false })) {
    throw new Error("could not acquire a 2D canvas context");
  }

  await page.render({
    canvas,
    viewport,
    background: "#ffffff",
    annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
  }).promise;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not encode thumbnail");
  return {
    url: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
  };
}
