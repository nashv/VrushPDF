<script lang="ts">
  /** Top chrome: file actions and zoom on one row, tools and their style on the next. */
  import type { AnnotKind } from "$lib/annotations/types";
  import { doc } from "$lib/state/doc.svelte";
  import { edits } from "$lib/state/edits.svelte";
  import { images } from "$lib/state/images.svelte";
  import { session } from "$lib/state/session.svelte";
  import { viewer, type Tool } from "$lib/state/viewer.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import StampPicker from "./StampPicker.svelte";

  let { onDrawSignature }: { onDrawSignature: () => void } = $props();

  interface ToolSpec {
    tool: Tool;
    icon: IconName;
    title: string;
    key: string;
  }

  const groups: ToolSpec[][] = [
    [
      { tool: "select", icon: "cursor", title: "Select", key: "V" },
      { tool: "pan", icon: "hand", title: "Pan", key: "H" },
      { tool: "text", icon: "text", title: "Select text", key: "T" },
    ],
    [
      { tool: "highlight", icon: "highlight", title: "Highlight", key: "1" },
      { tool: "underline", icon: "underline", title: "Underline", key: "2" },
      { tool: "strikeout", icon: "strikeout", title: "Strikeout", key: "3" },
      { tool: "squiggly", icon: "squiggly", title: "Squiggly underline", key: "4" },
    ],
    [
      { tool: "ink", icon: "pen", title: "Freehand pen", key: "P" },
      { tool: "eraser", icon: "eraser", title: "Erase ink", key: "E" },
    ],
    [
      { tool: "square", icon: "square", title: "Rectangle", key: "R" },
      { tool: "circle", icon: "circle", title: "Ellipse", key: "O" },
      { tool: "line", icon: "line", title: "Line", key: "L" },
      { tool: "arrow", icon: "arrow", title: "Arrow", key: "A" },
    ],
    [
      { tool: "freetext", icon: "textbox", title: "Text box", key: "X" },
      { tool: "note", icon: "note", title: "Sticky note", key: "N" },
    ],
  ];

  const SWATCHES = [
    "#fde047", "#fb923c", "#e11d48", "#a855f7",
    "#2563eb", "#0ea5e9", "#16a34a", "#111827",
  ];

  const open = $derived(doc.isOpen);
  /** The kind whose style the controls edit, or null for non-drawing tools. */
  const styledKind = $derived.by<AnnotKind | null>(() => {
    const tool = viewer.tool;
    return tool in viewer.styles ? (tool as AnnotKind) : null;
  });
  const style = $derived(styledKind ? viewer.styles[styledKind] : null);

  const showWidth = $derived(
    styledKind !== null &&
      ["ink", "square", "circle", "line", "arrow", "underline", "strikeout", "squiggly"].includes(
        styledKind,
      ),
  );
  const showFill = $derived(styledKind === "square" || styledKind === "circle");
  const showFontSize = $derived(styledKind === "freetext");

  const zoomLabel = $derived(`${Math.round(viewer.scale * 100)}%`);
  const pageCount = $derived(edits.pages.length);

  let stampOpen = $state(false);

  function setStyle(patch: Parameters<typeof viewer.setStyle>[1]) {
    if (styledKind) viewer.setStyle(styledKind, patch);
  }

  function gotoPage(value: string) {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) return;
    viewer.goToPage(Math.max(0, Math.min(n - 1, pageCount - 1)));
  }
</script>

