<script lang="ts">
  /**
   * Floating context menu shown when right-clicking on a PDF page.
   *
   * Displays context-aware options:
   * - When text is selected: Comment on Selection, Highlight, Underline, Strikeout, Copy
   * - When an existing annotation is clicked: Edit Comment, Delete
   * - Anywhere else on the page: Add Comment, Add Text Box
   */
  import Icon from "./Icon.svelte";
  import type { Annot } from "$lib/annotations/types";

  let {
    x,
    y,
    pageWidth,
    pageHeight,
    hasSelection,
    selectedText = "",
    hasTargetAnnot,
    targetAnnot = null,
    onAddComment,
    onHighlight,
    onUnderline,
    onStrikeout,
    onCopyText,
    onAddTextBox,
    onEditComment,
    onDeleteAnnot,
    onClose,
  }: {
    x: number;
    y: number;
    pageWidth: number;
    pageHeight: number;
    hasSelection: boolean;
    selectedText?: string;
    hasTargetAnnot: boolean;
    targetAnnot?: Annot | null;
    onAddComment: () => void;
    onHighlight: () => void;
    onUnderline: () => void;
    onStrikeout: () => void;
    onCopyText: () => void;
    onAddTextBox: () => void;
    onEditComment: () => void;
    onDeleteAnnot: () => void;
    onClose: () => void;
  } = $props();

  let menuEl: HTMLDivElement | undefined = $state();

  const menuWidth = 190;
  const menuHeight = $derived(hasSelection ? 200 : hasTargetAnnot ? 90 : 90);

  const left = $derived(
    x + menuWidth > pageWidth ? Math.max(8, x - menuWidth) : Math.max(8, x)
  );
  const top = $derived(
    y + menuHeight > pageHeight ? Math.max(8, y - menuHeight) : Math.max(8, y)
  );

  $effect(() => {
    function onPointerDownOutside(event: PointerEvent) {
      if (menuEl && !menuEl.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }

    window.addEventListener("pointerdown", onPointerDownOutside, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDownOutside, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  });
</script>

<div
  bind:this={menuEl}
  class="context-menu"
  style:left="{left}px"
  style:top="{top}px"
  role="menu"
  tabindex="-1"
>
  {#if hasSelection}
    <div class="menu-header">
      <span class="selection-preview" title={selectedText}>"{selectedText}"</span>
    </div>
    <button type="button" class="menu-item primary-action" role="menuitem" onclick={onAddComment}>
      <Icon name="note" size={15} />
      <span>Add Comment</span>
    </button>
    <div class="menu-divider"></div>
    <button type="button" class="menu-item" role="menuitem" onclick={onHighlight}>
      <Icon name="highlight" size={15} />
      <span>Highlight</span>
    </button>
    <button type="button" class="menu-item" role="menuitem" onclick={onUnderline}>
      <Icon name="underline" size={15} />
      <span>Underline</span>
    </button>
    <button type="button" class="menu-item" role="menuitem" onclick={onStrikeout}>
      <Icon name="strikeout" size={15} />
      <span>Strikeout</span>
    </button>
    <div class="menu-divider"></div>
    <button type="button" class="menu-item" role="menuitem" onclick={onCopyText}>
      <Icon name="file" size={15} />
      <span>Copy Text</span>
    </button>
  {:else if hasTargetAnnot}
    <button type="button" class="menu-item primary-action" role="menuitem" onclick={onEditComment}>
      <Icon name="note" size={15} />
      <span>{targetAnnot?.contents ? "Edit Comment" : "Add Comment"}</span>
    </button>
    <div class="menu-divider"></div>
    <button type="button" class="menu-item danger" role="menuitem" onclick={onDeleteAnnot}>
      <Icon name="trash" size={15} />
      <span>Delete</span>
    </button>
  {:else}
    <button type="button" class="menu-item primary-action" role="menuitem" onclick={onAddComment}>
      <Icon name="note" size={15} />
      <span>Add Comment</span>
    </button>
    <button type="button" class="menu-item" role="menuitem" onclick={onAddTextBox}>
      <Icon name="textbox" size={15} />
      <span>Add Text Box</span>
    </button>
  {/if}
</div>

<style>
  .context-menu {
    position: absolute;
    z-index: 100;
    min-width: 175px;
    max-width: 240px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    box-shadow: var(--shadow-3);
    user-select: none;
    animation: menu-pop 0.1s ease-out;
  }

  @keyframes menu-pop {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .menu-header {
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }

  .selection-preview {
    display: block;
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-style: italic;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: var(--font-size);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.08s ease, color 0.08s ease;
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--bg-hover);
    outline: none;
  }

  .menu-item.primary-action {
    font-weight: 500;
    color: var(--accent);
  }

  .menu-item.primary-action:hover {
    background: var(--accent-soft);
  }

  .menu-item.danger {
    color: var(--danger);
  }

  .menu-item.danger:hover {
    background: var(--danger-soft);
  }

  .menu-divider {
    height: 1px;
    margin: 4px 0;
    background: var(--border);
  }
</style>
