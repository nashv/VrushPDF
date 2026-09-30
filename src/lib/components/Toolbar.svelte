<script lang="ts">
  /** Top chrome: file actions and zoom on one row, tools and their style on the next. */
  import type { AnnotKind } from "$lib/annotations/types";
  import { images } from "$lib/state/images.svelte";
  import { license } from "$lib/state/license.svelte";
  import { session } from "$lib/state/session.svelte";
  import { viewer, type Tool } from "$lib/state/viewer.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import { hasGlass } from "$lib/platform";
  import Icon, { type IconName } from "./Icon.svelte";
  import StampPicker from "./StampPicker.svelte";
  import SignaturePicker from "./SignaturePicker.svelte";

  let {
    tab,
    onDrawSignature,
  }: { tab: DocumentTab | null; onDrawSignature: () => void } = $props();

  interface ToolSpec {
    tool: Tool;
    icon: IconName;
    title: string;
    key: string;
    /** Button label when labels are on; `title` is tooltip prose, often too long. */
    short?: string;
  }

  const groups: ToolSpec[][] = [
    [
      { tool: "select", icon: "cursor", title: "Select", key: "V" },
      { tool: "pan", icon: "hand", title: "Pan", key: "H" },
      { tool: "text", icon: "text", title: "Select text", key: "T", short: "Text" },
    ],
    [
      { tool: "highlight", icon: "highlight", title: "Highlight", key: "1" },
      { tool: "underline", icon: "underline", title: "Underline", key: "2" },
      { tool: "strikeout", icon: "strikeout", title: "Strikeout", key: "3" },
      { tool: "squiggly", icon: "squiggly", title: "Squiggly underline", key: "4", short: "Squiggly" },
    ],
    [
      { tool: "ink", icon: "pen", title: "Freehand pen", key: "P", short: "Pen" },
      { tool: "eraser", icon: "eraser", title: "Erase ink", key: "E", short: "Eraser" },
    ],
    [
      { tool: "square", icon: "square", title: "Rectangle", key: "R" },
      { tool: "circle", icon: "circle", title: "Ellipse", key: "O" },
      { tool: "line", icon: "line", title: "Line", key: "L" },
      { tool: "arrow", icon: "arrow", title: "Arrow", key: "A" },
    ],
    [
      { tool: "freetext", icon: "textbox", title: "Text box", key: "X" },
      { tool: "note", icon: "note", title: "Comment", key: "N" },
    ],
  ];

  const SWATCHES = [
    "#fde047", "#fb923c", "#e11d48", "#a855f7",
    "#2563eb", "#0ea5e9", "#16a34a", "#111827",
  ];

  const open = $derived(tab?.isOpen === true);
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

  const zoomLabel = $derived(`${Math.round((tab?.view.scale ?? 1) * 100)}%`);
  const pageCount = $derived(tab?.edits.pages.length ?? 0);
  const currentPage = $derived(tab?.view.currentPage ?? 0);

  let stampOpen = $state(false);
  let signatureOpen = $state(false);

  /** The trial capsule's text; null once licensed. */
  const trialLabel = $derived.by(() => {
    const status = license.status;
    if (!status || status.state === "licensed") return null;
    if (status.state === "trial") {
      const days = status.daysLeft ?? 0;
      return `Trial: ${days} ${days === 1 ? "day" : "days"} left`;
    }
    return status.state === "revoked" ? "License revoked" : "Trial ended";
  });

  /*
   * Under glass the title bar is gone and this is the top of the window, so its
   * empty stretches have to move it. Only there: elsewhere the system title bar
   * does that, and a toolbar that drags the window would be a surprise.
   */
  const drag = hasGlass ? "" : undefined;

  function setStyle(patch: Parameters<typeof viewer.setStyle>[1]) {
    if (styledKind) viewer.setStyle(styledKind, patch);
  }

  function gotoPage(value: string) {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || !tab) return;
    tab.view.goToPage(Math.max(0, Math.min(n - 1, pageCount - 1)));
  }
</script>

<!--
  `.cluster` groups the buttons that share a glass capsule on macOS. Everywhere
  else it is `display: contents` and the dividers between clusters do the job.
