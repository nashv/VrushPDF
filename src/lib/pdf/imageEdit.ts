/**
 * Blank regions of a JPEG, for redacting part of a scanned page image.
 *
 * Browser-only: the webview decodes and re-encodes the JPEG on a canvas, which
 * the Node-loadable redaction engine (`annotations/redact.ts`) can't do. The
 * result is always an RGB JPEG; the engine updates the image's colour space.
 */
import type { ImageEditJob } from "$lib/annotations/redact";

/** High enough that the rest of the scan doesn't visibly degrade. */
const QUALITY = 0.92;

export async function blankJpegRegions(job: ImageEditJob): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([job.bytes as BlobPart], { type: "image/jpeg" }));
    if (bitmap.width !== job.width || bitmap.height !== job.height) {
      bitmap.close();
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = job.width;
    canvas.height = job.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const [r, g, b] = job.fill.map((v) => Math.round(v * 255));
    ctx.fillStyle = `rgb(${r} ${g} ${b})`;
    for (const region of job.regions) ctx.fillRect(region.x, region.y, region.w, region.h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    // Undecodable here (e.g. an unusual JPEG variant): the engine removes the image instead.
    return null;
  }
}
