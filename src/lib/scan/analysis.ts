/**
 * Measuring a scanned page: how far its text is tilted, and where the paper's
 * corners are in a photo of it.
 *
 * Pure functions over a grayscale buffer, with no DOM, so `verify:roundtrip`
 * can check them under Node against synthetic images.
 */

/** An 8-bit grayscale image, row-major, 0 black to 255 white. */
export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A corner in normalised page coordinates: 0..1 across, 0..1 down. */
export interface NormPoint {
  x: number;
  y: number;
}

/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type NormQuad = [NormPoint, NormPoint, NormPoint, NormPoint];

/** Luma from RGBA, as a canvas `ImageData` holds it. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { width, height, data };
}

/** Otsu's threshold: the gray level that best splits ink from paper. */
export function otsu(gray: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray.data) hist[v]++;
  const total = gray.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Enough ink pixels to measure from; more only costs time. */
const MAX_SAMPLES = 80_000;

/**
 * Tilt of the text on a page, in degrees. Positive means lines rise to the
 * right (turned anticlockwise), so turning the image clockwise by this much
 * straightens it.
 *
 * Projection profiles: shear the ink pixels by a candidate angle and count
 * them per row. At the true angle each text line collapses onto a few rows,
 * so the sum of squared row counts peaks. A coarse sweep finds the peak, a
 * fine one pins it down.
 */
export function detectSkew(gray: Gray, maxDegrees = 10): number {
  const { width, height, data } = gray;
  const threshold = otsu(gray);
  // Ink is the dark side of the split, the threshold level included; a
  // near-blank page has nothing to measure.
  const xs: number[] = [];
  const ys: number[] = [];
  let ink = 0;
  for (const v of data) if (v <= threshold) ink++;
  if (ink < 200) return 0;
  const stride = Math.max(1, Math.floor(ink / MAX_SAMPLES));
  let seen = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] <= threshold && seen++ % stride === 0) {
        xs.push(x - width / 2);
        ys.push(y);
      }
    }
  }

  const span = height + width;
  const bins = new Float64Array(span * 2);
  const score = (degrees: number) => {
    const t = Math.tan((degrees * Math.PI) / 180);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      // A line rising to the right has y = y0 - x·tanθ; adding x·tanθ undoes it.
      bins[Math.round(ys[i] + xs[i] * t) + span]++;
    }
    let s = 0;
    for (const b of bins) s += b * b;
    return s;
  };

  let best = 0;
  let bestScore = -1;
  for (let a = -maxDegrees; a <= maxDegrees + 1e-9; a += 0.25) {
    const s = score(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  const coarse = best;
  for (let a = coarse - 0.25; a <= coarse + 0.25 + 1e-9; a += 0.05) {
    const s = score(a);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return Math.round(best * 100) / 100;
}

/**
 * The paper's corners in a photo of a document, or null when there is no
 * clear sheet against a background (a flatbed scan, where the paper fills the
 * frame, or a cluttered photo).
 *
 * The sheet is taken to be the largest connected region on the bright side of
 * the Otsu split; its corners are its extreme points along the diagonals.
 * Fine on paper against a darker desk, which is the common case; anything
 * else falls back to the user dragging the corners.
 */
export function detectDocumentQuad(gray: Gray): NormQuad | null {
  const { width, height, data } = gray;
  const threshold = otsu(gray);
  const bright = new Uint8Array(width * height);
  for (let i = 0; i < bright.length; i++) bright[i] = data[i] > threshold ? 1 : 0;

  // Largest 4-connected bright component, by flood fill.
  const label = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  let bestLabel = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || label[start]) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = next;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const n of neighbours) {
        if (n >= 0 && n < bright.length && bright[n] && !label[n]) {
          label[n] = next;
          queue[tail++] = n;
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestLabel = next;
    }
  }

  // A speck isn't a page.
  if (bestSize / (width * height) < 0.15) return null;

  let tl = { x: 0, y: 0, k: Infinity };
  let br = { x: 0, y: 0, k: -Infinity };
  let tr = { x: 0, y: 0, k: -Infinity };
  let bl = { x: 0, y: 0, k: Infinity };
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x + y < tl.k) tl = { x, y, k: x + y };
    if (x + y > br.k) br = { x, y, k: x + y };
    if (x - y > tr.k) tr = { x, y, k: x - y };
    if (x - y < bl.k) bl = { x, y, k: x - y };
  }
  const norm = (p: { x: number; y: number }): NormPoint => ({ x: (p.x + 0.5) / width, y: (p.y + 0.5) / height });
  const quad: NormQuad = [norm(tl), norm(tr), norm(br), norm(bl)];
  // Corners on the frame's own corners: the paper fills the picture (a
  // flatbed scan), so there's no separate sheet to straighten.
  const frame: NormPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  if (quad.every((c, i) => Math.hypot(c.x - frame[i].x, c.y - frame[i].y) < 0.02)) return null;
  return quad;
}
