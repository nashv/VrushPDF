<script lang="ts">
  /**
   * Dialog for extracting specific page ranges or splitting a document into multiple files.
   */
  import { extractPages, parsePageRange, splitByInterval, type SplitRequest } from "$lib/annotations/split";
  import { images } from "$lib/state/images.svelte";
  import { session } from "$lib/state/session.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import { pickSaveTarget, writeFile } from "$lib/tauri/files";
  import Icon from "./Icon.svelte";

  const tab = $derived(workspace.active);
  const totalPages = $derived(tab?.edits.pages.length ?? 0);
  const pickedIds = $derived(tab?.edits.pickedPageIds ?? new Set<string>());

  type Mode = "extract" | "split";
  let mode = $state<Mode>("extract");

  // Default range calculation: if thumbnail pages were selected, populate them
  let rangeInput = $state("");
  let intervalInput = $state(1);
  let busy = $state(false);

  $effect(() => {
    if (!tab) return;
    if (pickedIds.size > 0) {
      const indices: number[] = [];
      tab.edits.pages.forEach((p, idx) => {
        if (pickedIds.has(p.id)) indices.push(idx + 1);
      });
      rangeInput = indices.join(", ");
    } else {
      rangeInput = `${tab.view.currentPage + 1}`;
    }
  });

  const parsedIndices = $derived(parsePageRange(rangeInput, totalPages));
  const validExtract = $derived(parsedIndices.length > 0 && parsedIndices.length <= totalPages);
  const splitChunksCount = $derived(
    intervalInput > 0 && totalPages > 0 ? Math.ceil(totalPages / intervalInput) : 0
  );

  function setPreset(preset: "all" | "current" | "odd" | "even") {
    if (!tab) return;
    if (preset === "all") {
      rangeInput = `1-${totalPages}`;
    } else if (preset === "current") {
      rangeInput = `${tab.view.currentPage + 1}`;
    } else if (preset === "odd") {
      const odds: number[] = [];
      for (let i = 1; i <= totalPages; i += 2) odds.push(i);
      rangeInput = odds.join(", ");
    } else if (preset === "even") {
      const evens: number[] = [];
      for (let i = 2; i <= totalPages; i += 2) evens.push(i);
      rangeInput = evens.join(", ");
    }
  }

  function createSplitRequest(): SplitRequest {
    if (!tab) throw new Error("No active document");
    return {
      pages: $state.snapshot(tab.edits.pages),
      annots: $state.snapshot(tab.edits.annots),
      mainDocId: "main",
      getSource: (id) => {
        const src = tab.doc.source(id);
        return src ? { bytes: src.bytes, managedRefs: src.managedRefs } : null;
      },
      resolveImage: (id) => {
        const item = images.get(id);
        return item ? { id: item.id, bytes: item.bytes, mime: item.mime } : null;
      },
      fields: $state.snapshot(tab.edits.fields),
    };
  }

  async function handleExtract(target: "tab" | "file") {
    if (!tab || !validExtract || busy) return;
    busy = true;
    try {
      const req = createSplitRequest();
      const bytes = await extractPages(req, parsedIndices);
      const baseName = tab.title.replace(/\.pdf$/i, "");
      const newName = `${baseName} (Pages ${rangeInput}).pdf`;

      if (target === "tab") {
        session.closeSplitDialog();
        await session.openBytes(bytes, newName);
        session.notify(`Extracted ${parsedIndices.length} page(s) into new tab.`);
      } else {
        const path = await pickSaveTarget(newName);
        if (path) {
          await writeFile(path, bytes);
          session.closeSplitDialog();
          session.notify(`Extracted ${parsedIndices.length} page(s) saved.`);
        }
      }
    } catch (err) {
      session.notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      busy = false;
    }
  }

  async function handleSplit(target: "tab" | "file") {
    if (!tab || intervalInput <= 0 || busy) return;
    busy = true;
    try {
      const req = createSplitRequest();
      const chunks = await splitByInterval(req, intervalInput);
      const baseName = tab.title.replace(/\.pdf$/i, "");

      session.closeSplitDialog();
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const newName = `${baseName} (${chunk.rangeLabel}).pdf`;
        if (target === "tab") {
          await session.openBytes(chunk.bytes, newName);
        } else {
          const path = await pickSaveTarget(newName);
          if (path) await writeFile(path, chunk.bytes);
        }
      }
      session.notify(`Split document into ${chunks.length} parts.`);
    } catch (err) {
      session.notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeSplitDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="split-title">
  <h2 id="split-title"><Icon name="scissors" /> Split & Extract Pages</h2>
  <p class="muted">
    Extract specific pages into a new document or split this PDF by intervals.
  </p>

  <div class="mode-tabs">
    <button
      class="mode-btn"
      class:active={mode === "extract"}
      onclick={() => (mode = "extract")}
    >
      Extract Pages
    </button>
    <button
      class="mode-btn"
      class:active={mode === "split"}
      onclick={() => (mode = "split")}
    >
      Split by Interval
    </button>
  </div>

  {#if mode === "extract"}
    <div class="section">
      <label class="label" for="page-range">Page Range:</label>
      <input
        id="page-range"
        type="text"
        class="input text-input"
        placeholder="e.g. 1-3, 5, 8-10"
        bind:value={rangeInput}
      />
      <div class="presets">
        <span class="preset-label">Quick select:</span>
        <button class="pill-btn" onclick={() => setPreset("all")}>All ({totalPages})</button>
        <button class="pill-btn" onclick={() => setPreset("current")}>Current</button>
        <button class="pill-btn" onclick={() => setPreset("odd")}>Odd pages</button>
        <button class="pill-btn" onclick={() => setPreset("even")}>Even pages</button>
      </div>

      <div class="summary">
        {#if validExtract}
          Extracting <strong>{parsedIndices.length}</strong> of {totalPages} pages:
          <span class="preview-indices">{parsedIndices.map((i) => i + 1).join(", ")}</span>
        {:else}
          <span class="error-text">Please enter a valid page range between 1 and {totalPages}.</span>
        {/if}
      </div>
    </div>
  {:else}
    <div class="section">
      <label class="label" for="split-interval">Split document every:</label>
      <div class="interval-row">
        <input
          id="split-interval"
          type="number"
          min="1"
          max={totalPages}
          class="input num-input"
          bind:value={intervalInput}
        />
        <span class="unit">page{intervalInput === 1 ? "" : "s"}</span>
      </div>

      <div class="summary">
        Will generate <strong>{splitChunksCount}</strong> separate PDF document{splitChunksCount === 1 ? "" : "s"}.
      </div>
    </div>
  {/if}

  <div class="footer">
    <button class="btn" onclick={() => session.closeSplitDialog()} disabled={busy}>Cancel</button>
    <span class="spacer"></span>
    {#if mode === "extract"}
      <button
        class="btn"
        onclick={() => handleExtract("file")}
        disabled={!validExtract || busy}
      >
        Save to File…
      </button>
      <button
        class="btn primary"
        onclick={() => handleExtract("tab")}
        disabled={!validExtract || busy}
      >
        Open in New Tab
      </button>
    {:else}
      <button
        class="btn"
        onclick={() => handleSplit("file")}
        disabled={splitChunksCount === 0 || busy}
      >
        Save All Files…
      </button>
      <button
        class="btn primary"
        onclick={() => handleSplit("tab")}
        disabled={splitChunksCount === 0 || busy}
      >
        Open in New Tabs
      </button>
    {/if}
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
    background: var(--bg-1);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: 8px;
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

  .mode-tabs {
    display: flex;
    gap: 4px;
    background: var(--bg-2);
    padding: 3px;
    border-radius: 6px;
    border: 1px solid var(--border);
  }

  .mode-btn {
    flex: 1;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-2);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .mode-btn.active {
    background: var(--bg-1);
    color: var(--text-1);
    box-shadow: var(--shadow-1);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 10px;
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
    background: var(--bg-0);
    color: var(--text-1);
  }

  .presets {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .preset-label {
    color: var(--text-muted);
  }

  .pill-btn {
    padding: 2px 8px;
    font-size: 11px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-2);
    cursor: pointer;
  }

  .pill-btn:hover {
    background: var(--bg-hover);
    color: var(--text-1);
  }

  .interval-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .num-input {
    width: 80px;
    padding: 6px 10px;
    font-size: 14px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-0);
    color: var(--text-1);
  }

  .unit {
    font-size: 13px;
    color: var(--text-2);
  }

  .summary {
    padding: 10px;
    background: var(--bg-2);
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-2);
  }

  .preview-indices {
    display: block;
    margin-top: 4px;
    color: var(--text-muted);
    max-height: 48px;
    overflow-y: auto;
  }

  .error-text {
    color: var(--danger, #ef4444);
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  .spacer {
    flex: 1;
  }
</style>