<header class="toolbar">
  <div class="row">
    <button class="btn" title="Open… (⌘O)" onclick={() => session.openViaDialog()}>
      <Icon name="open" /> Open
    </button>
    <button class="btn" title="Save (⌘S)" disabled={!open} onclick={() => session.save()}>
      <Icon name="save" /> Save
    </button>
    <button class="btn square" title="Save As… (⇧⌘S)" disabled={!open} onclick={() => session.saveAs()}>
      <Icon name="save-as" />
    </button>

    {#if edits.dirty}
      <span class="dirty" title="Unsaved changes">●</span>
    {/if}

    <div class="divider"></div>

    <button
      class="btn square"
      title={edits.undoLabel ? `Undo ${edits.undoLabel} (⌘Z)` : "Undo (⌘Z)"}
      disabled={!edits.canUndo}
      onclick={() => edits.undo()}
    >
      <Icon name="undo" />
    </button>
    <button
      class="btn square"
      title={edits.redoLabel ? `Redo ${edits.redoLabel} (⇧⌘Z)` : "Redo (⇧⌘Z)"}
      disabled={!edits.canRedo}
      onclick={() => edits.redo()}
    >
      <Icon name="redo" />
    </button>

    <div class="title">
      {#if open}
        <span class="name">{doc.name}</span>
        {#if doc.wasEncrypted}
          <span class="badge" title="This file was encrypted. Saving writes it decrypted.">
            <Icon name="warning" size={12} /> decrypted on save
          </span>
        {/if}
      {:else}
        <span class="muted">No document</span>
      {/if}
    </div>

    <div class="divider"></div>

    <button class="btn square" title="Zoom out (⌘−)" disabled={!open} onclick={() => viewer.zoomBy(-1)}>
      <Icon name="zoom-out" />
    </button>
    <span class="zoom" title="Zoom level">{zoomLabel}</span>
    <button class="btn square" title="Zoom in (⌘+)" disabled={!open} onclick={() => viewer.zoomBy(1)}>
      <Icon name="zoom-in" />
    </button>
    <button
      class="btn square"
      class:selected={viewer.zoom === "fit-width"}
      title="Fit width"
      disabled={!open}
      onclick={() => viewer.zoomTo("fit-width")}
    >
      <Icon name="fit-width" />
    </button>
    <button
      class="btn square"
      class:selected={viewer.zoom === "fit-page"}
      title="Fit page (⌘0)"
      disabled={!open}
      onclick={() => viewer.zoomTo("fit-page")}
    >
      <Icon name="fit-page" />
    </button>

    <div class="divider"></div>

    <button
      class="btn square"
      title="Previous page"
      disabled={!open || viewer.currentPage === 0}
      onclick={() => viewer.goToPage(viewer.currentPage - 1)}
    >
      <Icon name="chevron-left" />
    </button>
    <span class="pages">
      <input
        class="field page-input"
        type="text"
        inputmode="numeric"
        value={viewer.currentPage + 1}
        disabled={!open}
        aria-label="Page number"
        onchange={(event) => gotoPage(event.currentTarget.value)}
      />
      <span class="muted">/ {pageCount || "–"}</span>
    </span>
    <button
      class="btn square"
      title="Next page"
      disabled={!open || viewer.currentPage >= pageCount - 1}
      onclick={() => viewer.goToPage(viewer.currentPage + 1)}
    >
      <Icon name="chevron-right" />
    </button>

    <div class="divider"></div>

    <button
      class="btn square"
      class:selected={viewer.sidebarOpen}
      title="Toggle sidebar"
      onclick={() => (viewer.sidebarOpen = !viewer.sidebarOpen)}
    >
      <Icon name="sidebar" />
    </button>
    <button
      class="btn square"
      class:selected={viewer.inspectorOpen}
      title="Toggle properties"
      onclick={() => (viewer.inspectorOpen = !viewer.inspectorOpen)}
    >
      <Icon name="inspector" />
    </button>
  </div>

  <div class="row tools">
    {#each groups as group, i (i)}
      {#if i > 0}<div class="divider"></div>{/if}
      {#each group as spec (spec.tool)}
        <button
          class="btn square"
          class:selected={viewer.tool === spec.tool}
          title="{spec.title} ({spec.key})"
          disabled={!open}
          onclick={() => viewer.setTool(spec.tool)}
        >
          <Icon name={spec.icon} />
        </button>
      {/each}
    {/each}

    <div class="divider"></div>

    <div class="stamp-wrap">
      <button
        class="btn"
        class:selected={viewer.tool === "stamp" || viewer.tool === "signature"}
        title="Stamps and signatures (S)"
        disabled={!open}
        onclick={() => (stampOpen = !stampOpen)}
      >
        <Icon name="signature" />
        {#if viewer.pendingStamp}
          {images.get(viewer.pendingStamp)?.name ?? "Stamp"}
        {:else}
          Stamp
        {/if}
        <Icon name="chevron-down" size={12} />
      </button>
      {#if stampOpen}
        <StampPicker
          onClose={() => (stampOpen = false)}
          onDraw={() => {
            stampOpen = false;
            onDrawSignature();
          }}
        />
      {/if}
    </div>

    {#if style && styledKind}
      <div class="divider"></div>

      <div class="style">
        <span class="swatches" role="group" aria-label="Colour">
          {#each SWATCHES as colour (colour)}
            <button
              type="button"
              class="swatch"
              class:on={style.color.toLowerCase() === colour}
              style:background={colour}
              title={colour}
              aria-label="Colour {colour}"
              onclick={() => setStyle({ color: colour })}
            ></button>
          {/each}
          <input
            type="color"
            class="picker"
            value={style.color}
            aria-label="Custom colour"
            title="Custom colour"
            oninput={(event) => setStyle({ color: event.currentTarget.value })}
          />
        </span>

        {#if showWidth}
          <label class="slider" title="Stroke width">
            <Icon name="pen" size={13} />
            <input
              type="range"
              min="0.5"
              max="12"
              step="0.5"
              value={style.width}
              oninput={(event) => setStyle({ width: Number(event.currentTarget.value) })}
            />
            <span class="num">{style.width}</span>
          </label>
        {/if}

        {#if showFontSize}
          <label class="slider" title="Font size">
            <Icon name="text" size={13} />
            <input
              type="range"
              min="6"
              max="48"
              step="1"
              value={style.fontSize}
              oninput={(event) => setStyle({ fontSize: Number(event.currentTarget.value) })}
            />
            <span class="num">{style.fontSize}</span>
          </label>
        {/if}

        <label class="slider" title="Opacity">
          <span class="opacity-icon" aria-hidden="true"></span>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={style.opacity}
            oninput={(event) => setStyle({ opacity: Number(event.currentTarget.value) })}
          />
          <span class="num">{Math.round(style.opacity * 100)}%</span>
        </label>

        {#if showFill}
          <label class="fill" title="Fill colour">
            <input
              type="checkbox"
              checked={style.fill !== null}
              onchange={(event) =>
                setStyle({ fill: event.currentTarget.checked ? style.color : null })}
            />
            Fill
            {#if style.fill !== null}
              <input
                type="color"
                class="picker"
                value={style.fill}
                aria-label="Fill colour"
                oninput={(event) => setStyle({ fill: event.currentTarget.value })}
              />
            {/if}
          </label>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .toolbar {
    flex: none;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--toolbar-h);
    padding: 0 8px;
  }

  .row.tools {
    height: 40px;
    border-top: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 0 10px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    padding: 1px 6px;
    border-radius: 99px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 11px;
  }

  .dirty {
    color: var(--accent);
    font-size: 16px;
    line-height: 1;
  }

  .zoom {
    min-width: 46px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .pages {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .page-input {
    width: 44px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .stamp-wrap {
    position: relative;
  }

  .style {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .swatches {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .swatch {
    width: 18px;
    height: 18px;
    border: 1px solid rgb(0 0 0 / 22%);
    border-radius: 4px;
  }

  .swatch.on {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .picker {
    width: 22px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  .slider {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
  }

  .slider input[type="range"] {
    width: 72px;
    accent-color: var(--accent);
  }

  .num {
    min-width: 30px;
    font-variant-numeric: tabular-nums;
  }

  /* A half-filled square reads as "opacity" without needing a label. */
  .opacity-icon {
    width: 13px;
    height: 13px;
    border: 1.5px solid currentColor;
    border-radius: 3px;
    background: linear-gradient(135deg, currentColor 50%, transparent 50%);
  }

  .fill {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
  }
</style>
