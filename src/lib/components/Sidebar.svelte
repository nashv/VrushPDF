<script lang="ts">
  /** Left panel: thumbnails, annotations, bookmarks, search. */
  import { edits } from "$lib/state/edits.svelte";
  import { search } from "$lib/state/search.svelte";
  import { viewer, type SidebarTab } from "$lib/state/viewer.svelte";
  import AnnotationList from "./AnnotationList.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import OutlinePanel from "./OutlinePanel.svelte";
  import SearchPanel from "./SearchPanel.svelte";
  import ThumbnailStrip from "./ThumbnailStrip.svelte";

  const tabs: {
    id: SidebarTab;
    icon: IconName;
    title: string;
  }[] = [
    { id: "thumbnails", icon: "thumbnails", title: "Pages" },
    { id: "annotations", icon: "list", title: "Annotations" },
    { id: "outline", icon: "outline", title: "Bookmarks" },
    { id: "search", icon: "search", title: "Search" },
  ];

  const counts = $derived({
    thumbnails: edits.pages.length,
    annotations: edits.annots.length,
    outline: 0,
    search: search.results.length,
  });
</script>

<aside class="sidebar">
  <nav class="tabs" aria-label="Sidebar sections">
    {#each tabs as tab (tab.id)}
      <button
        class="tab"
        class:active={viewer.sidebarTab === tab.id}
        title={tab.title}
        aria-pressed={viewer.sidebarTab === tab.id}
        onclick={() => (viewer.sidebarTab = tab.id)}
      >
        <Icon name={tab.icon} />
        <span class="tab-label">{tab.title}</span>
        {#if counts[tab.id] > 0}
          <span class="count">{counts[tab.id]}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="body">
    {#if viewer.sidebarTab === "thumbnails"}
      <ThumbnailStrip />
    {:else if viewer.sidebarTab === "annotations"}
      <AnnotationList />
    {:else if viewer.sidebarTab === "outline"}
      <OutlinePanel />
    {:else}
      <SearchPanel />
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    flex: none;
    width: var(--sidebar-w);
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-raised);
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
</style>
