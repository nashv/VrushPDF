<script lang="ts">
  /** Left panel: thumbnails, annotations, bookmarks, search. */
  import { viewer, type SidebarTab } from "$lib/state/viewer.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import AnnotationList from "./AnnotationList.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import OutlinePanel from "./OutlinePanel.svelte";
  import SearchPanel from "./SearchPanel.svelte";
  import ThumbnailStrip from "./ThumbnailStrip.svelte";

  let { tab }: { tab: DocumentTab } = $props();

  const tabs: {
    id: SidebarTab;
    icon: IconName;
    /** Short form shown under the icon. */
    label: string;
    /** Full name, for the tooltip and the accessible label. */
    title: string;
  }[] = [
    { id: "thumbnails", icon: "thumbnails", label: "Pages", title: "Pages" },
    { id: "annotations", icon: "list", label: "Notes", title: "Annotations" },
    { id: "outline", icon: "outline", label: "Outline", title: "Bookmarks" },
    { id: "search", icon: "search", label: "Find", title: "Search" },
  ];

  const counts = $derived({
    thumbnails: tab.edits.pages.length,
    annotations: tab.edits.annots.length,
    outline: 0,
    search: tab.search.results.length,
  });
</script>

<aside class="sidebar" style:width="{viewer.panelWidth.sidebar}px">
  <nav class="tabs" aria-label="Sidebar sections">
    {#each tabs as section (section.id)}
      <button
        class="tab"
        class:active={viewer.sidebarTab === section.id}
        title={section.title}
        aria-label={section.title}
        aria-pressed={viewer.sidebarTab === section.id}
        onclick={() => (viewer.sidebarTab = section.id)}
      >
        <Icon name={section.icon} />
        <span class="tab-label">{section.label}</span>
        {#if counts[section.id] > 0}
          <span class="count">{counts[section.id]}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="body">
    {#if viewer.sidebarTab === "thumbnails"}
      <ThumbnailStrip {tab} />
    {:else if viewer.sidebarTab === "annotations"}
      <AnnotationList {tab} />
    {:else if viewer.sidebarTab === "outline"}
      <OutlinePanel {tab} />
    {:else}
      <SearchPanel {tab} />
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    flex: none;
    width: var(--sidebar-w);
    /* Caps the panel against the window, so the viewer can never be squeezed
       out on a narrow window and no resize listener is needed. */
    max-width: 40%;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-raised);
  }

  /*
   * Too narrow for three columns: overlay the viewer rather than squeeze it.
   * Purely CSS, so it reverses cleanly when the window grows again and no
   * state has to be tracked.
   */
  @media (max-width: 899px) {
    .sidebar {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 30;
      max-width: 80%;
      box-shadow: var(--shadow-3);
    }
  }

  .tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    flex: none;
    border-bottom: 1px solid var(--border);
  }

  .tab {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 7px 2px 6px;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
  }

  .tab:hover {
    background: var(--bg-hover);
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-label {
    font-size: 10px;
    letter-spacing: 0.01em;
  }

  .count {
    position: absolute;
    top: 3px;
    right: 6px;
    min-width: 15px;
    padding: 0 3px;
    border-radius: 99px;
    background: var(--bg-active);
    color: var(--text-muted);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    line-height: 15px;
    text-align: center;
  }

  .body {
    flex: 1;
    min-height: 0;
  }

  /*
   * Liquid Glass (macOS): an inset card that tints the window's glass rather
   * than covering it. The page shell supplies the gutter around it.
   */
  :global([data-glass]) .sidebar {
    border-right: none;
    border-radius: var(--pane-radius);
    background: var(--pane-fill);
    box-shadow: var(--glass-edge), var(--glass-lift);
    overflow: hidden;
  }

  /* Overlaid, it sits on the document instead of the native glass, so it has
     to frost the pages beneath it itself. */
  @media (max-width: 899px) {
    :global([data-glass]) .sidebar {
      bottom: var(--pane-gap);
      left: var(--pane-gap);
      background: var(--surface-float);
      backdrop-filter: var(--surface-float-filter);
    }
  }

  /* The section tabs become a segmented control. */
  :global([data-glass]) .tabs {
    gap: 2px;
    margin: 8px;
    padding: 2px;
    border-bottom: none;
    border-radius: 12px;
    background: var(--glass-track);
  }

  :global([data-glass]) .tab {
    padding: 5px 2px 4px;
    border-bottom: none;
    border-radius: 10px;
  }

  :global([data-glass]) .tab.active {
    background: var(--glass-fill);
    box-shadow: var(--glass-edge), var(--glass-lift);
  }
</style>
