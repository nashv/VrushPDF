/**
 * The built-in stamps.
 *
 * Drawn to a canvas and handed to the image store as PNG bytes rather than
 * shipped as asset files: `annotations/write.ts` embeds every stamp as an image
 * XObject, so a stamp has to be raster whatever its origin, and generating them
 * keeps the bundle free of binary blobs that would need regenerating by hand to
 * change a colour.
 *
 * Browser-only (it needs a canvas), which is why this sits outside
 * `annotations/` — that directory has to stay loadable under plain Node for
 * `verify:roundtrip`.
 */

export interface StandardStamp {
  id: string;
  label: string;
  color: string;
}

/** The set Acrobat users expect to find. */
export const STANDARD_STAMPS: StandardStamp[] = [
  { id: "approved", label: "APPROVED", color: "#15803d" },
  { id: "reviewed", label: "REVIEWED", color: "#1d4ed8" },
  { id: "draft", label: "DRAFT", color: "#525252" },
  { id: "confidential", label: "CONFIDENTIAL", color: "#b91c1c" },
  { id: "final", label: "FINAL", color: "#6d28d9" },
];

const HEIGHT = 200;
const FONT_SIZE = 92;
const PADDING = 46;
const BORDER = 9;

/**
 * Render one stamp to PNG bytes.
 *
 * The width follows the text, so CONFIDENTIAL comes out wider than FINAL rather
 * than squeezed into a common box — the aspect ratio is what the placement code
 * uses to size the annotation.
 */
export async function renderStandardStamp(stamp: StandardStamp): Promise<Uint8Array> {
  const font = `bold ${FONT_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("no 2d canvas context");
  measure.font = font;
  const textWidth = measure.measureText(stamp.label).width;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textWidth + PADDING * 2);
  canvas.height = HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");

  // Transparent background: a stamp sits over the page, it does not mask it.
  ctx.strokeStyle = stamp.color;
  ctx.fillStyle = stamp.color;
  ctx.lineWidth = BORDER;
  ctx.beginPath();
  ctx.roundRect(
    BORDER / 2,
    BORDER / 2,
    canvas.width - BORDER,
    canvas.height - BORDER,
    22,
  );
  ctx.stroke();

  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(stamp.label, canvas.width / 2, canvas.height / 2 + 4);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`could not encode the ${stamp.label} stamp`);
  return new Uint8Array(await blob.arrayBuffer());
}
