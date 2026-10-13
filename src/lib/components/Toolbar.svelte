<script lang="ts">
  /** Top chrome: file actions and zoom on one row, tools and their style on the next. */
  import { isRedact } from "$lib/annotations/types";
  import { images } from "$lib/state/images.svelte";
  import { license } from "$lib/state/license.svelte";
  import { session } from "$lib/state/session.svelte";
  import { viewer, type StyleKind, type Tool } from "$lib/state/viewer.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import { hasGlass } from "$lib/platform";
  import Icon, { type IconName } from "./Icon.svelte";
  import ColourWell from "./ColourWell.svelte";
  import NumberInput from "./NumberInput.svelte";
  import SizeField from "./SizeField.svelte";
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
    /** Shortcut, shown in the tooltip; not every tool has one. */
    key?: string;
    /** Button label when labels are on; `title` is tooltip prose, often too long. */
    short?: string;
  }

  const groups: ToolSpec[][] = [
    [
      { tool: "select", icon: "cursor", title: "Select", key: "V" },
      { tool: "pan", icon: "hand", title: "Pan", key: "H" },
      { tool: "text", icon: "text", title: "Select text", key: "T", short: "Text" },
      { tool: "ocr", icon: "ocr", title: "Copy text from a scan (OCR)", short: "OCR" },
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
      { tool: "measure", icon: "ruler", title: "Measure distance", key: "M", short: "Measure" },
    ],
    [
      { tool: "freetext", icon: "textbox", title: "Text box", key: "X" },
      { tool: "check", icon: "check", title: "Tick mark, for forms", key: "C", short: "Tick" },
      { tool: "cross", icon: "close", title: "Cross mark, for forms", key: "⇧C", short: "Cross" },
      { tool: "note", icon: "note", title: "Comment", key: "N" },
      { tool: "redact", icon: "redact", title: "Redact area or text (D)", key: "D", short: "Redact" },
    ],
  ];

  const SWATCHES = [
    "#fde047", "#fb923c", "#e11d48", "#a855f7",
    "#2563eb", "#0ea5e9", "#16a34a", "#111827",
  ];

  const open = $derived(tab?.isOpen === true);
  const pendingRedactionsCount = $derived(tab ? tab.edits.annots.filter(isRedact).length : 0);
  /** The kind whose style the controls edit, or null for non-drawing tools. */
  const styledKind = $derived.by<StyleKind | null>(() => {
    const tool = viewer.tool;
    return tool in viewer.styles ? (tool as StyleKind) : null;
  });
  const style = $derived(styledKind ? viewer.styles[styledKind] : null);

  const showWidth = $derived(
    styledKind !== null &&
      [
        "ink", "square", "circle", "line", "arrow", "underline", "strikeout", "squiggly",
        "check", "cross",
      ].includes(styledKind),
  );
  const showFill = $derived(
    styledKind === "square" ||
      styledKind === "circle" ||
      styledKind === "freetext" ||
      styledKind === "redact",
  );
  const showFontSize = $derived(styledKind === "freetext");
  /** Ticks and crosses keep their size in `fontSize`. */
  const showMarkSize = $derived(styledKind === "check" || styledKind === "cross");

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

  /** True once the style controls have wrapped onto a line of their own. */
  let styleWrapped = $state(false);
  let toolsMain: HTMLElement | undefined = $state();
  let styleBox: HTMLElement | undefined = $state();

  $effect(() => {
    const main = toolsMain;
    const box = styleBox;
    if (!main || !box) {
      styleWrapped = false;
      return;
    }
    const measure = () => (styleWrapped = box.offsetTop > main.offsetTop + main.offsetHeight / 2);
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    observer.observe(box);
    observer.observe(main.parentElement!);
    measure();
    return () => observer.disconnect();
  });

  /**
   * For a strip that may have to scroll: fade whichever edge hides more
   * buttons, so it is clear there are more, and let a plain mouse wheel
   * scroll it sideways.
   */
  function scrollFade(node: HTMLElement) {
    const update = () => {
      const max = node.scrollWidth - node.clientWidth;
      node.classList.toggle("fade-start", max > 1 && node.scrollLeft > 1);
      node.classList.toggle("fade-end", max > 1 && node.scrollLeft < max - 1);
    };
    const onWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      node.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    node.addEventListener("scroll", update, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: false });
    update();
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
      node.removeEventListener("wheel", onWheel);
    };
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
  <div class="row" data-tauri-drag-region={drag} {@attach scrollFade}>
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
      <button class="btn square" title="Split & Extract Pages…" disabled={!open} onclick={() => session.openSplitDialog()}>
        <Icon name="scissors" />
        <span class="btn-label">Split</span>
      </button>
      <button class="btn square" title="Recognise text (OCR)…" disabled={!open} onclick={() => session.openOcrDialog()}>
        <Icon name="ocr" />
        <span class="btn-label">OCR</span>
      </button>
      <button class="btn square" title="Straighten scanned pages…" disabled={!open} onclick={() => session.openStraightenDialog()}>
        <Icon name="straighten" />
        <span class="btn-label">Straighten</span>
      </button>
      <button
        class="btn square"
        class:selected={!!session.perspective && session.perspective.tab === tab}
        title="Correct perspective of the current page…"
        disabled={!open}
        onclick={() => {
          if (!tab) return;
          if (session.perspective?.tab === tab) session.cancelPerspective();
          else session.startPerspective(tab);
        }}
      >
        <Icon name="perspective" />
        <span class="btn-label">Perspective</span>
      </button>
      <button class="btn square" title="Watermark…" disabled={!open} onclick={() => session.openWatermarkDialog()}>
        <Icon name="watermark" />
        <span class="btn-label">Watermark</span>
      </button>
      <button class="btn square" title="Headers & Footers…" disabled={!open} onclick={() => session.openHeaderFooterDialog()}>
        <Icon name="header-footer" />
        <span class="btn-label">Headers</span>
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
        class:selected={viewer.pageLayout !== "single"}
        title="Page layout: {viewer.pageLayout}"
        onclick={() => {
          if (viewer.pageLayout === "single") viewer.pageLayout = "two-page";
          else if (viewer.pageLayout === "two-page") viewer.pageLayout = "two-page-cover";
          else viewer.pageLayout = "single";
        }}
      >
        <Icon name="two-page" />
        <span class="btn-label">Layout</span>
      </button>

      <button
        class="btn square"
        class:selected={viewer.readingMode !== "default"}
        title="Reading filter: {viewer.readingMode}"
        onclick={() => {
          if (viewer.readingMode === "default") viewer.readingMode = "dark";
          else if (viewer.readingMode === "dark") viewer.readingMode = "sepia";
          else if (viewer.readingMode === "sepia") viewer.readingMode = "invert";
          else viewer.readingMode = "default";
        }}
      >
        <Icon name="reading-mode" />
        <span class="btn-label">Reading</span>
      </button>

      <button
        class="btn square"
        class:selected={viewer.presentationMode}
        title="Presentation mode (F5)"
        disabled={!open}
        onclick={() => (viewer.presentationMode = !viewer.presentationMode)}
      >
        <Icon name="presentation" />
        <span class="btn-label">Present</span>
      </button>

      <button
        class="btn square"
        title="Command Palette (⌘K)"
        onclick={() => session.toggleCommandPalette()}
      >
        <Icon name="command" />
        <span class="btn-label">Commands</span>
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
    <!-- The tools travel together; the style controls may wrap below them. -->
    <div class="tools-main" bind:this={toolsMain} data-tauri-drag-region={drag}>
    <div class="tool-group" data-tauri-drag-region={drag} {@attach scrollFade}>
      {#each groups as group, i (i)}
        {#if i > 0}<div class="divider"></div>{/if}
        <div class="cluster glass">
          {#each group as spec (spec.tool)}
            <button
              class="btn square"
              class:selected={viewer.tool === spec.tool}
              title={spec.key ? `${spec.title} (${spec.key})` : spec.title}
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

    {#if pendingRedactionsCount > 0}
      <div class="divider"></div>
      <div class="cluster glass">
        <button
          class="btn accent redact-apply-btn"
          title="Permanently sanitize and excise underlying content for all redactions"
          onclick={() => tab && session.applyRedactions(tab)}
        >
          <Icon name="redact" />
          <span class="btn-label">Apply</span>
          <span class="apply-text">Apply Redactions ({pendingRedactionsCount})</span>
        </button>
      </div>
    {/if}

    </div>

    {#if style && styledKind}
      <div class="style glass" class:wrapped={styleWrapped} bind:this={styleBox}>
        <ColourWell value={style.color} swatches={SWATCHES} onchange={(color) => setStyle({ color })} />

        {#if showWidth}
          <SizeField
            label="Stroke width"
            value={style.width}
            min={0.5}
            max={50}
            step={0.5}
            sliderMin={0.5}
            sliderMax={12}
            onchange={(width) => setStyle({ width })}
          >
            {#snippet icon()}<Icon name="pen" size={13} />{/snippet}
          </SizeField>
        {/if}

        {#if showMarkSize}
          <SizeField
            label="Mark size"
            value={style.fontSize}
            min={2}
            max={200}
            sliderMin={6}
            sliderMax={36}
            unit="pt"
            onchange={(fontSize) => setStyle({ fontSize })}
          >
            {#snippet icon()}<Icon name="check" size={13} />{/snippet}
          </SizeField>
        {/if}

        {#if showFontSize}
          <SizeField
            label="Font size"
            value={style.fontSize}
            min={1}
            max={200}
            step={0.5}
            sliderMin={6}
            sliderMax={48}
            unit="pt"
            onchange={(fontSize) => setStyle({ fontSize })}
          >
            {#snippet icon()}<Icon name="text" size={13} />{/snippet}
          </SizeField>
        {/if}

        {#if styledKind === "freetext"}
          <select
            class="style-select"
            value={style.fontFamily ?? "Helvetica"}
            aria-label="Font family"
            title="Font family"
            onchange={(event) => setStyle({ fontFamily: event.currentTarget.value as any })}
          >
            <option value="Helvetica">Helvetica</option>
            <option value="Times">Times</option>
            <option value="Courier">Courier</option>
          </select>

          <span class="style-group" role="group" aria-label="Font style">
            <button
              type="button"
              class="style-btn"
              class:on={style.bold}
              title="Bold"
              aria-label="Bold"
              onclick={() => setStyle({ bold: !style.bold })}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              class="style-btn"
              class:on={style.italic}
              title="Italic"
              aria-label="Italic"
              onclick={() => setStyle({ italic: !style.italic })}
            >
              <em>I</em>
            </button>
          </span>

          <span class="style-group" role="group" aria-label="Alignment">
            <button
              type="button"
              class="style-btn"
              class:on={(style.align ?? "left") === "left"}
              title="Align left"
              aria-label="Align left"
              onclick={() => setStyle({ align: "left" })}
            >
              <Icon name="align-left" size={14} />
            </button>
            <button
              type="button"
              class="style-btn"
              class:on={style.align === "center"}
              title="Align center"
              aria-label="Align center"
              onclick={() => setStyle({ align: "center" })}
            >
              <Icon name="align-center" size={14} />
            </button>
            <button
              type="button"
              class="style-btn"
              class:on={style.align === "right"}
              title="Align right"
              aria-label="Align right"
              onclick={() => setStyle({ align: "right" })}
            >
              <Icon name="align-right" size={14} />
            </button>
          </span>
        {/if}

        <SizeField
          label="Opacity"
          value={style.opacity}
          factor={100}
          min={10}
          max={100}
          sliderMin={0.1}
          sliderMax={1}
          unit="%"
          onchange={(opacity) => setStyle({ opacity })}
        >
          {#snippet icon()}<span class="opacity-icon" aria-hidden="true"></span>{/snippet}
        </SizeField>

        {#if showFill}
          <label class="fill" title={styledKind === "freetext" ? "Whiteout / Background" : "Fill colour"}>
            <input
              type="checkbox"
              checked={style.fill !== null}
              onchange={(event) =>
                setStyle({ fill: event.currentTarget.checked ? (styledKind === "freetext" ? "#ffffff" : style.color) : null })}
            />
            {styledKind === "freetext" ? "Whiteout" : "Fill"}
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

  /*
   * The tools and the style controls share a line when there's room. When
   * there isn't, the style controls wrap onto a line of their own rather than
   * squeezing the tools out of sight.
   */
  .row.tools {
    flex-wrap: wrap;
    row-gap: 4px;
    height: auto;
    min-height: 40px;
    padding-top: 4px;
    padding-bottom: 4px;
    border-top: 1px solid var(--border);
    /* Must stay visible: the tool row hosts the stamp dropdown and palettes. */
    overflow: visible;
  }

  .tools-main {
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
  }

  /* A strip with buttons out of view fades at that edge, so they're findable. */
  .row:global(.fade-end),
  .tool-group:global(.fade-end) {
    mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent);
  }

  .row:global(.fade-start),
  .tool-group:global(.fade-start) {
    mask-image: linear-gradient(to left, #000 calc(100% - 32px), transparent);
  }

  .row:global(.fade-start.fade-end),
  .tool-group:global(.fade-start.fade-end) {
    mask-image: linear-gradient(to right, transparent, #000 32px, #000 calc(100% - 32px), transparent);
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

  /*
   * With labels the top row is wider than many windows. Wrap it at group
   * boundaries instead of hiding the end of it; each group stays together.
   */
  .toolbar.labels .row:not(.tools) {
    flex-wrap: wrap;
    row-gap: 4px;
    overflow: visible;
  }

  .toolbar.labels .row:not(.tools) .cluster,
  .toolbar.labels .tool-group .cluster {
    display: flex;
    align-items: center;
    flex: none;
    gap: 2px;
  }

  /*
   * The tools wrap by group too, Stamp and Signature included, so in label
   * mode no tool is ever out of sight: the scrolling strip dissolves and its
   * groups flow with the rest.
   */
  .toolbar.labels .tool-group {
    display: contents;
  }

  .toolbar.labels .tools-main {
    flex-wrap: wrap;
    row-gap: 4px;
  }

  /*
   * Groups are separated by space rather than divider lines, which would be
   * left dangling at the end of a wrapped line (as the glass style does).
   */
  .toolbar.labels .row,
  .toolbar.labels .tools-main {
    column-gap: 12px;
  }

  .toolbar.labels .divider {
    display: none;
  }

  /* A selected button's label takes the button's own text colour. */
  .toolbar.labels :global(.btn.selected .btn-label) {
    color: inherit;
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
    flex: 0 1 auto;
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

  .redact-apply-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--radius);
    background: rgb(239 68 68 / 15%);
    border: 1px solid rgb(239 68 68 / 40%);
    color: #ef4444;
    font-weight: 500;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .redact-apply-btn:hover {
    background: rgb(239 68 68 / 25%);
    border-color: #ef4444;
  }

  .toolbar.labels .apply-text {
    display: none;
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
    flex: none;
    gap: 5px;
    white-space: nowrap;
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
    gap: 10px;
    margin-left: auto;
    padding-left: 12px;
    border-left: 1px solid var(--border);
  }

  /* On a line of its own it lines up under the tools instead. */
  .style.wrapped {
    margin-left: 0;
    padding-left: 2px;
    border-left: none;
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

  .style-select {
    height: 24px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
  }

  .style-group {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .style-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    background: var(--bg);
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
  }

  .style-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .style-btn.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: bold;
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

  :global([data-glass]) .style.wrapped {
    padding: 0 14px;
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

  :global([data-platform="gnome"]) .toolbar.labels .cluster :global(.btn),
  :global([data-platform="linux"]) .toolbar.labels .cluster :global(.btn) {
    height: auto;
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


  :global([data-platform="kde"]) .picker {
    border-radius: 3px;
  }
</style>
