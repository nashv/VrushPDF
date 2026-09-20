<script lang="ts">
  /**
   * The HTML half of the annotation overlay: FreeText bodies, sticky-note pins
   * and selection handles.
   *
   * These are absolutely positioned in CSS pixels rather than drawn inside the
   * SVG because the SVG layer is Y-flipped (text would be mirrored), because
   * `contenteditable` beats SVG text for editing, and because handles should
   * stay a constant on-screen size at any zoom.
   */
  import type { PageViewport } from "pdfjs-dist";
  import {
    annotBounds,
    hasRect,
    isFreeText,
    isNote,
    NOTE_SIZE,
    type Annot,
  } from "$lib/annotations/types";
  import { HANDLES, handlePoint, type HandleId } from "$lib/annotations/hit";
  import { toViewportPoint, toViewportRect } from "$lib/pdf/render";

  let {
    annots,
    viewport,
    selectedId = null,
    editingId = null,
    interactive = true,
    onHandleDown,
    onNoteDown,
    onFreeTextInput,
    onFreeTextCommit,
  }: {
    annots: Annot[];
    viewport: PageViewport;
    selectedId?: string | null;
    /** FreeText currently open for editing. */
    editingId?: string | null;
    /** False while a non-select tool is active, so widgets don't eat clicks. */
    interactive?: boolean;
    onHandleDown?: (event: PointerEvent, annot: Annot, handle: HandleId) => void;
    onNoteDown?: (event: PointerEvent, annot: Annot) => void;
    onFreeTextInput?: (annot: Annot, text: string) => void;
    onFreeTextCommit?: (annot: Annot) => void;
  } = $props();

  const freeTexts = $derived(annots.filter(isFreeText));
  const notes = $derived(annots.filter(isNote));
  const selected = $derived(annots.find((a) => a.id === selectedId) ?? null);

  /** Only kinds with a meaningful box get resize handles. */
  const showHandles = $derived(
    selected !== null && hasRect(selected) && selected.id !== editingId,
  );

  const boxOf = (annot: Annot) => toViewportRect(viewport, annotBounds(annot));

  function handleStyle(annot: Annot, id: HandleId): string {
    const p = toViewportPoint(viewport, handlePoint(annotBounds(annot), id));
    return `left:${p.x}px; top:${p.y}px`;
  }

  /** Cursor for a handle, corrected for page rotation. */
  function handleCursor(id: HandleId): string {
    const order: HandleId[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
    const steps = Math.round((viewport.rotation % 360) / 45);
    const rotated = order[(order.indexOf(id) + steps + order.length * 2) % order.length];
    return `${rotated}-resize`;
  }

  function onEditInput(annot: Annot, event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    onFreeTextInput?.(annot, target.value);
  }

  function onEditKeydown(annot: Annot, event: KeyboardEvent) {
    // Escape commits and exits; Enter must stay available for new lines.
    if (event.key === "Escape") {
      event.stopPropagation();
      onFreeTextCommit?.(annot);
    }
  }

  /** Autofocus a box the moment it opens for editing. */
  function focusOnMount(node: HTMLTextAreaElement) {
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }
</script>

<div class="widgets" class:interactive>
  {#each freeTexts as annot (annot.id)}
    {@const box = boxOf(annot)}
    {@const editing = annot.id === editingId}
    <div
      class="freetext"
      class:editing
      style:left="{box.left}px"
      style:top="{box.top}px"
      style:width="{box.width}px"
      style:height="{box.height}px"
      style:color={annot.color}
      style:font-size="{annot.fontSize * viewport.scale}px"
      style:text-align={annot.align}
      style:opacity={annot.opacity}
      style:padding="{(2 + (annot.borderColor ? annot.borderWidth : 0)) * viewport.scale}px"
    >
      {#if editing}
        <textarea
          value={annot.text}
          spellcheck="false"
          oninput={(event) => onEditInput(annot, event)}
          onkeydown={(event) => onEditKeydown(annot, event)}
          onblur={() => onFreeTextCommit?.(annot)}
          {@attach focusOnMount}
        ></textarea>
      {:else}
        <span>{annot.text}</span>
      {/if}
    </div>
  {/each}

  {#each notes as annot (annot.id)}
    {@const p = toViewportPoint(viewport, annot.point)}
    {@const size = NOTE_SIZE * viewport.scale}
    <button
      type="button"
      class="note"
      class:selected={annot.id === selectedId}
      style:left="{p.x}px"
      style:top="{p.y}px"
      style:width="{size}px"
      style:height="{size}px"
      style:background={annot.color}
      style:opacity={annot.opacity}
      title={annot.contents || "Comment"}
      onpointerdown={(event) => onNoteDown?.(event, annot)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 5h16v11H9l-5 4Z"
          fill="none"
          stroke="rgb(0 0 0 / 55%)"
          stroke-width="1.8"
          stroke-linejoin="round"
        />
      </svg>
      <span class="sr-only">Comment: {annot.contents || "empty"}</span>
    </button>
  {/each}

  {#if selected}
    {@const box = boxOf(selected)}
    <div
      class="outline"
      style:left="{box.left}px"
      style:top="{box.top}px"
      style:width="{box.width}px"
      style:height="{box.height}px"
    ></div>
  {/if}

  {#if showHandles && selected}
    {#each HANDLES as id (id)}
      <button
        type="button"
        class="handle"
        style={handleStyle(selected, id)}
        style:cursor={handleCursor(id)}
        aria-label="Resize {id}"
        onpointerdown={(event) => onHandleDown?.(event, selected, id)}
      ></button>
    {/each}
  {/if}
</div>

<style>
  .widgets {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: none;
  }

  .widgets.interactive .note,
  .widgets.interactive .handle,
  .widgets .freetext.editing {
    pointer-events: auto;
  }

  .freetext {
    position: absolute;
    overflow: hidden;
    font-family: Helvetica, Arial, sans-serif;
    line-height: 1.18;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .freetext textarea {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    outline: none;
    background: rgb(255 255 255 / 75%);
    color: inherit;
    font: inherit;
    line-height: inherit;
    text-align: inherit;
    resize: none;
    user-select: text;
  }

  .note {
    position: absolute;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid rgb(0 0 0 / 25%);
    border-radius: 3px;
    box-shadow: var(--shadow-1);
    cursor: pointer;
  }

  .note svg {
    width: 76%;
    height: 76%;
  }

  .note.selected {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .outline {
    position: absolute;
    border: 1px solid var(--accent);
    /* A selection ring must not obscure what it surrounds. */
    background: rgb(37 99 235 / 6%);
    pointer-events: none;
  }

  .handle {
    position: absolute;
    width: 9px;
    height: 9px;
    margin: -5px 0 0 -5px;
    border: 1px solid var(--accent);
    border-radius: 2px;
    background: var(--bg-raised);
    box-shadow: var(--shadow-1);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
