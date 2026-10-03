<script lang="ts">
  /**
   * Dialog for batch watermarking documents with custom or preset text.
   */
  import { generateWatermarks, type WatermarkOptions } from "$lib/annotations/watermark";
  import type { FontFamily } from "$lib/annotations/types";
  import { session } from "$lib/state/session.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  const tab = $derived(workspace.active);
  const totalPages = $derived(tab?.edits.pages.length ?? 0);

  let watermarkText = $state("CONFIDENTIAL");
  let fontFamily = $state<FontFamily>("Helvetica");
  let fontSize = $state(48);
  let color = $state("#dc2626");
  let opacity = $state(0.25);
  let position = $state<"center" | "top" | "bottom">("center");

  let pageRange = $state<"all" | "odd" | "even" | "custom">("all");
  let customRange = $state("");

  const PRESETS = [
    "CONFIDENTIAL",
    "DRAFT",
    "DO NOT COPY",
    "APPROVED",
    "SAMPLE",
    "FINAL",
    "INTERNAL ONLY",
  ];

  function apply() {
    if (!tab || !watermarkText.trim()) return;

    const options: WatermarkOptions = {
      text: watermarkText,
      fontFamily,
      fontSize,
      color,
      opacity,
      position,
      pageRange,
      customRange,
    };

    const annots = generateWatermarks(
      tab.edits.pages,
      (p) => tab.edits.displayDims(p),
      options,
    );

    if (annots.length === 0) {
      session.notify("No watermark was generated. Please enter watermark text.", "error");
      return;
    }

    tab.edits.add(annots);
    session.closeWatermarkDialog();
    session.notify(`Watermark added to ${annots.length} page(s).`);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeWatermarkDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="wm-title">
  <h2 id="wm-title"><Icon name="watermark" /> Add Watermark</h2>
  <p class="muted">
    Apply a persistent text watermark across all or selected pages.
  </p>

  <div class="section">
    <label class="field-label" for="wm-text">Watermark Text:</label>
    <input
      id="wm-text"
      type="text"
      class="input text-input"
      placeholder="e.g. CONFIDENTIAL"
      bind:value={watermarkText}
    />

    <div class="presets">
      <span class="preset-label">Presets:</span>
      {#each PRESETS as preset}
        <button
          class="pill-btn"
          class:active={watermarkText === preset}
          onclick={() => (watermarkText = preset)}
        >
          {preset}
        </button>
      {/each}
    </div>
  </div>

  <div class="grid-controls">
    <div class="control-col">
      <span class="section-title">Style & Appearance</span>
      <div class="row">
        <label class="field-label" for="wm-font">Font:</label>
        <select id="wm-font" class="select" bind:value={fontFamily}>
          <option value="Helvetica">Helvetica</option>
          <option value="Times">Times Roman</option>
          <option value="Courier">Courier</option>
        </select>
      </div>

      <div class="row">
        <label class="field-label" for="wm-size">Size:</label>
        <input id="wm-size" type="number" min="16" max="96" class="input num" bind:value={fontSize} />
        <span class="unit">pt</span>

        <input type="color" class="color-picker" bind:value={color} />
      </div>

      <div class="row">
        <label class="field-label" for="wm-opacity">Opacity:</label>
        <input
          id="wm-opacity"
          type="range"
          min="0.05"
          max="0.9"
          step="0.05"
          class="range-slider"
          bind:value={opacity}
        />
        <span class="unit">{Math.round(opacity * 100)}%</span>
      </div>
    </div>

    <div class="control-col">
      <span class="section-title">Placement & Pages</span>
      <div class="row">
        <label class="field-label" for="wm-pos">Position:</label>
        <select id="wm-pos" class="select" bind:value={position}>
          <option value="center">Center</option>
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>

      <div class="row">
        <label class="field-label" for="wm-pages">Pages:</label>
        <select id="wm-pages" class="select" bind:value={pageRange}>
          <option value="all">All Pages ({totalPages})</option>
          <option value="odd">Odd Pages Only</option>
          <option value="even">Even Pages Only</option>
          <option value="custom">Custom Range…</option>
        </select>
      </div>

      {#if pageRange === "custom"}
        <div class="row">
          <input
            type="text"
            class="input text-input"
            placeholder="e.g. 1-5, 8"
            bind:value={customRange}
          />
        </div>
      {/if}
    </div>
  </div>

  <div class="footer">
    <button class="btn" onclick={() => session.closeWatermarkDialog()}>Cancel</button>
    <span class="spacer"></span>
    <button class="btn primary" onclick={apply} disabled={!watermarkText.trim()}>
      Apply Watermark
    </button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    z-index: 50;
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 500px;
    max-width: 95vw;
    background: var(--surface-float);
    color: var(--text);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-3);
    padding: 20px;
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .muted {
    margin: -8px 0 0;
    color: var(--text-muted);
    font-size: 13px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .text-input {
    width: 100%;
    padding: 8px 10px;
    font-size: 14px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-raised);
    color: var(--text);
  }

  .presets {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .preset-label {
    color: var(--text-muted);
    font-size: 11px;
    margin-right: 2px;
  }

  .pill-btn {
    padding: 2px 7px;
    font-size: 11px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }

  .pill-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .pill-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }

  .grid-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }

  .control-col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .select {
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-raised);
    color: var(--text);
  }

  .num {
    width: 55px;
    padding: 4px 6px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-raised);
    color: var(--text);
  }

  .color-picker {
    width: 28px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
  }

  .range-slider {
    flex: 1;
  }

  .unit {
    font-size: 11px;
    color: var(--text-muted);
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }

  .spacer {
    flex: 1;
  }
</style>
