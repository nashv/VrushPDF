<script lang="ts">
  /**
   * What the region OCR tool read, beside the box the user dragged. The text
   * is already on the clipboard when that worked; this shows it, lets the user
   * fix a misread word, and copies again on demand.
   */
  let {
    x,
    y,
    pageWidth,
    text,
    reading,
    copied,
    onClose,
  }: {
    /** Anchor in page CSS px: the region's bottom-left corner. */
    x: number;
    y: number;
    pageWidth: number;
    text: string;
    reading: boolean;
    copied: boolean;
    onClose: () => void;
  } = $props();

  const WIDTH = 300;
  const left = $derived(Math.max(8, Math.min(x, pageWidth - WIDTH - 8)));

  let edited = $state<string | null>(null);
  let copiedAgain = $state(false);
  const shown = $derived(edited ?? text);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      copiedAgain = true;
    } catch {
      copiedAgain = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="ocr-result" style:left="{left}px" style:top="{y + 8}px" style:width="{WIDTH}px" role="dialog" aria-label="Recognised text">
  {#if reading}
    <div class="status">Reading text…</div>
  {:else if !text}
    <div class="status">No text found in that area.</div>
    <div class="actions"><button class="btn" onclick={onClose}>Close</button></div>
  {:else}
    <textarea
      rows={Math.min(8, Math.max(2, shown.split("\n").length))}
      value={shown}
      spellcheck="false"
      aria-label="Recognised text"
      oninput={(event) => {
        edited = event.currentTarget.value;
        copiedAgain = false;
      }}
    ></textarea>
    <div class="actions">
      <span class="note">
        {copiedAgain || (copied && edited === null) ? "Copied to the clipboard" : ""}
      </span>
      <button class="btn" onclick={onClose}>Close</button>
      <button class="btn primary" onclick={copy}>Copy</button>
    </div>
  {/if}
</div>

<style>
  .ocr-result {
    position: absolute;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
    color: var(--text);
  }

  .status {
    color: var(--text-muted);
    font-size: 13px;
  }

  textarea {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    font-size: 13px;
    resize: vertical;
    user-select: text;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }

  .note {
    flex: 1;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
