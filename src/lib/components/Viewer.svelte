<script lang="ts">
  /**
   * The scrolling page list.
   *
   * Owns three things the pages themselves can't: the effective zoom scale
   * (which depends on the container's width), which pages are close enough to
   * the viewport to be worth rendering, and the scroll position.
   */
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import PageView from "./PageView.svelte";
  import Icon from "./Icon.svelte";

  let { tab }: { tab: DocumentTab } = $props();
  const edits = $derived(tab.edits);
  const view = $derived(tab.view);

  /** Gap between pages and around the page column, in CSS pixels. */
  const GUTTER = 16;
  /** Pages this far outside the viewport are still rendered, to hide scrolling. */
  const OVERSCAN = 2;

  let container: HTMLDivElement | undefined = $state();
  let containerWidth = $state(0);
  let containerHeight = $state(0);
  let laserActive = $state(false);
  let laserPos = $state<{ x: number; y: number } | null>(null);

  /**
   * Must be deeply reactive, not `$state.raw`: `bind:this` assigns into it by
   * index, and the observer and scroll effects have to see those writes.
   */
  let pageEls = $state<(HTMLDivElement | undefined)[]>([]);
  let intersecting = $state.raw(new Set<number>());

  const pages = $derived(edits.pages);

  // Group pages for two-page spread layouts
  const spreads = $derived.by<{ indices: number[] }[]>(() => {
    const layout = viewer.pageLayout;
    if (layout === "single") {
      return pages.map((_, i) => ({ indices: [i] }));
    }

    const list: { indices: number[] }[] = [];
    let i = 0;
    if (layout === "two-page-cover" && pages.length > 0) {
      list.push({ indices: [0] });
      i = 1;
    }

    while (i < pages.length) {
      if (i + 1 < pages.length) {
        list.push({ indices: [i, i + 1] });
        i += 2;
      } else {
        list.push({ indices: [i] });
        i += 1;
      }
    }
    return list;
  });

  /** Largest page in the plan, so one scale suits the whole document. */
  const widest = $derived.by(() => {
    let width = 1;
    let height = 1;
    for (const entry of pages) {
      // Display size, so a landscape or rotated page drives the fit correctly.
      const d = edits.displayDims(entry);
      width = Math.max(width, d.width);
      height = Math.max(height, d.height);
    }
    const isSpread = viewer.pageLayout !== "single";
    return { width: isSpread ? width * 2 + GUTTER : width, height };
  });

  const scale = $derived.by(() => {
    const zoom = view.zoom;
    if (typeof zoom === "number") return zoom;
    if (containerWidth === 0) return 1;

    const availableWidth = containerWidth - GUTTER * 2;
    if (zoom === "fit-width") return Math.max(availableWidth / widest.width, 0.1);

    const availableHeight = containerHeight - GUTTER * 2;
    return Math.max(
      Math.min(availableWidth / widest.width, availableHeight / widest.height),
      0.1,
    );
  });

  // Publish the resolved scale so the toolbar can show a percentage.
  $effect(() => {
    view.scale = scale;
  });

  /** Indices to actually render. */
  const visible = $derived.by(() => {
    if (intersecting.size === 0) {
      // Before the observer reports anything, render the first screenful.
      return new Set(pages.map((_, i) => i).slice(0, OVERSCAN * 2 + 1));
    }
    const lo = Math.min(...intersecting) - OVERSCAN;
    const hi = Math.max(...intersecting) + OVERSCAN;
    const set = new Set<number>();
    for (let i = Math.max(0, lo); i <= Math.min(pages.length - 1, hi); i++) set.add(i);
    return set;
  });

  // ---------------------------------------------------------------- observers

  $effect(() => {
    const root = container;
    if (!root) return;

    const observer = new IntersectionObserver(
      (records) => {
        const next = new Set(intersecting);
        for (const record of records) {
          const index = Number((record.target as HTMLElement).dataset.index);
          if (Number.isNaN(index)) continue;
          if (record.isIntersecting) next.add(index);
          else next.delete(index);
        }
        intersecting = next;
      },
      { root, rootMargin: `${GUTTER * 4}px 0px` },
    );

    // `pages` is read so the observer is rebuilt when the plan changes.
    void pages.length;
    for (const el of pageEls) if (el) observer.observe(el);

    return () => observer.disconnect();
  });

  /** The page occupying the middle of the viewport is the "current" one. */
  function onScroll() {
    const root = container;
    if (!root) return;
    const middle = root.scrollTop + root.clientHeight / 2;
    let best = view.currentPage;
    let bestDistance = Infinity;
    pageEls.forEach((el, index) => {
      if (!el) return;
      const centre = el.offsetTop + el.offsetHeight / 2;
      const distance = Math.abs(centre - middle);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best !== view.currentPage) view.currentPage = best;
    view.scrollTop = root.scrollTop;
  }

  // ------------------------------------------------------------------ scrolling

  /**
   * Restore where this tab was. Inactive tabs are unmounted, so without this a
   * switch back would land at the top of the document.
   */
  $effect(() => {
    const root = container;
    if (!root || view.scrollTop === 0) return;
    root.scrollTop = view.scrollTop;
  });

  $effect(() => {
    const unregister = view.registerScroller((pageIndex, opts) => {
      const root = container;
      const el = pageEls[pageIndex];
      if (!root || !el) return;
      root.scrollTo({ top: Math.max(el.offsetTop - GUTTER + (opts?.top ?? 0), 0) });
      view.currentPage = pageIndex;
      view.scrollTop = root.scrollTop;
    });
    return unregister;
  });

  /**
   * Keep the current page anchored across zoom changes: capture its offset from
   * the top of the viewport before the DOM resizes, restore it after.
   */
  let anchor: { index: number; offset: number } | null = null;

  $effect.pre(() => {
    void scale;
    const root = container;
    const el = pageEls[view.currentPage];
    anchor = root && el ? { index: view.currentPage, offset: el.offsetTop - root.scrollTop } : null;
  });

  $effect(() => {
    void scale;
    const root = container;
    const pending = anchor;
    anchor = null;
    if (!root || !pending) return;
    const el = pageEls[pending.index];
    if (el) root.scrollTop = Math.max(el.offsetTop - pending.offset, 0);
  });

  function onPan(dx: number, dy: number) {
    const root = container;
    if (!root) return;
    root.scrollLeft += dx;
    root.scrollTop += dy;
  }

  /** Cmd/Ctrl + wheel zooms, as everywhere else on the desktop. */
  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    view.zoomBy(event.deltaY < 0 ? 1 : -1);
  }

  function onMouseMove(event: MouseEvent) {
    if (laserActive) {
      laserPos = { x: event.clientX, y: event.clientY };
    }
  }

  function onPresentationKeydown(event: KeyboardEvent) {
    if (!viewer.presentationMode) return;
    if (event.key === "Escape") {
      event.preventDefault();
      viewer.presentationMode = false;
    } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      view.goToPage(Math.min(view.currentPage + 1, pages.length - 1));
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      view.goToPage(Math.max(view.currentPage - 1, 0));
    }
  }
