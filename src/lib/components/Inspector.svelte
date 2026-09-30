<script lang="ts">
  /** Right panel: properties and comment of the selected annotation. */
  import {
    annotBounds,
    hasRect,
    isBoxShape,
    isFreeText,
    isInk,
    isLineShape,
    isNote,
    isStamp,
    isTextMarkup,
    setFreeTextText,
    type Annot,
    type NoteAnnot,
    type Rotation,
  } from "$lib/annotations/types";
  import { images } from "$lib/state/images.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  let { tab }: { tab: DocumentTab } = $props();
  const edits = $derived(tab.edits);

  const annot = $derived(edits.selected);

  const KIND_LABEL: Record<Annot["kind"], string> = {
    highlight: "Highlight",
    underline: "Underline",
    strikeout: "Strikeout",
    squiggly: "Squiggly underline",
    ink: "Drawing",
    square: "Rectangle",
    circle: "Ellipse",
    line: "Line",
    arrow: "Arrow",
    freetext: "Text box",
    note: "Comment",
    stamp: "Stamp",
  };

  const NOTE_ICONS: NoteAnnot["icon"][] = [
    "Comment", "Note", "Help", "Key", "NewParagraph", "Paragraph", "Insert",
  ];

  const hasStroke = $derived(
    annot !== null && (isInk(annot) || isLineShape(annot) || isBoxShape(annot)),
  );

  const patch = (changes: Partial<Annot>) => {
    if (annot) edits.update(annot.id, changes as Partial<Annot>, "Change properties");
  };

  function setText(text: string) {
    if (annot && isFreeText(annot)) {
      edits.update(annot.id, () => setFreeTextText(annot, text), "Edit text");
    }
  }

  const pageNumber = $derived(annot ? edits.pageIndexOf(annot.pageId) + 1 : 0);

  const formatted = $derived.by(() => {
    if (!annot) return null;
    const b = annotBounds(annot);
    const round = (n: number) => Math.round(n);
    return `${round(b.w)} × ${round(b.h)} pt at ${round(b.x)}, ${round(b.y)}`;
  });

  const when = $derived.by(() => {
    if (!annot) return "";
    const date = new Date(annot.modifiedAt);
    return Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  });
</script>

