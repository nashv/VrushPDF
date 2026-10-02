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
    movingId = null,
    interactive = true,
    onHandleDown,
    onHandleDblClick,
    onNoteDown,
    onFreeTextInput,
    onFreeTextResize,
    onFreeTextTab,
    onFreeTextCommit,
  }: {
    annots: Annot[];
    viewport: PageViewport;
    selectedId?: string | null;
    /** FreeText currently open for editing. */
    editingId?: string | null;
    /** Annotation currently being moved/dragged. */
    movingId?: string | null;
    /** False while a non-select tool is active, so widgets don't eat clicks. */
    interactive?: boolean;
    onHandleDown?: (event: PointerEvent, annot: Annot, handle: HandleId) => void;
    onHandleDblClick?: (event: MouseEvent, annot: Annot, handle: HandleId) => void;
    onNoteDown?: (event: PointerEvent, annot: Annot) => void;
    onFreeTextInput?: (annot: Annot, text: string) => void;
    onFreeTextResize?: (annot: Annot, newRect: { x: number; y: number; w: number; h: number }) => void;
    onFreeTextTab?: (annot: Annot, delta: number) => void;
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

  function fontFamilyCss(family?: string): string {
    if (family === "Times") return '"Times New Roman", Times, Georgia, serif';
    if (family === "Courier") return '"Courier New", Courier, monospace';
    return "Helvetica, Arial, sans-serif";
  }

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
    if (!isFreeText(annot)) return;
    const target = event.currentTarget as HTMLTextAreaElement;
    onFreeTextInput?.(annot, target.value);

    // Dynamic auto-expansion if multiline text exceeds the box
    target.style.height = "auto";
    const neededPx = target.scrollHeight;
    const padding = (annot.padding ?? 2) + (annot.borderColor ? annot.borderWidth : 0);
    const neededPt = neededPx / viewport.scale + padding * 2;
    if (neededPt > annot.rect.h) {
      const newH = Math.ceil(neededPt);
      const newY = annot.rect.y + annot.rect.h - newH;
      onFreeTextResize?.(annot, { ...annot.rect, y: newY, h: newH });
    }
    target.style.height = "100%";
  }

  function onEditKeydown(annot: Annot, event: KeyboardEvent) {
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onFreeTextCommit?.(annot);
      onFreeTextTab?.(annot, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onFreeTextCommit?.(annot);
      return;
    }
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
      class:moving={movingId === annot.id}
      style:left="{box.left}px"
      style:top="{box.top}px"
      style:width="{box.width}px"
      style:height="{box.height}px"
      style:color={annot.color}
      style:font-size="{annot.fontSize * viewport.scale}px"
      style:font-family={fontFamilyCss(annot.fontFamily)}
      style:font-weight={annot.bold ? "bold" : "normal"}
      style:font-style={annot.italic ? "italic" : "normal"}
      style:text-align={annot.align}
      style:background={annot.bgColor ?? (editing ? "rgb(255 255 255 / 75%)" : "transparent")}
      style:border={annot.borderColor && annot.borderWidth > 0 ? `${annot.borderWidth * viewport.scale}px solid ${annot.borderColor}` : "none"}
      style:opacity={annot.opacity}
      style:padding="{((annot.padding ?? 2) + (annot.borderColor ? annot.borderWidth : 0)) * viewport.scale}px"
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
      class:moving={movingId === annot.id}
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
      class:moving={movingId === selected.id}
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
        ondblclick={(event) => onHandleDblClick?.(event, selected, id)}
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
    transition: box-shadow 0.12s ease, opacity 0.12s ease;
  }

  .freetext.moving {
    opacity: 0.9;
    box-shadow: 0 8px 24px rgb(0 0 0 / 22%);
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
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }

  .note.moving {
    transform: scale(1.08);
    box-shadow: 0 8px 20px rgb(0 0 0 / 25%), 0 0 0 2px var(--accent);
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
    transition: box-shadow 0.12s ease, border-width 0.12s ease;
  }

  .outline.moving {
    border: 1.5px dashed var(--accent);
    background: rgb(37 99 235 / 12%);
    box-shadow: 0 4px 16px rgb(37 99 235 / 35%);
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