</script>

<svelte:window onkeydown={onPresentationKeydown} />

<div
  bind:this={container}
  bind:clientWidth={containerWidth}
  bind:clientHeight={containerHeight}
  class="viewer scroll reading-{viewer.readingMode}"
  class:presentation={viewer.presentationMode}
  role="region"
  aria-label="Document View"
  onscroll={onScroll}
  onwheel={onWheel}
  onmousemove={onMouseMove}
>
  <div class="column" style:gap="{GUTTER}px" style:padding="{GUTTER}px">
    {#each spreads as spread}
      <div class="spread-row" style:gap="{GUTTER}px">
        {#each spread.indices as index (pages[index].id)}
          {@const entry = pages[index]}
          <div
            bind:this={pageEls[index]}
            class="slot"
            data-index={index}
          >
            <PageView {tab} {entry} pageIndex={index} {scale} visible={visible.has(index)} {onPan} />
          </div>
        {/each}
      </div>
    {/each}
  </div>

  {#if laserActive && laserPos}
    <div
      class="laser-dot"
      style:left="{laserPos.x}px"
      style:top="{laserPos.y}px"
    ></div>
  {/if}

  {#if viewer.presentationMode}
    <div class="presentation-bar">
      <button class="pres-btn" onclick={() => view.goToPage(Math.max(view.currentPage - 1, 0))} title="Previous Page">
        <Icon name="chevron-left" size={16} />
      </button>
      <span class="pres-page">
        {view.currentPage + 1} / {pages.length}
      </span>
      <button class="pres-btn" onclick={() => view.goToPage(Math.min(view.currentPage + 1, pages.length - 1))} title="Next Page">
        <Icon name="chevron-right" size={16} />
      </button>
      <span class="pres-sep"></span>
      <button
        class="pres-btn"
        class:active={laserActive}
        onclick={() => (laserActive = !laserActive)}
        title="Toggle Laser Pointer"
      >
        <span class="laser-icon"></span> Laser
      </button>
      <button class="pres-btn exit" onclick={() => (viewer.presentationMode = false)} title="Exit Presentation">
        <Icon name="close" size={16} /> Exit
      </button>
    </div>
  {/if}
</div>

<style>
  .viewer {
    position: relative;
    flex: 1;
    min-width: 0;
    background: var(--bg-sunken);
  }

  /* Reading mode filters */
  :global(.viewer.reading-dark .page-view) {
    filter: invert(0.88) hue-rotate(180deg) contrast(1.1);
  }
  :global(.viewer.reading-sepia .page-view) {
    filter: sepia(0.35) contrast(0.95) brightness(0.95);
  }
  :global(.viewer.reading-invert .page-view) {
    filter: invert(1);
  }

  /* Presentation full screen mode */
  .viewer.presentation {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: #0f172a;
  }

  :global([data-glass]) .viewer {
    border-radius: var(--pane-radius);
    box-shadow: inset 0 0 0 0.5px var(--glass-stroke);
  }

  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: min-content;
  }

  .spread-row {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .slot {
    display: flex;
    flex: none;
  }

  /* Floating presentation controls */
  .presentation-bar {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.9);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 30px;
    padding: 6px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: #fff;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    z-index: 101;
  }

  .pres-btn {
    background: transparent;
    border: none;
    color: #e2e8f0;
    padding: 4px 8px;
    border-radius: 16px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .pres-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }

  .pres-btn.active {
    background: #ef4444;
    color: #fff;
  }

  .pres-page {
    font-size: 13px;
    font-weight: 500;
    min-width: 50px;
    text-align: center;
  }

  .pres-sep {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.2);
  }

  .laser-icon {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ef4444;
    box-shadow: 0 0 6px #ef4444;
    display: inline-block;
  }

  .laser-dot {
    position: fixed;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ef4444;
    box-shadow: 0 0 12px 3px #ef4444;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 102;
  }
</style>