<aside class="inspector scroll" style:width="{viewer.panelWidth.inspector}px">
  {#if !annot}
    <div class="empty muted">
      <Icon name="cursor" size={20} />
      <p>Select an annotation to edit its properties.</p>
      <p class="tip">
        Double-click a text box to edit it. Press <kbd>V</kbd> for the select tool.
      </p>
    </div>
  {:else}
    <header>
      <h2>{KIND_LABEL[annot.kind]}</h2>
      <span class="muted">Page {pageNumber}</span>
    </header>

    {#if isFreeText(annot)}
      <section>
        <span class="label" id="ft-text">Text</span>
        <textarea
          class="field"
          rows="3"
          aria-labelledby="ft-text"
          value={annot.text}
          oninput={(event) => setText(event.currentTarget.value)}
        ></textarea>
      </section>
    {/if}

    {#if isTextMarkup(annot) && annot.quotedText}
      <section>
        <span class="label">Quoted text</span>
        <blockquote>{annot.quotedText}</blockquote>
      </section>
    {/if}

    {#if !isFreeText(annot)}
      <section>
        <span class="label" id="comment">Comment</span>
        <textarea
          class="field"
          rows="3"
          placeholder="Add a comment…"
          aria-labelledby="comment"
          value={annot.contents}
          oninput={(event) => patch({ contents: event.currentTarget.value })}
        ></textarea>
      </section>
    {/if}

    <section class="grid">
      <label>
        <span class="label">{isBoxShape(annot) ? "Stroke" : "Colour"}</span>
        <input
          type="color"
          value={annot.color}
          oninput={(event) => patch({ color: event.currentTarget.value })}
        />
      </label>

      {#if isBoxShape(annot)}
        <label>
          <span class="label">Fill</span>
          <span class="fill-row">
            <input
              type="checkbox"
              checked={annot.fill !== null}
              aria-label="Filled"
              onchange={(event) =>
                patch({ fill: event.currentTarget.checked ? annot.color : null })}
            />
            {#if annot.fill !== null}
              <input
                type="color"
                value={annot.fill}
                aria-label="Fill colour"
                oninput={(event) => patch({ fill: event.currentTarget.value })}
              />
            {/if}
          </span>
        </label>
      {/if}
    </section>

    <section>
      <span class="label" id="opacity">Opacity — {Math.round(annot.opacity * 100)}%</span>
      <input
        type="range"
        min="0.1"
        max="1"
        step="0.05"
        aria-labelledby="opacity"
        value={annot.opacity}
        oninput={(event) => patch({ opacity: Number(event.currentTarget.value) })}
      />
    </section>

    {#if hasStroke}
      <section>
        <span class="label" id="width">
          Stroke width — {(annot as { width: number }).width}pt
        </span>
        <input
          type="range"
          min="0"
          max="12"
          step="0.5"
          aria-labelledby="width"
          value={(annot as { width: number }).width}
          oninput={(event) => patch({ width: Number(event.currentTarget.value) } as Partial<Annot>)}
        />
      </section>
    {/if}

    {#if isFreeText(annot)}
      <section>
        <span class="label" id="fontsize">Font size — {annot.fontSize}pt</span>
        <input
          type="range"
          min="6"
          max="48"
          step="1"
          aria-labelledby="fontsize"
          value={annot.fontSize}
          oninput={(event) => patch({ fontSize: Number(event.currentTarget.value) } as Partial<Annot>)}
        />
      </section>
      <section>
        <span class="label">Alignment</span>
        <div class="segmented" role="group" aria-label="Alignment">
          {#each ["left", "center", "right"] as align (align)}
            <button
              class="seg"
              class:on={annot.align === align}
              onclick={() => patch({ align } as Partial<Annot>)}
            >
              {align}
            </button>
          {/each}
        </div>
      </section>
      <section>
        <span class="label">Background</span>
        <span class="fill-row">
          <input
            type="checkbox"
            checked={annot.bgColor !== null}
            aria-label="Filled background"
            onchange={(event) =>
              patch({ bgColor: event.currentTarget.checked ? "#fef9c3" : null } as Partial<Annot>)}
          />
          {#if annot.bgColor !== null}
            <input
              type="color"
              value={annot.bgColor}
              aria-label="Background colour"
              oninput={(event) => patch({ bgColor: event.currentTarget.value } as Partial<Annot>)}
            />
          {/if}
        </span>
      </section>
    {/if}

    {#if isNote(annot)}
      <section>
        <span class="label">Icon</span>
        <select
          class="field"
          value={annot.icon}
          aria-label="Comment icon"
          onchange={(event) => patch({ icon: event.currentTarget.value } as Partial<Annot>)}
        >
          {#each NOTE_ICONS as icon (icon)}
            <option value={icon}>{icon}</option>
          {/each}
        </select>
      </section>
    {/if}

    {#if isStamp(annot)}
      <section>
        <span class="label">Image</span>
        {#if images.get(annot.imageId)}
          <img class="stamp-preview" src={images.get(annot.imageId)?.url} alt="" />
        {:else}
          <p class="warn">
            <Icon name="warning" size={13} />
            This stamp's image isn't loaded, so it can't be saved. Delete it or place a new one.
          </p>
        {/if}
      </section>
      <section>
        <span class="label">Rotation</span>
        <div class="segmented" role="group" aria-label="Rotation">
          {#each [0, 90, 180, 270] as deg (deg)}
            <button
              class="seg"
              class:on={annot.rotation === deg}
              onclick={() => patch({ rotation: deg as Rotation } as Partial<Annot>)}
            >
              {deg}°
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <section class="meta">
      {#if formatted}<div>{formatted}</div>{/if}
      {#if when}<div>Edited {when}</div>{/if}
      {#if annot.author}<div>By {annot.author}</div>{/if}
    </section>

    <footer>
      {#if hasRect(annot) || isInk(annot) || isLineShape(annot)}
        <button class="btn outlined" title="Bring to front" onclick={() => edits.bringToFront(annot.id)}>
          <Icon name="front" /> Front
        </button>
      {/if}
      <span class="spacer"></span>
      <button
        class="btn danger"
        onclick={() => {
          edits.remove(annot.id);
          viewer.setTool("select");
        }}
      >
        <Icon name="trash" /> Delete
      </button>
    </footer>
  {/if}
</aside>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 14px;
    flex: none;
    width: var(--inspector-w);
    /* See the sidebar: keeps the viewer alive on a narrow window. */
    max-width: 40%;
    min-height: 0;
    padding: 12px;
    border-left: 1px solid var(--border);
    background: var(--bg-raised);
  }

  /* See the sidebar: overlay the viewer instead of competing for width. */
  @media (max-width: 899px) {
    .inspector {
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      z-index: 30;
      max-width: 80%;
      box-shadow: var(--shadow-3);
    }
  }

  /* Liquid Glass (macOS): an inset card, as the sidebar is. */
  :global([data-glass]) .inspector {
    border-left: none;
    border-radius: var(--pane-radius);
    background: var(--pane-fill);
    box-shadow: var(--glass-edge), var(--glass-lift);
  }

  @media (max-width: 899px) {
    :global([data-glass]) .inspector {
      right: var(--pane-gap);
      bottom: var(--pane-gap);
      background: var(--surface-float);
      backdrop-filter: var(--surface-float-filter);
    }
  }

  /* Centred in the panel rather than pinned near the top, which left it
     floating above a large empty area. */
  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 16px 24px;
    text-align: center;
  }

  .empty p {
    margin: 0;
    line-height: 1.5;
  }

  .tip {
    color: var(--text-faint);
  }

  kbd {
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg);
    font-family: inherit;
    font-size: 11px;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  h2 {
    margin: 0;
    font-size: 14px;
  }

  section {
    display: flex;
    flex-direction: column;
  }

  section.grid {
    flex-direction: row;
    gap: 16px;
  }

  section.grid label {
    display: flex;
    flex-direction: column;
  }

  input[type="color"] {
    width: 44px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }

  .fill-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
  }

  blockquote {
    margin: 0;
    padding: 6px 8px;
    border-left: 2px solid var(--border-strong);
    background: var(--bg);
    border-radius: 0 var(--radius) var(--radius) 0;
    color: var(--text-muted);
    font-style: italic;
    user-select: text;
  }

  .segmented {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .seg {
    flex: 1;
    padding: 4px 0;
    text-transform: capitalize;
    font-size: 12px;
  }

  .seg + .seg {
    border-left: 1px solid var(--border);
  }

  .seg.on {
    background: var(--accent);
    color: var(--accent-text);
  }

  :global([data-glass]) .segmented {
    border-radius: 999px;
    background: var(--glass-track);
    border: none;
    padding: 2px;
    gap: 2px;
  }

  :global([data-glass]) .seg {
    border-radius: 999px;
  }

  :global([data-glass]) .seg + .seg {
    border-left: none;
  }

  :global([data-glass]) .seg.on {
    background: var(--glass-fill);
    box-shadow: var(--glass-edge);
    color: var(--text);
  }

  :global([data-platform="gnome"]) .segmented,
  :global([data-platform="linux"]) .segmented {
    border-radius: 6px;
    background: var(--bg-sunken);
    border: none;
    padding: 2px;
    gap: 2px;
  }

  :global([data-platform="gnome"]) .seg,
  :global([data-platform="linux"]) .seg {
    border-radius: 5px;
  }

  :global([data-platform="gnome"]) .seg + .seg,
  :global([data-platform="linux"]) .seg + .seg {
    border-left: none;
  }

  :global([data-platform="gnome"]) .seg.on,
  :global([data-platform="linux"]) .seg.on {
    background: var(--bg-raised);
    box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
    color: var(--text);
  }

  :global([data-platform="win"]) .segmented {
    border-radius: 4px;
  }

  :global([data-platform="win"]) .seg {
    border-radius: 2px;
  }

  :global([data-platform="kde"]) .segmented {
    border-radius: 3px;
    border-color: var(--border);
  }

  :global([data-platform="kde"]) .seg {
    border-radius: 2px;
  }

  .stamp-preview {
    width: 100%;
    max-height: 90px;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #ffffff;
  }

  .warn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    color: var(--danger);
    line-height: 1.45;
  }

  .meta {
    gap: 2px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font-size: 11px;
  }

  footer {
    display: flex;
    align-items: center;
    margin-top: auto;
    padding-top: 6px;
  }

  .spacer {
    flex: 1;
  }
</style>
