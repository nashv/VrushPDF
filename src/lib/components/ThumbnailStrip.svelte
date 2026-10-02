<script lang="ts">
  /**
   * Page thumbnails, plus the page-level operations: rotate, delete, reorder by
   * drag or with the move buttons, keep-a-range, insert a blank page, and merge
   * another PDF in.
   *
   * Thumbnails render lazily and are cached per (page, rotation) so scrolling a
   * long document doesn't re-rasterise everything.
   */
  import type { PageEntry } from "$lib/annotations/types";
  import { renderThumbnail } from "$lib/pdf/render";
  import { createReorder } from "$lib/reorder.svelte";
  import { session } from "$lib/state/session.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  let { tab }: { tab: DocumentTab } = $props();
  const doc = $derived(tab.doc);
  const edits = $derived(tab.edits);
  const view = $derived(tab.view);

  const pages = $derived(edits.pages);

  /**
   * Multi-select for the page operations; empty means "the current page". Kept
   * on the tab so the Pages menu acts on the same pages these buttons do.
   */
  const picked = $derived(edits.pickedPageIds);

  /** The scrolling grid, so a drag near its edge scrolls the list. */
  let grid = $state<HTMLElement | null>(null);

  const reorder = createReorder({
    axis: "y",
    itemSelector: ".tile",
    scroller: () => grid,
    onDrop: (from, to) => {
      edits.movePage(from, to);
      view.goToPage(to);
    },
  });

  const targetIds = $derived(tab.targetPageIds);

  function selectPage(entry: PageEntry, index: number, event: MouseEvent) {
    // The click that closes a drag must not also change the selection.
    if (reorder.justDragged) return;
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(picked);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      edits.pickedPageIds = next;
      return;
    }
    if (event.shiftKey && picked.size > 0) {
      const anchor = pages.findIndex((p) => picked.has(p.id));
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      edits.pickedPageIds = new Set(pages.slice(lo, hi + 1).map((p) => p.id));
      return;
    }
    edits.clearPickedPages();
    view.goToPage(index);
  }

  // --------------------------------------------------------------- thumbnails

  interface Thumb {
    url: string;
    width: number;
    height: number;
  }

  /** Cache key includes rotation, since a rotated thumbnail is a new image. */
  const cache = new Map<string, Thumb>();
  let rendered = $state.raw(new Map<string, Thumb>());

  const keyOf = (entry: PageEntry) =>
    `${entry.sourceDocId}:${entry.srcIndex}:${entry.rotation}`;

  /** Render a thumbnail the first time its tile scrolls into view. */
  function lazyThumb(node: HTMLElement, entry: PageEntry) {
    const key = keyOf(entry);
    if (cache.has(key)) return;

    const observer = new IntersectionObserver(
      async (records) => {
        if (!records.some((r) => r.isIntersecting)) return;
        observer.disconnect();
        if (cache.has(key)) return;
        try {
          const page = await doc.page(entry.sourceDocId, entry.srcIndex);
          const thumb = await renderThumbnail(page, entry.rotation);
          cache.set(key, thumb);
          rendered = new Map(cache);
        } catch {
          // A page that won't rasterise just shows its placeholder.
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }

  const thumbOf = (entry: PageEntry) => rendered.get(keyOf(entry)) ?? null;

  /** Thumbnails hold blob URLs, so they have to be revoked on teardown. */
  $effect(() => () => {
    for (const thumb of cache.values()) URL.revokeObjectURL(thumb.url);
    cache.clear();
  });

  // ------------------------------------------------------------------ actions

  function rotate(delta: 90 | -90) {
    edits.rotatePages(targetIds, delta);
  }

  function remove() {
    if (targetIds.length === 0) return;
    if (targetIds.length >= pages.length) {
      session.notify("A document needs at least one page.", "error");
      return;
    }
    edits.deletePages(targetIds);
    edits.clearPickedPages();
  }

  /** Reduce the document to the picked span. */
  function keepOnly() {
    if (picked.size === 0) return;
    const indices = pages.flatMap((p, i) => (picked.has(p.id) ? [i] : []));
    edits.extractRange(Math.min(...indices), Math.max(...indices));
    edits.clearPickedPages();
  }

  const insertAt = $derived(tab.insertAt);

  const canMoveUp = $derived(edits.canMovePages(targetIds, -1));
  const canMoveDown = $derived(edits.canMovePages(targetIds, 1));
</script>

<div class="panel">
  <div class="actions">
    <button class="btn square" title="Rotate left" onclick={() => rotate(-90)}>
      <Icon name="rotate-ccw" />
    </button>
    <button class="btn square" title="Rotate right" onclick={() => rotate(90)}>
      <Icon name="rotate-cw" />
    </button>
    <div class="divider"></div>

    <button
      class="btn square"
      title="Move up"
      disabled={!canMoveUp}
      onclick={() => edits.movePages(targetIds, -1)}
    >
      <Icon name="chevron-up" />
    </button>
    <button
      class="btn square"
      title="Move down"
      disabled={!canMoveDown}
      onclick={() => edits.movePages(targetIds, 1)}
    >
      <Icon name="chevron-down" />
    </button>

    <div class="divider"></div>

    <button
      class="btn square"
      title="Insert a blank page after this one"
      onclick={() => session.addBlankPage(insertAt)}
    >
      <Icon name="plus" />
    </button>
    <button
      class="btn square"
      title="Keep only the selected pages"
      disabled={picked.size === 0}
      onclick={keepOnly}
    >
      <Icon name="scissors" />
    </button>
    <button
      class="btn square"
      title="Insert another PDF after this page"
      onclick={() => session.mergePdf(insertAt)}
    >
      <Icon name="merge" />
    </button>
    <span class="spacer"></span>
    <button
      class="btn square danger"
      title={picked.size > 1 ? `Delete ${picked.size} pages` : "Delete page"}
      disabled={pages.length <= 1}
      onclick={remove}
    >
      <Icon name="trash" />
    </button>
  </div>

  {#if picked.size > 0}
    <div class="selection">
      {picked.size} page{picked.size === 1 ? "" : "s"} selected
      <button class="link" onclick={() => edits.clearPickedPages()}>Clear</button>
    </div>
  {/if}

  <div class="grid scroll" class:reordering={reorder.active} bind:this={grid}>
    {#each pages as entry, index (entry.id)}
      {@const thumb = thumbOf(entry)}
      {@const dims = edits.displayDims(entry)}
      <!--
        The drag lives on the tile so the whole thumbnail is a handle;
        activation and selection are handled by the real button inside.
      -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tile"
        class:current={index === view.currentPage && picked.size === 0}
        class:picked={picked.has(entry.id)}
        class:holding={reorder.pending === index && reorder.from === null}
        class:dragging={reorder.from === index}
        class:drop-before={reorder.to === index && reorder.from !== null && reorder.from > index}
        class:drop-after={reorder.to === index && reorder.from !== null && reorder.from < index}
        data-reorder-index={index}
        onpointerdown={(event) => reorder.down(index, event)}
        {@attach (node) => lazyThumb(node, entry)}
      >
        <button
          class="shot"
          style:aspect-ratio="{dims.width} / {dims.height}"
          onclick={(event) => selectPage(entry, index, event)}
          aria-label="Page {index + 1}"
          aria-current={index === view.currentPage}
        >
          {#if thumb}
            <img src={thumb.url} alt="" />
          {/if}
        </button>
        <span class="no">{index + 1}</span>
      </div>
    {/each}
  </div>

  {#if reorder.active && reorder.from !== null && reorder.pointerPos}
    {@const draggedEntry = pages[reorder.from]}
    {@const draggedThumb = draggedEntry ? thumbOf(draggedEntry) : null}
    <div
      class="drag-ghost"
      style:left="{reorder.pointerPos.x + 12}px"
      style:top="{reorder.pointerPos.y + 12}px"
    >
      {#if draggedThumb}
        <img src={draggedThumb.url} alt="" class="ghost-thumb" />
      {/if}
      <span class="ghost-label">Page {reorder.from + 1}</span>
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }

  .spacer {
    flex: 1;
  }

  .selection {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: none;
    padding: 5px 10px;
    background: var(--accent-soft);
    font-size: 12px;
  }

  .link {
    color: var(--accent);
    text-decoration: underline;
  }

  .grid {
    display: grid;
    /* Tracks the sidebar width: widening it adds columns rather than just
       stretching two. At the default 288px this still resolves to two. */
    grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
    gap: 10px;
    padding: 10px;
    min-height: 0;
  }

  .grid.reordering {
    user-select: none;
    cursor: grabbing;
  }

  .grid.reordering .tile,
  .grid.reordering .shot {
    cursor: grabbing;
  }

  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    transition: transform 0.12s ease;
  }

  .shot {
    display: grid;
    place-items: center;
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #ffffff;
    box-shadow: var(--shadow-1);
    transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
  }

  .tile.holding {
    transform: scale(0.96);
  }

  .tile.holding .shot {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent), var(--shadow-2);
    cursor: grabbing;
  }

  .tile.dragging {
    opacity: 0.35;
    transform: scale(0.94);
  }

  .tile.dragging .shot {
    border: 1.5px dashed var(--accent);
  }

  .shot img {
    /* Stop WebKit starting a native image drag, which the window's file-drop
       handler would swallow along with the reorder. */
    -webkit-user-drag: none;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .tile.current .shot {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }

  .tile.picked .shot {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
    filter: brightness(0.94);
  }

  /* Drop indicator shows which side the dragged page will land on. */
  .tile.drop-before::before,
  .tile.drop-after::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 18px;
    width: 4px;
    background: var(--accent);
    border-radius: 2px;
    z-index: 10;
    box-shadow: 0 0 8px rgb(37 99 235 / 70%);
    pointer-events: none;
  }

  .tile.drop-before::before {
    left: -7px;
  }

  .tile.drop-after::after {
    right: -7px;
  }

  .drag-ghost {
    position: fixed;
    z-index: 9999;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 4px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--bg-raised, #ffffff);
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%), 0 0 0 1px rgb(37 99 235 / 20%);
    pointer-events: none;
    transform: translate3d(0, 0, 0);
  }

  .ghost-thumb {
    width: 24px;
    height: 32px;
    object-fit: cover;
    border-radius: 2px;
    border: 1px solid var(--border);
  }

  .ghost-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }

  .no {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
</style>
