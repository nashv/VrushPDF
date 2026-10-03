<script lang="ts">
  /**
   * Dialog for configuring headers, footers, page numbering, and Bates stamping.
   */
  import { generateHeadersFooters, type HeaderFooterOptions } from "$lib/annotations/headersFooters";
  import type { FontFamily } from "$lib/annotations/types";
  import { session } from "$lib/state/session.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  const tab = $derived(workspace.active);
  const totalPages = $derived(tab?.edits.pages.length ?? 0);

  let headerLeft = $state("");
  let headerCenter = $state("");
  let headerRight = $state("{date}");

  let footerLeft = $state("{title}");
  let footerCenter = $state("Page {page} of {pages}");
  let footerRight = $state("");

  let fontFamily = $state<FontFamily>("Helvetica");
  let fontSize = $state(10);
  let color = $state("#374151");
  let bold = $state(false);
  let italic = $state(false);
  let margin = $state(24);

  let pageRange = $state<"all" | "odd" | "even" | "custom">("all");
  let customRange = $state("");

  let batesPrefix = $state("CONFIDENTIAL-");
  let batesStart = $state(1);
  let batesDigits = $state(6);

  let activeField = $state<"hl" | "hc" | "hr" | "fl" | "fc" | "fr">("fc");

  function insertToken(token: string) {
    if (activeField === "hl") headerLeft += token;
    else if (activeField === "hc") headerCenter += token;
    else if (activeField === "hr") headerRight += token;
    else if (activeField === "fl") footerLeft += token;
    else if (activeField === "fc") footerCenter += token;
    else if (activeField === "fr") footerRight += token;
  }

  function apply() {
    if (!tab) return;
    const options: HeaderFooterOptions = {
      headerLeft,
      headerCenter,
      headerRight,
      footerLeft,
      footerCenter,
      footerRight,
      fontFamily,
      fontSize,
      color,
      bold,
      italic,
      margin,
      pageRange,
      customRange,
      batesPrefix,
      batesStart,
      batesDigits,
    };

    const annots = generateHeadersFooters(
      tab.edits.pages,
      (p) => tab.edits.displayDims(p),
      tab.title,
      options,
    );

    if (annots.length === 0) {
      session.notify("No headers or footers were generated. Please enter text in at least one slot.", "error");
      return;
    }

    tab.edits.add(annots);
    session.closeHeaderFooterDialog();
    session.notify(`Applied headers & footers across ${annots.length} location(s).`);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeHeaderFooterDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="hf-title">
  <h2 id="hf-title"><Icon name="header-footer" /> Headers, Footers & Bates Numbering</h2>
  <p class="muted">
    Add recurring headers, footers, page numbers or legal Bates stamping.
  </p>

  <div class="slots-container">
    <div class="slot-group">
      <span class="slot-title">Header (Top of Page)</span>
      <div class="slot-row">
        <input
          type="text"
          class="input slot-input"
          placeholder="Left header"
          bind:value={headerLeft}
          onfocus={() => (activeField = "hl")}
        />
        <input
          type="text"
          class="input slot-input center"
          placeholder="Center header"
          bind:value={headerCenter}
          onfocus={() => (activeField = "hc")}
        />
        <input
          type="text"
          class="input slot-input right"
          placeholder="Right header"
          bind:value={headerRight}
          onfocus={() => (activeField = "hr")}
        />
      </div>
    </div>

    <div class="page-mockup">
      <div class="mockup-line"></div>
      <div class="mockup-body">Document Content Area</div>
      <div class="mockup-line"></div>
    </div>

    <div class="slot-group">
      <span class="slot-title">Footer (Bottom of Page)</span>
      <div class="slot-row">
        <input
          type="text"
          class="input slot-input"
          placeholder="Left footer"
          bind:value={footerLeft}
          onfocus={() => (activeField = "fl")}
        />
        <input
          type="text"
          class="input slot-input center"
          placeholder="Center footer"
          bind:value={footerCenter}
          onfocus={() => (activeField = "fc")}
        />
        <input
          type="text"
          class="input slot-input right"
          placeholder="Right footer"
          bind:value={footerRight}
          onfocus={() => (activeField = "fr")}
        />
      </div>
    </div>
  </div>

  <div class="token-toolbar">
    <span class="token-label">Insert into active slot:</span>
    <button class="pill-btn" onclick={() => insertToken("{page}")}>+ Page #</button>
    <button class="pill-btn" onclick={() => insertToken("{pages}")}>+ Total Pages</button>
    <button class="pill-btn" onclick={() => insertToken("{date}")}>+ Date</button>
    <button class="pill-btn" onclick={() => insertToken("{title}")}>+ Title</button>
    <button class="pill-btn highlight" onclick={() => insertToken("{bates}")}>+ Bates Number</button>
  </div>

  <div class="grid-controls">
    <div class="control-col">
      <span class="section-title">Typography & Style</span>
      <div class="row">
        <label class="field-label" for="hf-font">Font:</label>
        <select id="hf-font" class="select" bind:value={fontFamily}>
          <option value="Helvetica">Helvetica</option>
          <option value="Times">Times Roman</option>
          <option value="Courier">Courier</option>
        </select>
      </div>

      <div class="row">
        <label class="field-label" for="hf-size">Size:</label>
        <input id="hf-size" type="number" min="6" max="24" class="input num" bind:value={fontSize} />
        <span class="unit">pt</span>

        <input type="color" class="color-picker" bind:value={color} />
      </div>

      <div class="row">
        <label class="field-label" for="hf-margin">Margin:</label>
        <input id="hf-margin" type="number" min="8" max="72" class="input num" bind:value={margin} />
        <span class="unit">pt from edge</span>
      </div>
    </div>

    <div class="control-col">
      <span class="section-title">Page Range & Bates Stamp</span>
      <div class="row">
        <label class="field-label" for="hf-pages">Apply to:</label>
        <select id="hf-pages" class="select" bind:value={pageRange}>
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

      <div class="row bates-row">
        <label class="field-label" for="bates-pfx">Bates:</label>
        <input
          id="bates-pfx"
          type="text"
          class="input bates-input"
          placeholder="Prefix"
          bind:value={batesPrefix}
        />
        <input
          type="number"
          min="1"
          class="input num"
          placeholder="Start"
          bind:value={batesStart}
          title="Starting number"
        />
        <input
          type="number"
          min="1"
          max="10"
          class="input num"
          placeholder="Digits"
          bind:value={batesDigits}
          title="Number of digits"
        />
      </div>
    </div>
  </div>

  <div class="footer">
    <button class="btn" onclick={() => session.closeHeaderFooterDialog()}>Cancel</button>
    <span class="spacer"></span>
    <button class="btn primary" onclick={apply}>
      Apply to Document
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
    width: 580px;
    max-width: 95vw;
    background: var(--bg-1);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-3);
    padding: 20px;
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 14px;
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

  .slots-container {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
  }

  .slot-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .slot-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }

  .slot-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
  }

  .slot-input {
    padding: 6px 8px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-0);
    color: var(--text-1);
  }

  .slot-input.center {
    text-align: center;
  }

  .slot-input.right {
    text-align: right;
  }

  .slot-input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .page-mockup {
    margin: 4px 0;
    padding: 10px;
    background: var(--bg-1);
    border: 1px dashed var(--border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .mockup-body {
    font-size: 11px;
    color: var(--text-muted);
  }

  .mockup-line {
    width: 60%;
    height: 1px;
    background: var(--border);
  }

  .token-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .token-label {
    color: var(--text-muted);
    font-size: 11px;
  }

  .pill-btn {
    padding: 3px 8px;
    font-size: 11px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-1);
    cursor: pointer;
  }

  .pill-btn:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
  }

  .pill-btn.highlight {
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
    color: var(--text-2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .field-label {
    font-size: 12px;
    color: var(--text-2);
    width: 55px;
    flex: none;
  }

  .select {
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-0);
    color: var(--text-1);
  }

  .num {
    width: 55px;
    padding: 4px 6px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-0);
    color: var(--text-1);
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

  .unit {
    font-size: 11px;
    color: var(--text-muted);
  }

  .bates-input {
    flex: 1;
    min-width: 80px;
    padding: 4px 6px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-0);
    color: var(--text-1);
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
