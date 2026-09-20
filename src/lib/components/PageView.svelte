<script lang="ts">
  /**
   * One page: canvas, selectable text layer, annotation overlay, and all of the
   * pointer handling for the active tool.
   *
   * Layer order (bottom to top): canvas, highlight SVG, text layer, annotation
   * SVG, HTML widgets, interaction surface. The surface takes pointer events for
   * every tool except the text-selection ones, where it steps aside so the text
   * layer underneath can drive a native selection.
   */
  import type { PageViewport } from "pdfjs-dist";

  import {
    constrainAngle,
    constrainSquare,
    pick,
    resizeRect,
    simplifyStroke,
    type HandleId,
  } from "$lib/annotations/hit";
  import {
    createBoxShape,
    createFreeText,
    createInk,
    createLineShape,
    createNote,
    createStamp,
    createTextMarkup,
    stampRectAt,
    stampRectFromDrag,
  } from "$lib/annotations/create";
  import {
    annotBounds,
    hasRect,
    isFreeText,
    isInk,
    isStamp,
    normalizeRect,
    scaleAnnotToRect,
    setFreeTextText,
    translateAnnot,
    type Annot,
    type PageEntry,
    type Point,
    type TextMarkupKind,
  } from "$lib/annotations/types";
  import {
    PageRenderer,
    RenderCancelled,
    pdfPerCssPixel,
    toPdfPoint,
    viewportFor,
  } from "$lib/pdf/render";
  import { clearSelection, mountTextLayer, selectionOnPage, type TextLayerHandle } from "$lib/pdf/textlayer";
  import type { PDFPageProxy } from "$lib/pdf/pdfjs";
  import { images } from "$lib/state/images.svelte";
  import { MARKUP_TOOLS, viewer } from "$lib/state/viewer.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";

  import AnnotLayer from "./AnnotLayer.svelte";
  import AnnotWidgets from "./AnnotWidgets.svelte";

  let {
    tab,
    entry,
    pageIndex,
    scale,
    visible,
    onPan,
  }: {
    tab: DocumentTab;
    entry: PageEntry;
    pageIndex: number;
    scale: number;
    /** Render the canvas and text layer only for pages near the viewport. */
    visible: boolean;
    onPan?: (dx: number, dy: number) => void;
  } = $props();

  const doc = $derived(tab.doc);
  const edits = $derived(tab.edits);
  const search = $derived(tab.search);
  const view = $derived(tab.view);

  let page = $state.raw<PDFPageProxy | null>(null);
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let textEl: HTMLDivElement | undefined = $state();
  let surfaceEl: HTMLDivElement | undefined = $state();
  let renderError = $state<string | null>(null);
  let editingId = $state<string | null>(null);

  /** Hit-test slop and ink simplification, in screen pixels. */
  const HIT_SLOP_PX = 4;
  const ERASER_RADIUS_PX = 8;

  const renderer = new PageRenderer();

  const annots = $derived(edits.annotsByPage.get(entry.id) ?? []);
  const matches = $derived(search.matchesOn(pageIndex));

  /**
   * Placeholder box, so the scrollbar is stable before the page renders. Comes
   * from the source metadata, which is known without loading the page.
   */
  const placeholder = $derived.by(() => {
    const d = edits.displayDims(entry);
    return { width: Math.round(d.width * scale), height: Math.round(d.height * scale) };
  });

  const viewport = $derived<PageViewport | null>(
    page ? viewportFor(page, scale, entry.rotation) : null,
  );

  const tool = $derived(viewer.tool);
  const isMarkupTool = $derived(MARKUP_TOOLS.includes(tool));
  const passthrough = $derived(tool === "text" || isMarkupTool);

  const cursor = $derived(
    tool === "pan"
      ? "grab"
      : tool === "select"
        ? "default"
        : tool === "eraser"
          ? "cell"
          : "crosshair",
  );

  // ------------------------------------------------------------ page loading

  $effect(() => {
    const { sourceDocId, srcIndex } = entry;
    let alive = true;
    doc
      .page(sourceDocId, srcIndex)
      .then((p) => {
        if (alive) page = p;
      })
      .catch((err) => {
        if (alive) renderError = err instanceof Error ? err.message : String(err);
      });
    return () => {
      alive = false;
    };
  });

  // ------------------------------------------------------------- canvas render

  $effect(() => {
    const target = canvasEl;
    const current = page;
    const vp = viewport;
    if (!visible || !target || !current || !vp) return;

    renderer.render(current, target, vp).catch((err) => {
      // Cancellation is the normal outcome of zooming or scrolling away.
      if (err instanceof RenderCancelled) return;
      renderError = err instanceof Error ? err.message : String(err);
    });

    return () => renderer.cancel();
  });

  // ---------------------------------------------------------------- text layer

  let textLayer: TextLayerHandle | null = null;
  let textLayerScale = 0;

  $effect(() => {
    const container = textEl;
    const current = page;
    const vp = viewport;
    if (!visible || !container || !current || !vp) return;

    // Re-extracting text on every zoom step would be wasteful; pdf.js can
    // reflow an existing layer instead.
    if (textLayer && textLayerScale !== vp.scale) {
      textLayer.update(vp);
      textLayerScale = vp.scale;
      return;
    }
    if (textLayer) return;

    let cancelled = false;
    mountTextLayer(current, container, vp)
      .then((handle) => {
        if (cancelled) {
          handle.cancel();
          return;
        }
        textLayer = handle;
        textLayerScale = vp.scale;
      })
      .catch(() => {
        // A page with no extractable text simply has no selection layer.
      });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    // Drop the text layer when the page scrolls out of range, so long documents
    // don't accumulate one DOM subtree per page.
    if (visible) return;
    textLayer?.cancel();
    textLayer = null;
    textLayerScale = 0;
    if (textEl) textEl.textContent = "";
  });

  // -------------------------------------------------------------- interactions

  type Gesture =
    | { kind: "move"; id: string; from: Point; original: Annot }
    | { kind: "resize"; id: string; handle: HandleId; original: Annot }
    | { kind: "box"; origin: Point; current: Point; shift: boolean }
    | { kind: "line"; origin: Point; current: Point; shift: boolean }
    | { kind: "ink"; points: Point[] }
    | { kind: "erase" }
    | { kind: "pan"; lastClient: Point };

  let gesture = $state.raw<Gesture | null>(null);

  const slop = $derived(viewport ? HIT_SLOP_PX * pdfPerCssPixel(viewport) : 1);

  function pointOf(event: PointerEvent): Point | null {
    if (!viewport || !surfaceEl) return null;
    const box = surfaceEl.getBoundingClientRect();
    return toPdfPoint(viewport, event.clientX - box.left, event.clientY - box.top);
  }

  /** The annotation being dragged out, drawn by the overlay but not committed. */
  const preview = $derived.by<Annot | null>(() => {
    const g = gesture;
    if (!g || !viewport) return null;
    const style = viewer.style;

    if (g.kind === "ink") {
      return g.points.length > 0 ? createInk(entry.id, [g.points], style) : null;
    }

    if (g.kind === "box") {
      const to = g.shift ? constrainSquare(g.origin, g.current) : g.current;
      const rect = normalizeRect(g.origin, to);
      if (rect.w < 1 && rect.h < 1) return null;
      if (tool === "square" || tool === "circle") {
        return createBoxShape(tool, entry.id, rect, style);
      }
      if (tool === "freetext") return createFreeText(entry.id, rect, style);
      if (tool === "stamp" || tool === "signature") {
        const image = viewer.pendingStamp ? images.get(viewer.pendingStamp) : null;
        if (!image) return null;
        const aspect = image.width / image.height;
        return createStamp(
          entry.id,
          stampRectFromDrag(g.origin, to, aspect),
          image.id,
          image.isSignature,
          style,
        );
      }
      return null;
    }

    if (g.kind === "line" && (tool === "line" || tool === "arrow")) {
      const to = g.shift ? constrainAngle(g.origin, g.current) : g.current;
      return createLineShape(tool, entry.id, g.origin, to, style);
    }

    return null;
  });

  function beginGesture(event: PointerEvent, next: Gesture, label: string) {
    gesture = next;
    edits.begin(label);
    surfaceEl?.setPointerCapture(event.pointerId);
  }

  function onSurfaceDown(event: PointerEvent) {
    if (event.button !== 0 || !viewport) return;
    const p = pointOf(event);
    if (!p) return;

    view.currentPage = pageIndex;
    const style = viewer.style;

    switch (tool) {
      case "pan":
        gesture = { kind: "pan", lastClient: { x: event.clientX, y: event.clientY } };
        surfaceEl?.setPointerCapture(event.pointerId);
        return;

      case "select": {
        const target = pick(annots, p, slop);
        edits.select(target?.id ?? null);
        if (editingId && editingId !== target?.id) editingId = null;
        if (!target) return;
        beginGesture(event, { kind: "move", id: target.id, from: p, original: target }, "Move annotation");
        return;
      }

      case "ink":
        beginGesture(event, { kind: "ink", points: [p] }, "Draw");
        return;

      case "eraser":
        beginGesture(event, { kind: "erase" }, "Erase");
        eraseAt(p);
        return;

      case "note": {
        const annot = createNote(entry.id, p, style);
        edits.add(annot, "Add note");
        viewer.inspectorOpen = true;
        return;
      }

      case "square":
      case "circle":
      case "freetext":
        beginGesture(
          event,
          { kind: "box", origin: p, current: p, shift: event.shiftKey },
          tool === "freetext" ? "Add text box" : "Add shape",
        );
        return;

      case "stamp":
      case "signature": {
        if (!viewer.pendingStamp) return;
        beginGesture(
          event,
          { kind: "box", origin: p, current: p, shift: false },
          tool === "signature" ? "Add signature" : "Add stamp",
        );
        return;
      }

      case "line":
      case "arrow":
        beginGesture(
          event,
          { kind: "line", origin: p, current: p, shift: event.shiftKey },
          "Add line",
        );
        return;
    }
  }

  function onSurfaceMove(event: PointerEvent) {
    const g = gesture;
    if (!g) return;

    if (g.kind === "pan") {
      onPan?.(g.lastClient.x - event.clientX, g.lastClient.y - event.clientY);
      gesture = { kind: "pan", lastClient: { x: event.clientX, y: event.clientY } };
      return;
    }

    const p = pointOf(event);
    if (!p) return;

    switch (g.kind) {
      case "move": {
        const dx = p.x - g.from.x;
        const dy = p.y - g.from.y;
        edits.update(g.id, () => translateAnnot(g.original, dx, dy));
        return;
      }
      case "resize": {
        if (!hasRect(g.original)) return;
        const next = resizeRect(annotBounds(g.original), g.handle, p);
        edits.update(g.id, () => scaleAnnotToRect(g.original, next));
        return;
      }
      case "ink":
        gesture = { kind: "ink", points: [...g.points, p] };
        return;
      case "erase":
        eraseAt(p);
        return;
      case "box":
        gesture = { ...g, current: p, shift: event.shiftKey };
        return;
      case "line":
        gesture = { ...g, current: p, shift: event.shiftKey };
        return;
    }
  }

  function onSurfaceUp(event: PointerEvent) {
    const g = gesture;
    if (!g) return;

    if (g.kind === "pan") {
      gesture = null;
      return;
    }

    if (g.kind === "ink" && viewport) {
      const simplified = simplifyStroke(g.points, 0.4 * pdfPerCssPixel(viewport));
      gesture = null;
      if (simplified.length > 0) {
        edits.annots.push(createInk(entry.id, [simplified], viewer.style));
      }
      edits.end();
      return;
    }

    if (g.kind === "box" || g.kind === "line") {
      const created = preview;
      const p = pointOf(event);
      gesture = null;

      if (created) {
        edits.annots.push(created);
        edits.select(created.id);
        if (isFreeText(created)) editingId = created.id;
      } else if (g.kind === "box" && p && (tool === "stamp" || tool === "signature")) {
        // A click rather than a drag: place at the image's natural aspect.
        const image = viewer.pendingStamp ? images.get(viewer.pendingStamp) : null;
        if (image) {
          const annot = createStamp(
            entry.id,
            stampRectAt(p, image.width / image.height),
            image.id,
            image.isSignature,
            viewer.style,
          );
          edits.annots.push(annot);
          edits.select(annot.id);
        }
      } else if (g.kind === "box" && p && tool === "freetext") {
        // A click makes a default-sized box.
        const annot = createFreeText(entry.id, { x: p.x, y: p.y - 40, w: 0, h: 0 }, viewer.style);
        edits.annots.push(annot);
        edits.select(annot.id);
        editingId = annot.id;
      }

      edits.end();
      return;
    }

    gesture = null;
    edits.end();
  }

  function onSurfaceCancel() {
    if (!gesture) return;
    gesture = null;
    edits.cancel();
  }

  function eraseAt(p: Point) {
    if (!viewport) return;
    const radius = ERASER_RADIUS_PX * pdfPerCssPixel(viewport);
    // Whole strokes are removed rather than split: predictable, and it keeps
    // `/InkList` from fragmenting into dozens of sub-paths.
    const doomed = new Set(
      annots.filter((a) => isInk(a) && pick([a], p, radius) !== null).map((a) => a.id),
    );
    if (doomed.size === 0) return;
    edits.annots = edits.annots.filter((a) => !doomed.has(a.id));
  }

  function onSurfaceDoubleClick(event: MouseEvent) {
    if (tool !== "select" || !viewport) return;
    const box = surfaceEl?.getBoundingClientRect();
    if (!box) return;
    const p = toPdfPoint(viewport, event.clientX - box.left, event.clientY - box.top);
    const target = pick(annots, p, slop);
    if (target && isFreeText(target)) {
      edits.select(target.id);
      editingId = target.id;
    } else if (target) {
      // Anything else: jump to its comment field.
      edits.select(target.id);
      viewer.inspectorOpen = true;
    }
  }

  // ------------------------------------------------------- text-markup tools

  /**
   * Turn the current selection into markup. Runs on pointer release anywhere,
   * because the selection may have started on another page — each page
   * contributes only the quads that fall inside its own text layer.
   */
  function onDocumentPointerUp() {
    if (!isMarkupTool || !viewport || !textEl) return;
    const found = selectionOnPage(textEl, viewport);
    if (!found) return;

    const kind = tool as TextMarkupKind;
    edits.add(
      createTextMarkup(kind, entry.id, found.quads, found.text, viewer.styles[kind]),
      `Add ${kind}`,
    );
    clearSelection();
  }

  $effect(() => {
    if (!isMarkupTool || !visible) return;
    document.addEventListener("pointerup", onDocumentPointerUp);
    return () => document.removeEventListener("pointerup", onDocumentPointerUp);
  });

  // ------------------------------------------------------------ widget events

  function onHandleDown(event: PointerEvent, annot: Annot, handle: HandleId) {
    if (tool !== "select") return;
    event.stopPropagation();
    edits.select(annot.id);
    beginGesture(event, { kind: "resize", id: annot.id, handle, original: annot }, "Resize annotation");
  }

  function onNoteDown(event: PointerEvent, annot: Annot) {
    if (tool !== "select") return;
    event.stopPropagation();
    const p = pointOf(event);
    edits.select(annot.id);
    viewer.inspectorOpen = true;
    if (p) beginGesture(event, { kind: "move", id: annot.id, from: p, original: annot }, "Move note");
  }

  function onFreeTextInput(annot: Annot, text: string) {
    if (!isFreeText(annot)) return;
    edits.update(annot.id, () => setFreeTextText(annot, text), "Edit text");
  }

  function onFreeTextCommit(annot: Annot) {
    if (editingId !== annot.id) return;
    editingId = null;
    // An empty box is almost always an accidental click.
    if (isFreeText(annot) && annot.text.trim().length === 0) {
      edits.remove(annot.id, "Add text box");
    }
  }

  const label = $derived(`Page ${pageIndex + 1}`);
