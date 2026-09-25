/**
 * Inferring paragraphs from positioned text.
 *
 * PDF has no notion of a paragraph — a page is a bag of absolutely positioned
 * runs — so blocks have to be guessed from geometry. Every rule here is a
 * heuristic, and the places they break are predictable: multi-column layouts,
 * tables, and text set on a curve or rotated.
 *
 * Typed against a plain shape rather than pdf.js's `TextItem` on purpose: the
 * pdf.js build is browser-only, and keeping this pure means the grouping can be
 * tested under Node with synthetic input.
 */

export interface TextRun {
  text: string;
  /** Baseline origin, PDF space: y increases upward. */
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

export interface Line {
  runs: TextRun[];
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

export interface Block {
  lines: Line[];
  text: string;
  /** Bounding box in PDF space. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/** Baselines within this fraction of the font size count as the same line. */
const LINE_TOLERANCE = 0.4;
/** A gap wider than this many times the font size ends the block. */
const MAX_LEADING = 2.0;
/** Left edges within this many points are "aligned". */
const INDENT_TOLERANCE = 12;
/** Font sizes within this ratio belong together. */
const SIZE_RATIO = 1.25;
/**
 * A horizontal gap wider than this many times the font size is a gutter, not a
 * space — runs either side of it are in different columns even if they share a
 * baseline. This is also what splits widely-spaced table cells, which is the
 * known cost of the rule.
 */
const COLUMN_GAP = 3;

export function groupLines(runs: TextRun[]): Line[] {
  const usable = runs.filter((r) => r.text.trim().length > 0);
  if (usable.length === 0) return [];

  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];

  for (const run of sorted) {
    const line = lines.at(-1);
    const tolerance = Math.max(run.fontSize, line?.fontSize ?? 0) * LINE_TOLERANCE;
    const previous = line?.runs.at(-1);
    // Same baseline is not enough: a gutter-sized gap means another column.
    const reachable =
      previous !== undefined &&
      run.x - (previous.x + previous.width) <= run.fontSize * COLUMN_GAP;

    if (line && reachable && Math.abs(line.y - run.y) <= tolerance) {
      line.runs.push(run);
      continue;
    }
    lines.push({ runs: [run], text: "", x: 0, y: run.y, width: 0, fontSize: run.fontSize });
  }

  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.x = Math.min(...line.runs.map((r) => r.x));
    line.width = Math.max(...line.runs.map((r) => r.x + r.width)) - line.x;
    line.fontSize = Math.max(...line.runs.map((r) => r.fontSize));
    // Runs inside a line are usually kerning fragments, so join without spaces
    // unless the gap is wide enough to be a real space.
    line.text = line.runs
      .map((run, i) => {
        const previous = line.runs[i - 1];
        if (!previous) return run.text;
        const gap = run.x - (previous.x + previous.width);
        return (gap > run.fontSize * 0.2 ? " " : "") + run.text;
      })
      .join("");
  }

  return lines;
}

export function groupBlocks(lines: Line[]): Block[] {
  /*
   * Not a linear scan down the page: with two columns the next line in reading
   * order belongs to the *other* column. Instead each block starts at the
   * topmost unused line and grows downward through lines that overlap it
   * horizontally, which follows one column at a time.
   */
  const remaining = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const blocks: Block[] = [];

  const joins = (previous: Line, candidate: Line) => {
    const gap = previous.y - candidate.y;
    const size = Math.max(previous.fontSize, candidate.fontSize);
    const overlaps =
      candidate.x < previous.x + previous.width && previous.x < candidate.x + candidate.width;
    const sameSize =
      Math.max(previous.fontSize, candidate.fontSize) /
        Math.min(previous.fontSize, candidate.fontSize) <=
      SIZE_RATIO;
    const aligned = Math.abs(candidate.x - previous.x) <= INDENT_TOLERANCE;
    return gap > 0 && gap <= size * MAX_LEADING && overlaps && sameSize && aligned;
  };

  while (remaining.length > 0) {
    const group = [remaining.shift()!];

    for (;;) {
      const previous = group.at(-1)!;
      const index = remaining.findIndex((candidate) => joins(previous, candidate));
      if (index === -1) break;
      group.push(remaining.splice(index, 1)[0]);
    }

    const x = Math.min(...group.map((l) => l.x));
    const right = Math.max(...group.map((l) => l.x + l.width));
    const fontSize = Math.max(...group.map((l) => l.fontSize));
    const top = Math.max(...group.map((l) => l.y)) + fontSize;
    const bottom = Math.min(...group.map((l) => l.y));

    blocks.push({
      lines: group,
      text: group.map((l) => l.text).join(" "),
      x,
      y: bottom,
      width: right - x,
      height: top - bottom,
      fontSize,
    });
  }

  return blocks;
}

export const detectBlocks = (runs: TextRun[]): Block[] => groupBlocks(groupLines(runs));
