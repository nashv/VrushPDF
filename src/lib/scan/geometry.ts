/**
 * Plane geometry for page correction: rotations about the centre and the
 * projective transform (homography) that maps a photographed quadrilateral
 * onto a rectangle. Pure and DOM-free, for `verify:roundtrip`.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A 3x3 matrix, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Apply a homography to a point. */
export function project(h: Mat3, p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

/**
 * The homography taking each `from[i]` to `to[i]`, by solving the standard
 * 8x8 system with Gaussian elimination. Null for a degenerate quad (three
 * corners in a line).
 */
export function homography(from: Pt[], to: Pt[]): Mat3 | null {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  const h = a.map((row, i) => row[n] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Turn `p` clockwise (on screen, y down) by `degrees` about `centre`: what
 * the canvas's `rotate()` does, and so where a point ends up when a page
 * image is straightened that way.
 */
export function rotateAbout(p: Pt, centre: Pt, degrees: number): Pt {
  const t = (degrees * Math.PI) / 180;
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return {
    x: centre.x + dx * Math.cos(t) - dy * Math.sin(t),
    y: centre.y + dx * Math.sin(t) + dy * Math.cos(t),
  };
}

const distance = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Standard sheets, short side first, in points. */
const SHEETS = [
  { w: 595.28, h: 841.89 }, // A4
  { w: 612, h: 792 }, // US Letter
  { w: 612, h: 1008 }, // US Legal
];

/**
 * Page size, in points, for a document photographed as `quad` (corners in
 * points as measured on the photo page). The quad's mean side lengths give
 * the sheet's shape; it snaps to A4, Letter or Legal when within 4% of one,
 * and is otherwise scaled so its long side is 11 inches.
 */
export function sheetSizeFor(quad: Pt[]): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const w = (distance(tl, tr) + distance(bl, br)) / 2;
  const h = (distance(tl, bl) + distance(tr, br)) / 2;
  const portrait = h >= w;
  const ratio = portrait ? h / w : w / h;
  for (const sheet of SHEETS) {
    if (Math.abs(ratio / (sheet.h / sheet.w) - 1) < 0.04) {
      return portrait ? { width: sheet.w, height: sheet.h } : { width: sheet.h, height: sheet.w };
    }
  }
  const long = 792;
  return portrait ? { width: long / ratio, height: long } : { width: long, height: long / ratio };
}
