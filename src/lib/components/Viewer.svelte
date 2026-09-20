<script lang="ts">
  /**
   * The scrolling page list.
   *
   * Owns three things the pages themselves can't: the effective zoom scale
   * (which depends on the container's width), which pages are close enough to
   * the viewport to be worth rendering, and the scroll position.
   */
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import PageView from "./PageView.svelte";

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
  /**
   * Must be deeply reactive, not `$state.raw`: `bind:this` assigns into it by
   * index, and the observer and scroll effects have to see those writes.
   */
  let pageEls = $state<(HTMLDivElement | undefined)[]>([]);
  let intersecting = $state.raw(new Set<number>());

  const pages = $derived(edits.pages);

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
    return { width, height };
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
</script>

<div
  bind:this={container}
  bind:clientWidth={containerWidth}
  bind:clientHeight={containerHeight}
  class="viewer scroll"
  onscroll={onScroll}
  onwheel={onWheel}
>
  <div class="column" style:gap="{GUTTER}px" style:padding="{GUTTER}px">
    {#each pages as entry, index (entry.id)}
      <div
        bind:this={pageEls[index]}
        class="slot"
        data-index={index}
      >
        <PageView {tab} {entry} pageIndex={index} {scale} visible={visible.has(index)} {onPan} />
      </div>
    {/each}
  </div>
</div>

<style>
  .viewer {
    position: relative;
    flex: 1;
    min-width: 0;
    background: var(--bg-sunken);
  }

  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
    /* min-content keeps the column from collapsing narrower than a zoomed page,
       which is what allows horizontal scrolling at high zoom. */
    min-width: min-content;
  }

  .slot {
    display: flex;
    flex: none;
  }
</style>
