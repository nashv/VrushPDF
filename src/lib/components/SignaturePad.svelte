<script lang="ts">
  /**
   * Draw-once signature capture.
   *
   * The stroke is rasterised to a transparent PNG and trimmed to its ink, so the
   * saved image has no dead margin and lands on the page at a sensible aspect
   * ratio.
   */
  import { images } from "$lib/state/images.svelte";
  import { session } from "$lib/state/session.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import Icon from "./Icon.svelte";

  let { onClose }: { onClose: () => void } = $props();

  /** Backing-store resolution. Generous, because signatures get scaled up. */
  const W = 1000;
  const H = 320;
  const INK_WIDTH = 4;

  let canvasEl: HTMLCanvasElement | undefined = $state();
  let name = $state("Signature");
  let colour = $state("#12263f");
  let strokes = $state.raw<{ x: number; y: number }[][]>([]);
  let drawing = false;
  let saving = $state(false);

  const hasInk = $derived(strokes.some((s) => s.length > 0));

  function redraw() {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = colour;
    ctx.lineWidth = INK_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      if (stroke.length === 1) {
        // A dot: a zero-length stroke with a round cap.
        ctx.moveTo(stroke[0].x, stroke[0].y);
        ctx.lineTo(stroke[0].x + 0.01, stroke[0].y);
      } else {
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  $effect(redraw);

  function at(event: PointerEvent) {
    const canvas = canvasEl;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * W,
      y: ((event.clientY - box.top) / box.height) * H,
    };
  }

  function onDown(event: PointerEvent) {
    if (event.button !== 0) return;
    drawing = true;
    canvasEl?.setPointerCapture(event.pointerId);
    strokes = [...strokes, [at(event)]];
  }

  function onMove(event: PointerEvent) {
    if (!drawing) return;
    const last = strokes[strokes.length - 1];
    strokes = [...strokes.slice(0, -1), [...last, at(event)]];
  }

  function onUp() {
    drawing = false;
  }

  function clear() {
    strokes = [];
  }

  function undoStroke() {
    strokes = strokes.slice(0, -1);
  }

  /** Bounding box of the ink, padded, so the PNG has no empty border. */
  function inkBounds() {
    const points = strokes.flat();
    if (points.length === 0) return null;
    const pad = INK_WIDTH * 2;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const left = Math.max(Math.min(...xs) - pad, 0);
    const top = Math.max(Math.min(...ys) - pad, 0);
    return {
      left,
      top,
      width: Math.min(Math.max(...xs) + pad, W) - left,
      height: Math.min(Math.max(...ys) + pad, H) - top,
    };
  }

  async function save() {
    const canvas = canvasEl;
    const bounds = inkBounds();
    if (!canvas || !bounds || bounds.width < 1 || bounds.height < 1) return;

    saving = true;
    try {
      const trimmed = document.createElement("canvas");
      trimmed.width = Math.round(bounds.width);
      trimmed.height = Math.round(bounds.height);
      const ctx = trimmed.getContext("2d");
      if (!ctx) throw new Error("could not acquire a 2D canvas context");

      ctx.drawImage(
        canvas,
        bounds.left, bounds.top, bounds.width, bounds.height,
        0, 0, trimmed.width, trimmed.height,
      );

      const blob = await new Promise<Blob | null>((resolve) =>
        trimmed.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("could not encode the signature");

      const png = new Uint8Array(await blob.arrayBuffer());
      const saved = await images.saveSignature(name.trim() || "Signature", png);

      // Arm it immediately — drawing a signature means wanting to place it.
      viewer.setTool("signature");
      viewer.pendingStamp = saved.id;
      session.notify("Signature saved. Click the page to place it.");
      onClose();
    } catch (err) {
      session.notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      saving = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="Close"
  onclick={onClose}
  onkeydown={() => {}}
></div>

<div class="dialog" role="dialog" aria-modal="true" aria-label="Draw a signature">
  <h2>Draw your signature</h2>
  <p class="muted">Sign in the box below. It's saved so you can reuse it in any document.</p>

  <div class="pad">
    <canvas
      bind:this={canvasEl}
      width={W}
      height={H}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
    ></canvas>
    <div class="baseline" aria-hidden="true"></div>
    {#if !hasInk}
      <span class="hint">Sign here</span>
    {/if}
  </div>

  <div class="controls">
    <label class="ink">
      Ink
      <input type="color" bind:value={colour} aria-label="Ink colour" />
    </label>
    <label class="named">
      Name
      <input class="field" type="text" bind:value={name} />
    </label>
    <span class="spacer"></span>
    <button class="btn" disabled={!hasInk} onclick={undoStroke}>
      <Icon name="undo" /> Undo
    </button>
    <button class="btn" disabled={!hasInk} onclick={clear}>Clear</button>
  </div>

  <footer>
    <button class="btn outlined" onclick={onClose}>Cancel</button>
    <button class="btn primary" disabled={!hasInk || saving} onclick={save}>
      {saving ? "Saving…" : "Save signature"}
    </button>
  </footer>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    border: none;
    background: rgb(8 10 14 / 45%);
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 51;
    width: min(620px, calc(100vw - 32px));
    padding: 20px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  h2 {
    margin: 0 0 4px;
    font-size: 16px;
  }

  p {
    margin: 0 0 14px;
  }

  .pad {
    position: relative;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: #ffffff;
    overflow: hidden;
  }

  canvas {
    display: block;
    width: 100%;
    height: auto;
    touch-action: none;
    cursor: crosshair;
  }

  /* A ruled line makes people sign at a consistent size. */
  .baseline {
    position: absolute;
    right: 24px;
    bottom: 26%;
    left: 24px;
    border-top: 1px dashed #c8cdd6;
    pointer-events: none;
  }

  .hint {
    position: absolute;
    bottom: calc(26% + 6px);
    left: 30px;
    color: #aab1bd;
    font-size: 13px;
    pointer-events: none;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }

  .ink,
  .named {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
  }

  .named input {
    width: 150px;
  }

  .ink input {
    width: 28px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  .spacer {
    flex: 1;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
</style>
