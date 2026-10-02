<script lang="ts">
  /**
   * SVG rendering of a page's annotations.
   *
   * Children are drawn directly in PDF user space and the viewport matrix is
   * applied once on the root `<g>`, so one transform handles zoom, page
   * rotation and the Y-flip — and stroke widths, being PDF units, scale with
   * the page automatically.
   *
   * Highlights live in their own layer with `mix-blend-mode: multiply` applied
   * to the whole layer. Blending a single SVG child against the canvas below is
   * not reliable across stacking contexts; blending a whole sibling layer is.
   */
  import type { PageViewport } from "pdfjs-dist";
  import { stampMatrix } from "$lib/annotations/appearance";
  import {
    annotBounds,
    isBoxShape,
    isInk,
    isLineShape,
    isStamp,
    isTextMarkup,
    rectFromQuad,
    type Annot,
    type Point,
    type Quad,
  } from "$lib/annotations/types";
  import { svgMatrix } from "$lib/pdf/render";
  import { images } from "$lib/state/images.svelte";
  import type { SearchMatch } from "$lib/pdf/search";

  let {
    annots,
    viewport,
    selectedId = null,
    searchMatches = [],
    activeMatch = null,
    preview = null,
  }: {
    annots: Annot[];
    viewport: PageViewport;
    selectedId?: string | null;
    searchMatches?: SearchMatch[];
    activeMatch?: SearchMatch | null;
    /** In-progress annotation being dragged out, drawn but not yet committed. */
    preview?: Annot | null;
  } = $props();

  const matrix = $derived(svgMatrix(viewport));
  const all = $derived(preview ? [...annots, preview] : annots);

  const highlights = $derived(all.filter((a) => a.kind === "highlight"));
  const rest = $derived(all.filter((a) => a.kind !== "highlight"));

  /** Closed polygon through a quad: upper-left, upper-right, lower-right, lower-left. */
  function quadPath(q: Quad): string {
    return `M${q.x1} ${q.y1}L${q.x2} ${q.y2}L${q.x4} ${q.y4}L${q.x3} ${q.y3}Z`;
  }

  const quadsPath = (quads: Quad[]) => quads.map(quadPath).join(" ");

  function polyline(points: Point[]): string {
    if (points.length === 0) return "";
    if (points.length === 1) {
      // Render a lone tap as a tiny dash so round caps make it a dot.
      const p = points[0];
      return `M${p.x} ${p.y}L${p.x + 0.01} ${p.y}`;
    }
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  }

  const inkPath = (paths: Point[][]) => paths.map(polyline).join(" ");

  /** Underline / strikeout / squiggly geometry, matching `appearance.ts`. */
  function markupPath(annot: Annot): string {
    if (!isTextMarkup(annot)) return "";
    const segments: string[] = [];

    for (const quad of annot.quads) {
      const r = rectFromQuad(quad);
      if (annot.kind === "squiggly") {
        const amplitude = Math.max(r.h * 0.1, 1);
        const period = Math.max(amplitude * 2, 3);
        const baseline = r.y + amplitude;
        const pts: Point[] = [{ x: r.x, y: baseline }];
        let up = true;
        for (let x = r.x + period / 2; x < r.x + r.w; x += period / 2) {
          pts.push({ x, y: baseline + (up ? amplitude : -amplitude) });
          up = !up;
        }
        segments.push(polyline(pts));
      } else {
        const y = annot.kind === "underline" ? r.y + r.h * 0.08 : r.y + r.h * 0.45;
        segments.push(`M${r.x} ${y}L${r.x + r.w} ${y}`);
      }
    }
    return segments.join(" ");
  }

  const markupWidth = (annot: Annot) => {
    if (!isTextMarkup(annot) || annot.quads.length === 0) return 1;
    return Math.max(rectFromQuad(annot.quads[0]).h * 0.07, 0.6);
  };

  /** Filled arrowhead at `to`, matching `appearance.ts`. */
  function arrowHeadPath(from: Point, to: Point, width: number): string {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return "";
    const ux = dx / len;
    const uy = dy / len;
    const head = Math.max(width * 4, 6);
    const half = head * 0.45;
    const bx = to.x - ux * head;
    const by = to.y - uy * head;
    return `M${to.x} ${to.y}L${bx - uy * half} ${by + ux * half}L${bx + uy * half} ${by - ux * half}Z`;
  }

  /** Shaft shortened so the arrowhead tip stays sharp. */
  function shaftEnd(from: Point, to: Point, width: number): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const head = Math.max(width * 4, 6);
    const stop = Math.max(len - head * 0.9, 0);
    return { x: from.x + (dx / len) * stop, y: from.y + (dy / len) * stop };
  }

  /**
   * Unit square -> stamp rect, plus a Y-flip because SVG `<image>` puts row 0 at
   * its local y=0 while PDF image space puts it at y=1.
   */
  function stampTransform(annot: Annot): string {
    if (!isStamp(annot)) return "";
    return `matrix(${stampMatrix(annot.rect, annot.rotation).join(" ")}) translate(0 1) scale(1 -1)`;
  }

  const stampUrl = (imageId: string) => images.get(imageId)?.url ?? null;