-->
<header class="toolbar" class:labels={viewer.toolbarLabels} data-tauri-drag-region={drag}>
  <div class="row" data-tauri-drag-region={drag}>
    <div class="cluster glass">
      <button
        class="btn square"
        class:selected={viewer.sidebarOpen}
        title="Toggle sidebar (⌘\)"
        onclick={() => (viewer.sidebarOpen = !viewer.sidebarOpen)}
      >
        <Icon name="sidebar" />
        <span class="btn-label">Sidebar</span>
      </button>
    </div>

    <div class="divider"></div>

    <div class="cluster glass">
      <button class="btn square" title="Open… (⌘O)" onclick={() => session.openViaDialog()}>
        <Icon name="open" />
        <span class="btn-label">Open</span>
      </button>
      <button class="btn square" title="Merge PDFs…" onclick={() => session.openMergeDialog()}>
        <Icon name="merge" />
        <span class="btn-label">Merge</span>
      </button>
      <button class="btn square" title="Save (⌘S)" disabled={!open} onclick={() => session.save()}>
        <Icon name="save" />
        <span class="btn-label">Save</span>
      </button>
      <button class="btn square" title="Save As… (⇧⌘S)" disabled={!open} onclick={() => session.saveAs()}>
        <Icon name="save-as" />
        <span class="btn-label">Save As</span>
      </button>
      <button class="btn square" title="Save Flattened… (⌥⌘S)" disabled={!open} onclick={() => session.saveFlattened()}>
        <Icon name="save-flattened" />
        <span class="btn-label">Flatten</span>
      </button>
      <button class="btn square" title="Optimize PDF… (⌥⌘O)" disabled={!open} onclick={() => session.openOptimizeDialog()}>
        <Icon name="optimize" />
        <span class="btn-label">Optimize</span>
      </button>
      <button class="btn square" title="Print… (⌘P)" disabled={!open} onclick={() => session.print()}>
        <Icon name="print" />
        <span class="btn-label">Print</span>
      </button>
    </div>

    <div class="divider"></div>

    <div class="cluster glass">
      <button
        class="btn square"
        title={tab?.edits.undoLabel ? `Undo ${tab.edits.undoLabel} (⌘Z)` : "Undo (⌘Z)"}
        disabled={!tab?.edits.canUndo}
        onclick={() => tab?.edits.undo()}
      >
        <Icon name="undo" />
        <span class="btn-label">Undo</span>
      </button>
      <button
        class="btn square"
        title={tab?.edits.redoLabel ? `Redo ${tab.edits.redoLabel} (⇧⌘Z)` : "Redo (⇧⌘Z)"}
        disabled={!tab?.edits.canRedo}
        onclick={() => tab?.edits.redo()}
      >
        <Icon name="redo" />
        <span class="btn-label">Redo</span>
      </button>
    </div>

    {#if trialLabel}
      <button
        class="trial glass"
        class:ended={!license.canEdit}
        title={license.canEdit ? "Enter a license key or buy VrushPDF" : "Saving and editing need a license"}
        onclick={() => license.openDialog()}
      >
        {trialLabel}{license.canEdit ? "" : " · Buy"}
      </button>
    {/if}

    {#if tab?.doc.wasEncrypted}
      <span class="badge" title="This file is password protected and encrypted.">
        <Icon name="lock" size={12} /> encrypted
      </span>
    {/if}

    <span class="spacer" data-tauri-drag-region={drag}></span>

    <div class="cluster glass">
      <button class="btn square" title="Zoom out (⌘−)" disabled={!open} onclick={() => tab?.view.zoomBy(-1)}>
        <Icon name="zoom-out" />
        <span class="btn-label">Zoom Out</span>
      </button>
      <span class="zoom" title="Zoom level">{zoomLabel}</span>
      <button class="btn square" title="Zoom in (⌘+)" disabled={!open} onclick={() => tab?.view.zoomBy(1)}>
        <Icon name="zoom-in" />
        <span class="btn-label">Zoom In</span>
      </button>
      <button
        class="btn square"
        class:selected={tab?.view.zoom === "fit-width"}
        title="Fit width"
        disabled={!open}
        onclick={() => tab?.view.zoomTo("fit-width")}
      >
        <Icon name="fit-width" />
        <span class="btn-label">Fit Width</span>
      </button>
      <button
        class="btn square"
        class:selected={tab?.view.zoom === "fit-page"}
        title="Fit page (⌘0)"
        disabled={!open}
        onclick={() => tab?.view.zoomTo("fit-page")}
      >
        <Icon name="fit-page" />
        <span class="btn-label">Fit Page</span>
      </button>
    </div>

    <div class="divider"></div>

    <div class="cluster glass">
      <button
        class="btn square"
        title="Previous page"
        disabled={!open || currentPage === 0}
        onclick={() => tab?.view.goToPage(currentPage - 1)}
      >
        <Icon name="chevron-left" />
        <span class="btn-label">Previous</span>
      </button>
      <span class="pages">
        <input
          class="field page-input"
          type="text"
          inputmode="numeric"
          value={currentPage + 1}
          disabled={!open}
          aria-label="Page number"
          onchange={(event) => gotoPage(event.currentTarget.value)}
        />
        <span class="muted">/ {pageCount || "–"}</span>
      </span>
      <button
        class="btn square"
        title="Next page"
        disabled={!open || currentPage >= pageCount - 1}
        onclick={() => tab?.view.goToPage(currentPage + 1)}
      >
        <Icon name="chevron-right" />
        <span class="btn-label">Next</span>
      </button>
    </div>

    <div class="divider"></div>

    <div class="cluster glass">
      <button
        class="btn square"
        class:selected={viewer.inspectorOpen}
        title="Toggle properties"
        onclick={() => (viewer.inspectorOpen = !viewer.inspectorOpen)}
      >
        <Icon name="inspector" />
        <span class="btn-label">Properties</span>
      </button>
    </div>
  </div>

  <div class="row tools" data-tauri-drag-region={drag}>
    <div class="tool-group" data-tauri-drag-region={drag}>
      {#each groups as group, i (i)}
        {#if i > 0}<div class="divider"></div>{/if}
        <div class="cluster glass">
          {#each group as spec (spec.tool)}
            <button
              class="btn square"
              class:selected={viewer.tool === spec.tool}
              title="{spec.title} ({spec.key})"
              disabled={!open || !license.allowsTool(spec.tool)}
              onclick={() => viewer.setTool(spec.tool)}
            >
              <Icon name={spec.icon} />
              <span class="btn-label">{spec.short ?? spec.title}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>

    <!--
      Deliberately outside .tool-group: that is a scroll container, and an
      `overflow-x` of anything but `visible` forces `overflow-y` to clip too, so
      a dropdown anchored here would be cut off at the 40px row. Same reasoning
      as the style controls below.
    -->
    <div class="divider"></div>

    <div class="cluster glass">
      <div class="popover-wrap">
        <button
          class="btn square"
          class:selected={viewer.tool === "stamp"}
          title="Stamps"
          disabled={!open || !license.canEdit}
          onclick={() => {
            stampOpen = !stampOpen;
            if (stampOpen) signatureOpen = false;
          }}
        >
          <Icon name="stamp" />
          <span class="btn-label">Stamp</span>
        </button>
        {#if stampOpen}
          <StampPicker onClose={() => (stampOpen = false)} />
        {/if}
      </div>

      <div class="popover-wrap">
        <button
          class="btn square"
          class:selected={viewer.tool === "signature"}
          title="Signatures (S)"
          disabled={!open || !license.canEdit}
          onclick={() => {
            signatureOpen = !signatureOpen;
            if (signatureOpen) stampOpen = false;
          }}
        >
          <Icon name="signature" />
          <span class="btn-label">Signature</span>
        </button>
        {#if signatureOpen}
          <SignaturePicker
            onClose={() => (signatureOpen = false)}
            onDraw={() => {
              signatureOpen = false;
              onDrawSignature();
            }}
          />
        {/if}
      </div>
    </div>

    <span class="spacer" data-tauri-drag-region={drag}></span>

    {#if style && styledKind}
      <div class="style glass">
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
    /*
     * Scroll rather than clip in a narrow window. Deliberately on `.row` and
     * never on `.row.tools`: an overflow there clips the stamp dropdown, which
     * is exactly the bug that made the Stamp button look dead.
     */
    overflow-x: auto;
    scrollbar-width: none;
  }

  .row::-webkit-scrollbar {
    display: none;
  }

  .row.tools {
    height: 40px;
    border-top: 1px solid var(--border);
    /* Must stay visible: the tool row hosts the stamp dropdown. */
    overflow: visible;
  }

  /*
   * Icon-and-text mode, as in a native macOS toolbar: the label goes under the
   * icon, buttons size to their text, and the rows grow to fit.
   */
  .btn-label {
    display: none;
    font-size: 10px;
    line-height: 1;
    color: var(--text-muted);
  }

  .toolbar.labels .row {
    height: auto;
    min-height: var(--toolbar-h);
    padding-top: 5px;
    padding-bottom: 5px;
  }

  .toolbar.labels .row.tools {
    min-height: 40px;
  }

  .toolbar.labels :global(.btn) {
    flex-direction: column;
    gap: 3px;
    height: auto;
    min-height: 40px;
    padding: 4px 7px;
  }

  .toolbar.labels :global(.btn.square) {
    width: auto;
    padding: 4px 7px;
  }

  .toolbar.labels .btn-label {
    display: block;
  }

  /* The style controls are not action buttons; leave their swatches alone. */
  .toolbar.labels .style :global(.btn) {
    flex-direction: row;
  }

  .spacer {
    flex: 1;
    min-width: 8px;
  }

  /*
   * Only the tools scroll. Keeping the style controls out of the scroll
   * container is what stops colour/width/opacity from sliding out of reach when
   * the window is narrow.
   */
  .tool-group {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tool-group::-webkit-scrollbar {
    display: none;
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

  .trial {
    flex: none;
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 99px;
    color: var(--text-muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .trial:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  .trial.ended {
    border-color: transparent;
    background: var(--danger-soft);
    color: var(--danger);
  }

  :global([data-glass]) .trial {
    height: 28px;
    border-color: transparent;
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

  .popover-wrap {
    position: relative;
    display: flex;
    align-items: center;
    flex: none;
  }

  .style {
    display: flex;
    align-items: center;
    flex: none;
    gap: 12px;
    padding-left: 12px;
    border-left: 1px solid var(--border);
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

  /* ------------------------------------------------ Liquid Glass (macOS) */

  .cluster {
    display: contents;
  }

  /* No bar of its own: the window's glass is the toolbar, and it runs to the
     top edge because the title bar is an overlay. */
  :global([data-glass]) .toolbar {
    background: none;
    border-bottom: none;
  }

  :global([data-glass]) .row {
    gap: 8px;
    padding: 0 10px;
  }

  /* Clear of the traffic lights, which tauri.macos.conf.json puts in this row.
     In full screen they leave the window, and so does their space. */
  :global([data-glass]) .row:first-child {
    padding-left: 90px;
  }

  :global([data-glass][data-fullscreen]) .row:first-child {
    padding-left: 10px;
  }

  :global([data-glass]) .row.tools {
    height: 44px;
    border-top: none;
  }

  /* The capsules are the grouping now. */
  :global([data-glass]) .divider {
    display: none;
  }

  :global([data-glass]) .cluster {
    display: flex;
    align-items: center;
    flex: none;
    padding: 2px;
    border-radius: 999px;
  }

  /* A scroll container clips on both axes, so give the capsule shadows room
     inside it and take the space back outside. */
  :global([data-glass]) .tool-group {
    gap: 8px;
    margin: -8px 0;
    padding: 8px 2px;
  }

  :global([data-glass]) .zoom {
    min-width: 42px;
  }

  :global([data-glass]) .pages {
    padding: 0 2px;
  }

  :global([data-glass]) .page-input {
    height: 24px;
    border-color: transparent;
    border-radius: 999px;
    background: var(--glass-track);
  }

  :global([data-glass]) .style {
    height: 32px;
    padding: 0 14px;
    border-left: none;
    border-radius: 999px;
  }

  :global([data-glass]) .swatch {
    border-radius: 50%;
  }

  :global([data-glass]) .picker {
    border-radius: 50%;
    width: 20px;
  }

  /* Labelled buttons are too tall for a capsule to stay a capsule. */
  :global([data-glass]) .toolbar.labels .cluster {
    border-radius: 16px;
  }

  :global([data-glass]) .toolbar.labels :global(.btn) {
    border-radius: 13px;
  }

  /* ----------------------------------------------- Windows (Fluent Design) */
  :global([data-platform="win"]) .cluster {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  :global([data-platform="win"]) .page-input {
    height: 26px;
    border-radius: 4px;
    border: 1px solid var(--border);
    border-bottom: 2px solid var(--border-strong);
    background: var(--bg-raised);
  }

  :global([data-platform="win"]) .page-input:focus {
    border-bottom-color: var(--accent);
  }

  :global([data-platform="win"]) .swatch {
    border-radius: 3px;
  }

  :global([data-platform="win"]) .picker {
    border-radius: 3px;
  }

  /* --------------------------------- Linux / GNOME (Adwaita / Libadwaita) */
  :global([data-platform="gnome"]) .cluster,
  :global([data-platform="linux"]) .cluster {
    display: inline-flex;
    align-items: center;
    background: var(--bg-sunken);
    border-radius: 6px;
    padding: 2px;
    gap: 1px;
  }

  :global([data-platform="gnome"]) .cluster :global(.btn),
  :global([data-platform="linux"]) .cluster :global(.btn) {
    border-radius: 5px;
    height: 26px;
  }

  :global([data-platform="gnome"]) .cluster :global(.btn.selected),
  :global([data-platform="linux"]) .cluster :global(.btn.selected) {
    background: var(--bg-raised);
    color: var(--accent);
    box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
  }

  :global([data-platform="gnome"]) .divider,
  :global([data-platform="linux"]) .divider {
    display: none;
  }

  :global([data-platform="gnome"]) .page-input,
  :global([data-platform="linux"]) .page-input {
    border-radius: 6px;
  }

  :global([data-platform="gnome"]) .swatch,
  :global([data-platform="linux"]) .swatch {
    border-radius: 4px;
  }

  :global([data-platform="gnome"]) .picker,
  :global([data-platform="linux"]) .picker {
    border-radius: 4px;
  }

  /* ------------------------------------- Linux / KDE Plasma (Breeze) */
  :global([data-platform="kde"]) .cluster {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  :global([data-platform="kde"]) .page-input {
    height: 26px;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
  }

  :global([data-platform="kde"]) .page-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  :global([data-platform="kde"]) .swatch {
    border-radius: 3px;
  }

  :global([data-platform="kde"]) .picker {
    border-radius: 3px;
  }
</style>
