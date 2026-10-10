<script lang="ts">
  /**
   * Straighten tilted scans: pick pages, then `session.straightenPages`
   * measures each page's tilt and levels the ones that need it.
   */
  import { parsePageRange } from "$lib/annotations/split";
  import { loadOcrLanguages, OCR_LANGUAGES, pageHasText } from "$lib/ocr/engine";
  import { session } from "$lib/state/session.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  const tab = $derived(workspace.active);
  const totalPages = $derived(tab?.edits.pages.length ?? 0);

  let rangeInput = $state("");
  let reOcr = $state(false);
  /** Whether the user has decided about OCR themselves; then we stop guessing. */
  let reOcrTouched = $state(false);
  const langs = loadOcrLanguages();
  const langNames = OCR_LANGUAGES.filter((l) => langs.includes(l.code)).map((l) => l.label).join(", ");

  $effect(() => {
    rangeInput = totalPages > 0 ? `1-${totalPages}` : "";
  });

  const pageIndices = $derived(parsePageRange(rangeInput, totalPages));

  // Offer OCR when the pages had text: straightening turns them into images,
  // which takes their text away until it is recognised again.
  $effect(() => {
    const current = tab;
    const indices = pageIndices.slice(0, 30);
    if (!current || reOcrTouched) return;
    let alive = true;
    void (async () => {
      for (const index of indices) {
        const entry = current.edits.pages[index];
        if (!entry) continue;
        const page = await current.doc.page(entry.sourceDocId, entry.srcIndex);
        if (await pageHasText(page)) {
          if (alive && !reOcrTouched) reOcr = true;
          return;
        }
      }
      if (alive && !reOcrTouched) reOcr = false;
    })();
    return () => {
      alive = false;
    };
  });

  async function run() {
    if (!tab || pageIndices.length === 0) return;
    session.closeStraightenDialog();
    await session.straightenPages(tab, { pageIndices, reOcr, langs });
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeStraightenDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="straighten-title">
  <h2 id="straighten-title"><Icon name="straighten" /> Straighten Scanned Pages</h2>
  <p class="muted">
    Measures how far each page's text is tilted and turns the page level. Pages that are
    already straight are left alone.
  </p>

  <div class="section">
    <label class="label" for="straighten-range">Pages</label>
    <input
      id="straighten-range"
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

  <label class="check">
    <input
      type="checkbox"
      checked={reOcr}
      onchange={(event) => {
        reOcr = event.currentTarget.checked;
        reOcrTouched = true;
      }}
    />
    <span>
      Recognise text afterwards (OCR, {langNames})
      <span class="hint">Straightened pages become images, so their text needs recognising again to stay searchable.</span>
    </span>
  </label>

  <div class="summary">
    Straightened pages are re-rendered at 300 DPI. Annotations on them move with the page.
    Save the document to keep the result. Undo history starts over.
  </div>

  <div class="footer">
    <button class="btn" onclick={() => session.closeStraightenDialog()}>Cancel</button>
    <span class="spacer"></span>
    <button class="btn primary" onclick={run} disabled={pageIndices.length === 0}>
      Straighten {pageIndices.length === 1 ? "1 page" : `${pageIndices.length} pages`}
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

  .hint {
    display: block;
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

  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
  }

  .check input {
    margin-top: 2px;
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