</script>

<!-- Highlights: separate layer so multiply blends against the page canvas. -->
<svg class="layer highlight-layer" aria-hidden="true">
  <g transform={matrix}>
    {#each highlights as annot (annot.id)}
      {#if isTextMarkup(annot)}
        <path
          d={quadsPath(annot.quads)}
          fill={annot.color}
          fill-opacity={annot.opacity}
          fill-rule="nonzero"
        />
      {/if}
    {/each}
  </g>
</svg>

<svg class="layer annot-layer" aria-hidden="true">
  <g transform={matrix}>
    <!-- Search hits sit under the annotations so marks stay readable. -->
    {#each searchMatches as match, i (i)}
      {@const isActive = match === activeMatch}
      {#each match.rects as r, j (j)}
        <rect
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill={isActive ? "#f97316" : "#facc15"}
          fill-opacity={isActive ? 0.55 : 0.35}
        />
      {/each}
    {/each}

    {#each rest as annot (annot.id)}
      {@const selected = annot.id === selectedId}
      <g opacity={annot.opacity} class:selected>
        {#if isTextMarkup(annot)}
          <path
            d={markupPath(annot)}
            fill="none"
            stroke={annot.color}
            stroke-width={markupWidth(annot)}
            stroke-linecap="round"
          />
        {:else if isInk(annot)}
          <path
            d={inkPath(annot.paths)}
            fill="none"
            stroke={annot.color}
            stroke-width={annot.width}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        {:else if isBoxShape(annot) && annot.kind === "square"}
          <rect
            x={annot.rect.x + annot.width / 2}
            y={annot.rect.y + annot.width / 2}
            width={Math.max(annot.rect.w - annot.width, 0.1)}
            height={Math.max(annot.rect.h - annot.width, 0.1)}
            fill={annot.fill ?? "none"}
            stroke={annot.width > 0 ? annot.color : "none"}
            stroke-width={annot.width}
          />
        {:else if isBoxShape(annot)}
          <ellipse
            cx={annot.rect.x + annot.rect.w / 2}
            cy={annot.rect.y + annot.rect.h / 2}
            rx={Math.max((annot.rect.w - annot.width) / 2, 0.1)}
            ry={Math.max((annot.rect.h - annot.width) / 2, 0.1)}
            fill={annot.fill ?? "none"}
            stroke={annot.width > 0 ? annot.color : "none"}
            stroke-width={annot.width}
          />
        {:else if isLineShape(annot)}
          {@const end = annot.kind === "arrow" ? shaftEnd(annot.from, annot.to, annot.width) : annot.to}
          <line
            x1={annot.from.x}
            y1={annot.from.y}
            x2={end.x}
            y2={end.y}
            stroke={annot.color}
            stroke-width={annot.width}
            stroke-linecap="round"
          />
          {#if annot.kind === "arrow"}
            <path d={arrowHeadPath(annot.from, annot.to, annot.width)} fill={annot.color} />
          {/if}
        {:else if annot.kind === "freetext"}
          <!-- Box only; the text itself is HTML in the widget layer. -->
          <rect
            x={annot.rect.x}
            y={annot.rect.y}
            width={annot.rect.w}
            height={annot.rect.h}
            fill={annot.bgColor ?? (annot === preview ? "rgb(37 99 235 / 12%)" : "none")}
            stroke={annot.borderColor ?? (annot === preview ? "var(--accent)" : "none")}
            stroke-width={annot.borderColor ? annot.borderWidth : (annot === preview ? 1.5 : 0)}
            stroke-dasharray={annot === preview && !annot.borderColor ? "4 3" : undefined}
          />
          {#if annot === preview}
            <!-- Text cursor indicator inside the dragging text box preview -->
            <line
              x1={annot.rect.x + (annot.padding ?? 2) + 2}
              y1={annot.rect.y + (annot.padding ?? 2) + 2}
              x2={annot.rect.x + (annot.padding ?? 2) + 2}
              y2={annot.rect.y + (annot.padding ?? 2) + 2 + Math.min(annot.fontSize, Math.max(annot.rect.h - 6, 8))}
              stroke="var(--accent)"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          {/if}
        {:else if isStamp(annot)}
          {@const url = stampUrl(annot.imageId)}
          {#if url}
            <image
              href={url}
              width="1"
              height="1"
              transform={stampTransform(annot)}
              preserveAspectRatio="none"
            />
          {:else}
            <!-- Image unavailable (e.g. a stamp pasted in a previous run). -->
            {@const b = annotBounds(annot)}
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              fill="none"
              stroke="var(--danger)"
              stroke-width="1"
              stroke-dasharray="4 3"
            />
          {/if}
        {/if}
      </g>
    {/each}
  </g>
</svg>

<style>
  .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* Hit-testing is geometric, done against the model in PageView. */
    pointer-events: none;
    overflow: visible;
  }

  .highlight-layer {
    mix-blend-mode: multiply;
    z-index: 1;
  }

  .annot-layer {
    z-index: 3;
  }
</style>
