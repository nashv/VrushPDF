<script lang="ts">
  /** Full-text search across the document. */
  import type { DocumentTab } from "$lib/state/workspace.svelte";

  let { tab }: { tab: DocumentTab } = $props();
  const search = $derived(tab.search);
  import Icon from "./Icon.svelte";

  let input: HTMLInputElement | undefined = $state();

  /** Debounced so typing doesn't restart the scan on every keystroke. */
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRun() {
    clearTimeout(timer);
    timer = setTimeout(() => search.run(), 220);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(timer);
      // Enter on an existing result set steps through it rather than re-running.
      if (search.results.length > 0) {
        if (event.shiftKey) search.previous();
        else search.next();
      } else {
        search.run();
      }
    }
  }

  // Opening the panel should put the caret in the box; no dependencies, so this
  // runs once on mount.
  $effect(() => {
    input?.focus();
    input?.select();
  });
</script>

<div class="panel">
  <div class="query">
    <span class="input-wrap">
      <Icon name="search" size={14} />
      <input
        bind:this={input}
        class="field"
        type="text"
        placeholder="Find in document"
        bind:value={search.query}
        oninput={scheduleRun}
        onkeydown={onKeydown}
        aria-label="Search text"
      />
      {#if search.query}
        <button class="clear" aria-label="Clear search" onclick={() => search.clear()}>
          <Icon name="close" size={12} />
        </button>
      {/if}
    </span>
  </div>

  <div class="options">
    <label>
      <input type="checkbox" bind:checked={search.matchCase} onchange={() => search.run()} />
      Match case
    </label>
    <label>
      <input type="checkbox" bind:checked={search.wholeWords} onchange={() => search.run()} />
      Whole words
    </label>
  </div>

  <div class="status">
    {#if search.running}
      <span class="muted">Searching…</span>
    {:else if search.query.trim() && search.results.length === 0}
      <span class="muted">No matches</span>
    {:else if search.results.length > 0}
      <span class="muted">
        {search.activeIndex + 1} of {search.results.length}
      </span>
    {:else}
      <span class="muted">Type to search</span>
    {/if}

    <span class="spacer"></span>
    <button
      class="btn square"
      title="Previous match (⇧⏎)"
      disabled={search.results.length === 0}
      onclick={() => search.previous()}
    >
      <Icon name="chevron-left" />
    </button>
    <button
      class="btn square"
      title="Next match (⏎)"
      disabled={search.results.length === 0}
      onclick={() => search.next()}
    >
      <Icon name="chevron-right" />
    </button>
  </div>

  <ul class="results scroll">
    {#each search.results as match, index (index)}
      <li>
        <button
          class="result"
          class:selected={index === search.activeIndex}
          onclick={() => search.goTo(index)}
        >
          <span class="page">p{match.pageIndex + 1}</span>
          <span class="snippet">
            {match.snippet.slice(0, match.snippetOffset)}<mark
              >{match.snippet.slice(
                match.snippetOffset,
                match.snippetOffset + match.snippetLength,
              )}</mark
            >{match.snippet.slice(match.snippetOffset + match.snippetLength)}
          </span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .query {
    flex: none;
    padding: 8px;
  }

  .input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .input-wrap :global(svg) {
    position: absolute;
    left: 8px;
    color: var(--text-faint);
    pointer-events: none;
  }

  .query input {
    width: 100%;
    padding-left: 28px;
    padding-right: 24px;
  }

  .clear {
    position: absolute;
    right: 6px;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 99px;
    color: var(--text-muted);
  }

  .clear:hover {
    background: var(--bg-active);
  }

  .options {
    display: flex;
    gap: 14px;
    flex: none;
    padding: 0 10px 8px;
    color: var(--text-muted);
  }

  .options label {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    padding: 4px 6px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .status .muted {
    padding-left: 4px;
    font-variant-numeric: tabular-nums;
  }

  .spacer {
    flex: 1;
  }

  .results {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 4px;
    list-style: none;
  }

  .result {
    display: flex;
    width: 100%;
    gap: 8px;
    padding: 6px;
    border-radius: var(--radius);
    text-align: left;
  }

  .result:hover {
    background: var(--bg-hover);
  }

  .result.selected {
    background: var(--accent-soft);
  }

  .page {
    flex: none;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .snippet {
    overflow: hidden;
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  mark {
    background: #fde047;
    color: #111827;
    border-radius: 2px;
  }
</style>
