<script lang="ts">
  /**
   * Corner handles for perspective correction, over one page.
   *
   * The corners start on the paper's edges when `detectCorners` finds them
   * (a photo of a sheet on a desk), otherwise just inside the page. The user
   * drags them onto the document's corners and applies; everything outside
   * the marked shape is dimmed so it is clear what will be kept.
   */
  import type { NormPoint, NormQuad } from "$lib/scan/analysis";
  import { loadOcrLanguages } from "$lib/ocr/engine";
  import Icon from "./Icon.svelte";

  let {
    width,
    height,
    detect,
    onApply,
    onCancel,
  }: {
    /** The page box on screen, in CSS px. */
    width: number;
    height: number;
    /** Finds the paper's corners, or null when it can't tell. */
    detect: () => Promise<NormQuad | null>;
    onApply: (quad: NormQuad, options: { reOcr: boolean; langs: ReturnType<typeof loadOcrLanguages> }) => void;
    onCancel: () => void;
  } = $props();

  const INSET = 0.06;
  const fallback = (): NormQuad => [
    { x: INSET, y: INSET },
    { x: 1 - INSET, y: INSET },
    { x: 1 - INSET, y: 1 - INSET },
    { x: INSET, y: 1 - INSET },
  ];

  let quad = $state<NormQuad>(fallback());
  let detecting = $state(true);
  let found = $state(false);
  let reOcr = $state(true);
  let dragging = $state<number | null>(null);

  $effect(() => {
    let alive = true;
    detect()
      .then((corners) => {
        if (!alive) return;
        if (corners) {
          quad = corners;
          found = true;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) detecting = false;
      });
    return () => {
      alive = false;
    };
  });

  const px = (p: NormPoint) => ({ x: p.x * width, y: p.y * height });
  const polygon = $derived(quad.map((p) => `${p.x * width},${p.y * height}`).join(" "));
  const LABELS = ["top-left", "top-right", "bottom-right", "bottom-left"];

  function onHandleDown(event: PointerEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = index;
  }

  function onHandleMove(event: PointerEvent, index: number) {
    if (dragging !== index) return;
    const box = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    const next = [...quad] as NormQuad;
    next[index] = { x, y };
    quad = next;
  }

  /** Arrow keys nudge a focused corner: 1 px, or 10 with Shift. */
  function onHandleKey(event: KeyboardEvent, index: number) {
    const step = (event.shiftKey ? 10 : 1);
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = [...quad] as NormQuad;
    next[index] = {
      x: Math.min(1, Math.max(0, quad[index].x + delta[0] / width)),
      y: Math.min(1, Math.max(0, quad[index].y + delta[1] / height)),
    };
    quad = next;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      onApply(quad, { reOcr, langs: loadOcrLanguages() });
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="perspective" role="group" aria-label="Perspective correction">
  <svg class="shade" width={width} height={height} aria-hidden="true">
    <defs>
      <mask id="keep">
        <rect width={width} height={height} fill="white" />
        <polygon points={polygon} fill="black" />
      </mask>
    </defs>
    <rect width={width} height={height} fill="rgb(0 0 0 / 45%)" mask="url(#keep)" />
    <polygon points={polygon} fill="none" stroke="var(--accent)" stroke-width="2" />
  </svg>

  {#each quad as corner, i (i)}
    {@const p = px(corner)}
    <button
      type="button"
      class="corner"
      class:dragging={dragging === i}
      style:left="{p.x}px"
      style:top="{p.y}px"
      aria-label="Move the {LABELS[i]} corner"
      onpointerdown={(event) => onHandleDown(event, i)}
      onpointermove={(event) => onHandleMove(event, i)}
      onpointerup={() => (dragging = null)}
      onpointercancel={() => (dragging = null)}
      onkeydown={(event) => onHandleKey(event, i)}
    ></button>
  {/each}

  <div class="bar" role="toolbar" aria-label="Perspective correction">
    <Icon name="perspective" />
    <span class="hint">
      {#if detecting}
        Looking for the document's edges…
      {:else if found}
        Check the corners sit on the document's corners.
      {:else}
        Drag the corners onto the document's corners.
      {/if}
    </span>
    <label class="ocr">
      <input type="checkbox" bind:checked={reOcr} />
      Recognise text
    </label>
    <button class="btn" onclick={onCancel}>Cancel</button>
    <button class="btn primary" onclick={() => onApply(quad, { reOcr, langs: loadOcrLanguages() })}>Apply</button>
  </div>
</div>

<style>
  .perspective {
    position: absolute;
    inset: 0;
    z-index: 20;
  }

  .shade {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .corner {
    position: absolute;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    padding: 0;
    border: 2px solid var(--accent);
    border-radius: 50%;
    background: var(--bg-raised);
    box-shadow: var(--shadow-2);
    cursor: move;
    touch-action: none;
  }

  /* A larger target than the dot itself. */
  .corner::before {
    content: "";
    position: absolute;
    inset: -8px;
  }

  .corner.dragging,
  .corner:focus-visible {
    background: var(--accent);
  }

  .bar {
    position: absolute;
    top: 10px;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    transform: translateX(-50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
    color: var(--text);
    white-space: nowrap;
  }

  .hint {
    color: var(--text-muted);
    font-size: 12px;
  }

  .ocr {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
</style>
