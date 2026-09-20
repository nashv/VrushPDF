<script lang="ts">
  /** The document's bookmark tree, if it has one. */
  import type { OutlineNode } from "$lib/pdf/pdfjs";
  import { MAIN_DOC } from "$lib/state/doc.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";
  import OutlinePanel from "./OutlinePanel.svelte";

  let {
    tab,
    nodes = null,
    depth = 0,
  }: { tab: DocumentTab; nodes?: OutlineNode[] | null; depth?: number } = $props();

  const items = $derived(nodes ?? tab.doc.outline);
  let collapsed = $state.raw(new Set<string>());

  /**
   * Outline destinations are indices into the *original* document, but the plan
   * may have been reordered — so resolve through the plan instead of trusting
   * the index.
   */
  function planIndexFor(sourceIndex: number): number {
    return tab.edits.pages.findIndex((p) => p.sourceDocId === MAIN_DOC && p.srcIndex === sourceIndex);
  }

  function go(node: OutlineNode) {
    if (node.pageIndex === null) return;
    const index = planIndexFor(node.pageIndex);
    if (index >= 0) tab.view.goToPage(index);
  }

  function toggle(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
  }
</script>

{#if depth === 0 && items.length === 0}
  <p class="empty muted">This document has no bookmarks.</p>
{:else}
  <ul class:root={depth === 0}>
    {#each items as node, i (`${depth}:${i}:${node.title}`)}
      {@const key = `${depth}:${i}`}
      {@const isCollapsed = collapsed.has(key)}
      <li>
        <div class="row" style:padding-left="{6 + depth * 12}px">
          {#if node.children.length > 0}
            <button
              class="twisty"
              class:collapsed={isCollapsed}
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              onclick={() => toggle(key)}
            >
              <Icon name="chevron-down" size={12} />
            </button>
          {:else}
            <span class="twisty-spacer"></span>
          {/if}
          <button
            class="title"
            class:unresolved={node.pageIndex === null}
            title={node.pageIndex === null ? "Destination could not be resolved" : node.title}
            onclick={() => go(node)}
          >
            {node.title}
          </button>
        </div>
        {#if node.children.length > 0 && !isCollapsed}
          <OutlinePanel {tab} nodes={node.children} depth={depth + 1} />
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  ul.root {
    height: 100%;
    min-height: 0;
    padding: 6px 6px 6px 0;
    overflow: auto;
    scrollbar-width: thin;
  }

  .empty {
    margin: 12px 10px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--radius);
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .twisty {
    display: grid;
    place-items: center;
    width: 18px;
    height: 22px;
    flex: none;
    color: var(--text-muted);
  }

  .twisty.collapsed {
    transform: rotate(-90deg);
  }

  .twisty-spacer {
    width: 18px;
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    padding: 4px 4px 4px 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title.unresolved {
    color: var(--text-faint);
    cursor: default;
  }
</style>
