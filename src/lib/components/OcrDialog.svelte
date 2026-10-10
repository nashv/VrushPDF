<script lang="ts">
  /**
   * Make scanned pages searchable: pick pages and languages, then OCR them
   * into an invisible text layer (see `session.makeSearchable`).
   */
  import { parsePageRange } from "$lib/annotations/split";
  import { loadOcrLanguages, OCR_LANGUAGES, saveOcrLanguages, type OcrLanguage } from "$lib/ocr/engine";
  import { session } from "$lib/state/session.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  const tab = $derived(workspace.active);
  const totalPages = $derived(tab?.edits.pages.length ?? 0);

  let rangeInput = $state("");
  let langs = $state<OcrLanguage[]>(loadOcrLanguages());
  let skipPagesWithText = $state(true);

  // Every page by default: scans usually come as whole documents.
  $effect(() => {
    rangeInput = totalPages > 0 ? `1-${totalPages}` : "";
  });

  const pageIndices = $derived(parsePageRange(rangeInput, totalPages));
  const canRun = $derived(pageIndices.length > 0 && langs.length > 0);

  function toggleLang(code: OcrLanguage, on: boolean) {
    langs = on ? [...langs, code] : langs.filter((l) => l !== code);
  }

  async function run() {
    if (!tab || !canRun) return;
    // Keep the listed order stable: it is also Tesseract's priority order.
    const ordered = OCR_LANGUAGES.map((l) => l.code).filter((code) => langs.includes(code));
    saveOcrLanguages(ordered);
    session.closeOcrDialog();
    await session.makeSearchable(tab, { pageIndices, langs: ordered, skipPagesWithText });
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeOcrDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="ocr-title">
  <h2 id="ocr-title"><Icon name="ocr" /> Recognise Text (OCR)</h2>
  <p class="muted">
    Adds an invisible text layer to scanned pages, so you can search, select and copy their
    text here and in any other PDF viewer. The pages look exactly the same.
  </p>

  <div class="section">
    <label class="label" for="ocr-range">Pages</label>
    <input
      id="ocr-range"
      type="text"
      class="text-input"
      placeholder="e.g. 1-3, 5, 8-10"
      bind:value={rangeInput}
    />
    <div class="presets">
      <span class="preset-label">Quick select:</span>
      <button class="pill-btn" onclick={() => (rangeInput = `1-${totalPages}`)}>All ({totalPages})</button>
      <button class="pill-btn" onclick={() => (rangeInput = `${(tab?.view.currentPage ?? 0) + 1}`)}>
        Current
      </button>
    </div>
    {#if pageIndices.length === 0}
      <span class="error-text">Enter pages between 1 and {totalPages}.</span>
    {/if}
  </div>

  <div class="section">
    <span class="label" id="ocr-langs">Languages in the document</span>
    <div class="langs" role="group" aria-labelledby="ocr-langs">
      {#each OCR_LANGUAGES as lang (lang.code)}
        <label class="lang">
          <input
            type="checkbox"
            checked={langs.includes(lang.code)}
            onchange={(event) => toggleLang(lang.code, event.currentTarget.checked)}
          />
          {lang.label}
        </label>
      {/each}
    </div>
    {#if langs.length === 0}
      <span class="error-text">Pick at least one language.</span>
    {:else if langs.length > 2}
      <span class="hint">Each extra language makes recognition slower; pick only those present.</span>
    {/if}
  </div>

  <label class="check">
    <input type="checkbox" bind:checked={skipPagesWithText} />
    Skip pages that already have text
  </label>

  <div class="summary">
    Recognition takes a few seconds per page and runs entirely on this computer. Afterwards,
    save the document to keep the text. Undo history starts over.
  </div>

  <div class="footer">
    <button class="btn" onclick={() => session.closeOcrDialog()}>Cancel</button>
    <span class="spacer"></span>
    <button class="btn primary" onclick={run} disabled={!canRun}>
      Recognise {pageIndices.length === 1 ? "1 page" : `${pageIndices.length} pages`}
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
    width: 480px;
    max-width: 90vw;
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

  .label {
    font-size: 13px;
    font-weight: 500;
  }

  .text-input {
    width: 100%;
    padding: 8px 10px;
    font-size: 14px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-raised);
    color: var(--text);
    user-select: text;
  }

  .presets {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .preset-label,
  .hint {
    color: var(--text-muted);
    font-size: 12px;
  }

  .pill-btn {
    padding: 2px 8px;
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

  .langs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px 12px;
  }

  .lang,
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }

  .summary {
    padding: 10px;
    background: var(--bg-sunken);
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .error-text {
    color: var(--danger, #ef4444);
    font-size: 12px;
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .spacer {
    flex: 1;
  }
</style>
