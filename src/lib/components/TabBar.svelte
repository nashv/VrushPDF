<script lang="ts">
  /** The open-documents strip, above the toolbar. */
  import { hasGlass } from "$lib/platform";
  import { createReorder } from "$lib/reorder.svelte";
  import { session } from "$lib/state/session.svelte";
  import { workspace, type DocumentTab } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  let strip: HTMLDivElement | undefined = $state();
  let tabEls = $state<(HTMLDivElement | undefined)[]>([]);
  const tabs = $derived(workspace.tabs);

  // Pointer-based, not HTML5 drag-and-drop — see `$lib/reorder.svelte` for why
  // the obvious implementation cannot work inside this window. No scroller: the
  // strip is short enough that auto-scrolling would be more annoying than
  // useful.
  const reorder = createReorder({
    axis: "x",
    itemSelector: ".tab",
    onDrop: (from, to) => workspace.move(from, to),
  });

  /** A tab switched to by keyboard may be scrolled out of sight. */
  $effect(() => {
    const index = workspace.indexOf(workspace.activeId ?? "");
    tabEls[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  function onPointerDown(tab: DocumentTab, event: PointerEvent) {
    // Middle-click closes, as in a browser.
    if (event.button === 1) {
      event.preventDefault();
      void session.requestClose(tab);
      return;
    }
    if (event.button === 0) workspace.activate(tab.id);
  }
</script>

<div
  class="tabbar"
  bind:this={strip}
  role="tablist"
  aria-label="Open documents"
  data-tauri-drag-region={hasGlass ? "" : undefined}
>
  <div class="strip">
    {#each tabs as tab, index (tab.id)}
      {@const active = tab.id === workspace.activeId}
      <!--
        Drag-to-reorder lives on the wrapper so the whole tab is a handle; the
        inner button is the real control for activation and keyboard focus.
      -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={tabEls[index]}
        class="tab"
        class:active
        class:dragging={reorder.from === index}
        class:drop-before={reorder.to === index && reorder.from !== null && reorder.from > index}
        class:drop-after={reorder.to === index && reorder.from !== null && reorder.from < index}
        data-reorder-index={index}
        onpointerdown={(event) => reorder.down(index, event)}
      >
        <button
          class="tab-name"
          role="tab"
          aria-selected={active}
          title={tab.path ?? tab.title}
          onpointerdown={(event) => onPointerDown(tab, event)}
        >
          <span class="name">{tab.title}</span>
          {#if tab.dirty}
            <span class="dot" title="Unsaved changes" aria-label="Unsaved changes">●</span>
          {/if}
        </button>
        <button
          class="close"
          title="Close tab (⌘W)"
          aria-label="Close {tab.title}"
          onclick={() => session.requestClose(tab)}
        >
          <Icon name="close" size={11} />
        </button>
      </div>
    {/each}
  </div>

  <button class="add" title="Open a PDF (⌘O)" aria-label="Open a PDF" onclick={() => session.openViaDialog()}>
    <Icon name="plus" size={14} />
  </button>
</div>

<style>
  .tabbar {
    display: flex;
    align-items: stretch;
    flex: none;
    height: 28px;
    background: var(--bg-sunken);
    border-bottom: 1px solid var(--border);
  }

  .strip {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .strip::-webkit-scrollbar {
    display: none;
  }

  .tab.dragging {
    opacity: 0.5;
  }

  /* Tabs divide the strip evenly and grow into it, as they do in Finder and
     Terminal, rather than sitting as fixed blocks with dead space beside them. */
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 0;
    min-width: 88px;
    max-width: 260px;
    padding-right: 4px;
    border-right: 1px solid var(--border);
    color: var(--text-muted);
  }

  .tab:last-child {
    border-right: none;
  }

  .tab:hover {
    background: var(--bg-hover);
  }

  /*
   * The active tab is the one carrying the raised background against the
   * recessed strip — no accent rule. Its separators are suppressed on both
   * sides, which is the detail that stops a flat strip reading as a row of
   * boxes.
   */
  .tab.active {
    background: var(--bg-raised);
    color: var(--text);
    border-right-color: transparent;
  }

  .tab.active + .tab {
    border-left: 1px solid transparent;
    margin-left: -1px;
  }

  .tab-name {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 4px 0 11px;
    color: inherit;
    text-align: left;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    color: var(--accent);
    font-size: 13px;
    line-height: 1;
  }

  .close {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: 4px;
    color: var(--text-faint);
    /* Hidden until useful, so a row of tabs isn't a row of × buttons. */
    opacity: 0;
  }

  .tab:hover .close,
  .tab.active .close,
  .close:focus-visible {
    opacity: 1;
  }

  .close:hover {
    background: var(--bg-active);
    color: var(--text);
  }

  .tab.drop-before {
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .tab.drop-after {
    box-shadow: inset -2px 0 0 var(--accent);
  }

  .add {
    display: grid;
    place-items: center;
    width: 32px;
    flex: none;
    color: var(--text-muted);
  }

  .add:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  /*
   * Liquid Glass (macOS): a recessed capsule track on the window's glass, with
   * the active tab as a raised pill inside it, the way a segmented control is
   * drawn. The strip still grows its tabs to fill.
   */
  :global([data-glass]) .tabbar {
    gap: 6px;
    height: 36px;
    padding: 0 10px 6px;
    background: none;
    border-bottom: none;
  }

  :global([data-glass]) .strip {
    gap: 2px;
    padding: 2px;
    border-radius: 999px;
    background: var(--glass-track);
  }

  :global([data-glass]) .tab,
  :global([data-glass]) .tab:last-child {
    border: none;
    border-radius: 999px;
  }

  :global([data-glass]) .tab.active {
    background: var(--glass-fill);
    box-shadow: var(--glass-edge), var(--glass-lift);
  }

  :global([data-glass]) .tab.active + .tab {
    margin-left: 0;
  }

  :global([data-glass]) .close,
  :global([data-glass]) .add {
    border-radius: 999px;
  }

  :global([data-glass]) .add {
    width: 30px;
  }
</style>
