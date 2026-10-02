<script lang="ts">
  /**
   * Floating comment popup that appears directly at the cursor / annotation.
   *
   * Provides rapid in-place comment entry and editing:
   * - Shows quoted text preview when commenting on selected text markup.
   * - Autofocuses the comment textarea immediately.
   * - Commits via Enter / Cmd+Enter or Save button.
   * - Closes on Escape or outside click, auto-discarding empty new notes.
   */
  import Icon from "./Icon.svelte";
  import { isTextMarkup, type Annot } from "$lib/annotations/types";

  let {
    annot,
    x,
    y,
    pageWidth,
    pageHeight,
    isNew = false,
    onSave,
    onDelete,
    onClose,
  }: {
    annot: Annot;
    x: number;
    y: number;
    pageWidth: number;
    pageHeight: number;
    isNew?: boolean;
    onSave: (contents: string) => void;
    onDelete: () => void;
    onClose: () => void;
  } = $props();

  let popupEl: HTMLDivElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let commentText = $state("");

  $effect.pre(() => {
    commentText = annot.contents ?? "";
  });

  const popupWidth = 280;
  const popupHeight = 180;

  // Position adjacent to cursor/point, flipped if near page boundaries
  const left = $derived.by(() => {
    if (x + popupWidth + 16 > pageWidth) {
      return Math.max(8, x - popupWidth - 12);
    }
    return Math.max(8, x + 12);
  });

  const top = $derived.by(() => {
    if (y + popupHeight + 16 > pageHeight) {
      return Math.max(8, y - popupHeight - 12);
    }
    return Math.max(8, y - 8);
  });

  function focusOnMount(node: HTMLTextAreaElement) {
    textareaEl = node;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }

  function handleSave() {
    onSave(commentText);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if ((event.key === "Enter" && (event.metaKey || event.ctrlKey)) || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      handleSave();
      return;
    }
  }

  $effect(() => {
    function onPointerDownOutside(event: PointerEvent) {
      if (popupEl && !popupEl.contains(event.target as Node)) {
        if (commentText.trim().length > 0) {
          handleSave();
        } else {
          onClose();
        }
      }
    }

    // Capture on next tick so opening click doesn't instantly close
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDownOutside, { capture: true });
    }, 50);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDownOutside, { capture: true });
    };
  });
</script>

<div
  bind:this={popupEl}
  class="comment-popup"
  style:left="{left}px"
  style:top="{top}px"
  role="dialog"
  aria-label="Comment"
>
  <header class="popup-header">
    <div class="header-title">
      <span class="icon-wrap" style:color={annot.color || "var(--accent)"}>
        <Icon name="note" size={14} />
      </span>
      <span class="title-text">
        {isTextMarkup(annot) ? "Comment on selection" : "Comment"}
      </span>
    </div>
    <button
      type="button"
      class="btn-icon"
      title="Close"
      aria-label="Close comment"
      onclick={onClose}
    >
      <Icon name="close" size={12} />
    </button>
  </header>

  {#if isTextMarkup(annot) && annot.quotedText}
    <div class="quote-preview" title={annot.quotedText}>
      "{annot.quotedText}"
    </div>
  {/if}

  <div class="body">
    <textarea
      bind:value={commentText}
      placeholder="Type your comment…"
      rows="3"
      onkeydown={handleKeydown}
      {@attach focusOnMount}
    ></textarea>
  </div>

  <footer class="popup-footer">
    {#if !isNew}
      <button
        type="button"
        class="btn-icon danger"
        title="Delete comment"
        aria-label="Delete comment"
        onclick={onDelete}
      >
        <Icon name="trash" size={14} />
      </button>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="btn outlined small"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="btn primary small"
      onclick={handleSave}
    >
      Save
    </button>
  </footer>
</div>

<style>
  .comment-popup {
    position: absolute;
    z-index: 101;
    width: 280px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    box-shadow: var(--shadow-3);
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: popup-enter 0.12s ease-out;
    user-select: none;
  }

  @keyframes popup-enter {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 2px;
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }

  .icon-wrap {
    display: flex;
    align-items: center;
  }

  .quote-preview {
    font-size: 11px;
    font-style: italic;
    color: var(--text-muted);
    background: var(--bg-hover);
    padding: 4px 6px;
    border-left: 2px solid var(--accent);
    border-radius: var(--radius);
    max-height: 48px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    user-select: text;
  }

  .body {
    display: flex;
    flex-direction: column;
  }

  .body textarea {
    width: 100%;
    min-height: 64px;
    max-height: 160px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: var(--text);
    font-family: inherit;
    font-size: var(--font-size);
    line-height: 1.35;
    resize: vertical;
    outline: none;
    user-select: text;
    transition: border-color 0.1s ease;
  }

  .body textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .popup-footer {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .spacer {
    flex: 1;
  }

  .btn.small {
    height: 24px;
    padding: 0 10px;
    font-size: 12px;
  }

  .btn-icon {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background-color 0.08s ease, color 0.08s ease;
  }

  .btn-icon:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .btn-icon.danger:hover {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