</script>

<div
  class="page"
  style:width="{viewport ? Math.floor(viewport.width) : placeholder.width}px"
  style:height="{viewport ? Math.floor(viewport.height) : placeholder.height}px"
  data-page-index={pageIndex}
  aria-label={label}
>
  {#if renderError}
    <div class="page-error">{renderError}</div>
  {/if}

  <div class="page-stack" class:tool-passthrough={passthrough}>
    <canvas bind:this={canvasEl} class="canvas" aria-label={label}></canvas>
    <div bind:this={textEl} class="textLayer"></div>

    {#if viewport}
      <AnnotLayer
        {annots}
        {viewport}
        selectedId={edits.selectedId}
        searchMatches={matches}
        activeMatch={search.active}
        {preview}
      />
      <AnnotWidgets
        {annots}
        {viewport}
        selectedId={edits.selectedId}
        {editingId}
        interactive={tool === "select"}
        {onHandleDown}
        {onNoteDown}
        {onFreeTextInput}
        {onFreeTextCommit}
      />
    {/if}

    <!--
      A pointer-capture surface, not a control: it has no state of its own and
      nothing to focus. Annotations are reachable from the keyboard through the
      sidebar's annotation list, which is a real list of buttons.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={surfaceEl}
      class="surface"
      class:passthrough
      style:cursor
      onpointerdown={onSurfaceDown}
      onpointermove={onSurfaceMove}
      onpointerup={onSurfaceUp}
      onpointercancel={onSurfaceCancel}
      ondblclick={onSurfaceDoubleClick}
    ></div>
  </div>
</div>

<style>
  .page {
    position: relative;
    flex: none;
    background: #ffffff;
    box-shadow: var(--shadow-2);
  }

  .page-stack {
    position: absolute;
    inset: 0;
  }

  .canvas {
    position: absolute;
    inset: 0;
    display: block;
  }

  .surface {
    position: absolute;
    inset: 0;
    z-index: 5;
    touch-action: none;
  }

  /* Text tools need the text layer beneath to receive the pointer. */
  .surface.passthrough {
    pointer-events: none;
  }

  .page-error {
    position: absolute;
    inset: 12px;
    z-index: 6;
    display: grid;
    place-items: center;
    padding: 12px;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--danger-soft);
    color: var(--danger);
    text-align: center;
  }
</style>
