<script lang="ts">
  /**
   * Combine several PDFs, in an order you choose, into one new document.
   *
   * Files are read as they are added so the page count is real and an
   * unreadable file is caught here rather than halfway through the merge.
   */
  import { pageCount } from "$lib/annotations/inspect";
  import { createReorder } from "$lib/reorder.svelte";
  import { session } from "$lib/state/session.svelte";
  import { pickPdfToOpen, readFile } from "$lib/tauri/files";
  import Icon from "./Icon.svelte";

  interface Entry {
    /** Unique per row: the same file may legitimately be merged twice. */
    key: string;
    path: string;
    name: string;
    /** Null until counted. */
    pages: number | null;
    error: string | null;
  }

  let entries = $state<Entry[]>([]);
  let addButton: HTMLButtonElement | undefined = $state();
  let list = $state<HTMLElement | null>(null);

  const total = $derived(entries.reduce((sum, e) => sum + (e.pages ?? 0), 0));
  const broken = $derived(entries.some((e) => e.error !== null));
  const canMerge = $derived(entries.length > 0 && !broken);

  const reorder = createReorder({
    axis: "y",
    itemSelector: ".row",
    scroller: () => list,
    onDrop: (from, to) => {
      const next = [...entries];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      entries = next;
    },
  });

  $effect(() => {
    addButton?.focus();
  });

  async function add() {
    const picked = await pickPdfToOpen(true);
    if (!picked?.length) return;

    const added: Entry[] = picked.map((path) => ({
      key: crypto.randomUUID(),
      path,
      name: path.split("/").pop() ?? path,
      pages: null,
      error: null,
    }));
    entries = [...entries, ...added];

    // Count in the background so a big file doesn't freeze the dialog.
    for (const entry of added) {
      try {
        const pages = await pageCount(await readFile(entry.path));
        patch(entry.key, { pages });
      } catch {
        patch(entry.key, { error: "Could not read this file" });
      }
    }
  }

  function patch(key: string, changes: Partial<Entry>) {
    entries = entries.map((e) => (e.key === key ? { ...e, ...changes } : e));
  }

  function remove(key: string) {
    entries = entries.filter((e) => e.key !== key);
  }

  function move(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= entries.length) return;
    const next = [...entries];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    entries = next;
  }

  function merge() {
    if (!canMerge) return;
    const paths = entries.map((e) => e.path);
    session.closeMergeDialog();
    void session.mergeFiles(paths);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeMergeDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="merge-title">
  <h2 id="merge-title"><Icon name="merge" /> Merge PDFs</h2>
  <p class="muted">
    The files are combined top to bottom into one new document, which you can
    check over before saving.
  </p>

  <div class="list scroll" bind:this={list}>
    {#if entries.length === 0}
      <p class="empty muted">No files yet. Add the PDFs you want to combine.</p>
    {:else}
      {#each entries as entry, index (entry.key)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="row"
          class:dragging={reorder.from === index}
          class:drop-before={reorder.to === index && reorder.from !== null && reorder.from > index}
          class:drop-after={reorder.to === index && reorder.from !== null && reorder.from < index}
          class:bad={entry.error !== null}
          data-reorder-index={index}
          onpointerdown={(event) => reorder.down(index, event)}
        >
          <span class="ord">{index + 1}</span>
          <span class="lines">
            <span class="file-name">{entry.name}</span>
            <span class="path muted">{entry.path}</span>
          </span>
          <span class="count muted">
            {#if entry.error}
              <Icon name="warning" size={13} /> {entry.error}
            {:else if entry.pages === null}
              …
            {:else}
              {entry.pages} page{entry.pages === 1 ? "" : "s"}
            {/if}
          </span>
          <button
            class="btn square"
            title="Move up"
            aria-label="Move {entry.name} up"
            disabled={index === 0}
            onclick={() => move(index, -1)}
          >
            <Icon name="chevron-up" size={14} />
          </button>
          <button
            class="btn square"
            title="Move down"
            aria-label="Move {entry.name} down"
            disabled={index === entries.length - 1}
            onclick={() => move(index, 1)}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          <button
            class="btn square danger"
            title="Remove"
            aria-label="Remove {entry.name}"
            onclick={() => remove(entry.key)}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <footer>
    <button bind:this={addButton} class="btn outlined" onclick={add}>
      <Icon name="plus" /> Add files…
    </button>
    <span class="summary muted">
      {#if entries.length > 0}
        {entries.length} file{entries.length === 1 ? "" : "s"} · {total} page{total === 1 ? "" : "s"}
      {/if}
    </span>
    <span class="spacer"></span>
    <button class="btn outlined" onclick={() => session.closeMergeDialog()}>Cancel</button>
    <button class="btn primary" disabled={!canMerge} onclick={merge}>Merge</button>
  </footer>
</div>

<style>
  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(640px, 92vw);
    max-height: 80vh;
    padding: 18px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 15px;
  }

  p {
    margin: 0;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 120px;
    max-height: 46vh;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    overflow-y: auto;
  }

  .empty {
    margin: auto;
    padding: 20px;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--radius);
    cursor: grab;
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .row.dragging {
    opacity: 0.4;
  }

  .row.bad .file-name {
    color: var(--danger);
  }

  /* Insertion line, matching the thumbnail strip's drag feedback. */
  .row.drop-before::before,
  .row.drop-after::after {
    content: "";
    position: absolute;
    left: 4px;
    right: 4px;
    height: 2px;
    background: var(--accent);
  }

  .row.drop-before::before {
    top: -1px;
  }

  .row.drop-after::after {
    bottom: -1px;
  }

  .ord {
    flex: none;
    width: 18px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .lines {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .file-name {
    font-weight: 600;
  }

  .file-name,
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path {
    font-size: 11px;
    /* Long paths identify better from the tail than the head. */
    direction: rtl;
    text-align: left;
  }

  .count {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
    white-space: nowrap;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .spacer {
    flex: 1;
  }
</style>
