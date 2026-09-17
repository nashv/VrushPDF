<script lang="ts">
  /** Every annotation in the document, grouped by page, in reading order. */
  import {
    annotBounds,
    isFreeText,
    isTextMarkup,
    type Annot,
  } from "$lib/annotations/types";
  import { edits } from "$lib/state/edits.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  const KIND_LABEL: Record<Annot["kind"], string> = {
    highlight: "Highlight",
    underline: "Underline",
    strikeout: "Strikeout",
    squiggly: "Squiggly",
    ink: "Drawing",
    square: "Rectangle",
    circle: "Ellipse",
    line: "Line",
    arrow: "Arrow",
    freetext: "Text box",
    note: "Note",
    stamp: "Stamp",
  };

  const KIND_ICON: Record<Annot["kind"], IconName> = {
    highlight: "highlight",
    underline: "underline",
    strikeout: "strikeout",
    squiggly: "squiggly",
    ink: "pen",
    square: "square",
    circle: "circle",
    line: "line",
    arrow: "arrow",
    freetext: "textbox",
    note: "note",
    stamp: "stamp",
  };

  /**
   * Group by page in plan order, and within a page top-to-bottom. PDF space has
   * y increasing upward, so descending y is reading order.
   */
  const grouped = $derived.by(() => {
    const out: { pageIndex: number; items: Annot[] }[] = [];
    edits.pages.forEach((entry, pageIndex) => {
      const items = [...(edits.annotsByPage.get(entry.id) ?? [])].sort(
        (a, b) => annotBounds(b).y - annotBounds(a).y,
      );
      if (items.length > 0) out.push({ pageIndex, items });
    });
    return out;
  });

  const total = $derived(edits.annots.length);

  /** One line of preview text: the quoted text, the body, or the comment. */
  function preview(annot: Annot): string {
    if (isFreeText(annot)) return annot.text || "(empty)";
    if (isTextMarkup(annot) && annot.quotedText) return `“${annot.quotedText}”`;
    return annot.contents || "";
  }

  function go(annot: Annot) {
    const pageIndex = edits.pageIndexOf(annot.pageId);
    edits.select(annot.id);
    if (pageIndex >= 0) viewer.goToPage(pageIndex);
    viewer.inspectorOpen = true;
  }
</script>

<div class="panel scroll">
  {#if total === 0}
    <p class="empty muted">
      No annotations yet. Pick a tool from the toolbar and mark up the page.
    </p>
  {:else}
    {#each grouped as group (group.pageIndex)}
      <div class="group">
        <div class="group-head">Page {group.pageIndex + 1}</div>
        {#each group.items as annot (annot.id)}
          <div class="row" class:selected={annot.id === edits.selectedId}>
            <button class="entry" onclick={() => go(annot)}>
              <span class="dot" style:background={annot.color}></span>
              <span class="body">
                <span class="kind">
                  <Icon name={KIND_ICON[annot.kind]} size={13} />
                  {KIND_LABEL[annot.kind]}
                </span>
                {#if preview(annot)}
                  <span class="text">{preview(annot)}</span>
                {/if}
              </span>
            </button>
            <button
              class="btn square danger"
              title="Delete"
              aria-label="Delete {KIND_LABEL[annot.kind]}"
              onclick={() => edits.remove(annot.id)}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        {/each}
      </div>
    {/each}
  {/if}
</div>

<style>
  .panel {
    height: 100%;
    min-height: 0;
    padding: 6px;
  }

  .empty {
    margin: 10px;
    line-height: 1.5;
  }

  .group + .group {
    margin-top: 8px;
  }

  .group-head {
    padding: 6px 6px 3px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 2px;
    border-radius: var(--radius);
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .row.selected {
    background: var(--accent-soft);
  }

  .entry {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: flex-start;
    gap: 8px;
    padding: 6px;
    text-align: left;
  }

  .dot {
    width: 10px;
    height: 10px;
    margin-top: 3px;
    flex: none;
    border: 1px solid rgb(0 0 0 / 25%);
    border-radius: 3px;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .kind {
    display: flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
  }

  .text {
    overflow: hidden;
    color: var(--text-muted);
    /* Two lines of preview is enough to identify a mark. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
</style>
