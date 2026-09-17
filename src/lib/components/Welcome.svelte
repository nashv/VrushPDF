<script lang="ts">
  /** Shown when no document is open: drop target plus recent files. */
  import { onMount } from "svelte";
  import { recentsGet, type FileMeta } from "$lib/tauri/files";
  import { session } from "$lib/state/session.svelte";
  import Icon from "./Icon.svelte";

  let recents = $state.raw<FileMeta[]>([]);

  onMount(async () => {
    recents = await recentsGet().catch(() => []);
  });

  function sizeOf(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");
</script>

<div class="welcome">
  <div class="hero">
    <Icon name="file" size={40} />
    <h1>PDF Editor</h1>
    <p class="muted">Open a PDF to read, mark it up, sign it, and rearrange its pages.</p>
    <button class="btn primary big" onclick={() => session.openViaDialog()}>
      <Icon name="open" /> Open a PDF…
    </button>
    <p class="drop muted">…or drop one onto this window.</p>
  </div>

  {#if recents.length > 0}
    <div class="recents">
      <h2>Recent</h2>
      <ul>
        {#each recents as file (file.path)}
          <li>
            <button class="recent" onclick={() => session.openPath(file.path)} title={file.path}>
              <Icon name="file" size={15} />
              <span class="lines">
                <span class="file-name">{file.name}</span>
                <span class="path muted">{folderOf(file.path)}</span>
              </span>
              <span class="size muted">{sizeOf(file.size)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .welcome {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 34px;
    min-height: 0;
    padding: 40px 20px;
    overflow: auto;
    background: var(--bg-sunken);
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    text-align: center;
  }

  h1 {
    margin: 4px 0 0;
    color: var(--text);
    font-size: 22px;
  }

  .hero p {
    margin: 0;
    max-width: 42ch;
    line-height: 1.5;
  }

  .big {
    height: 34px;
    margin-top: 12px;
    padding: 0 16px;
  }

  .drop {
    font-size: 12px;
  }

  .recents {
    width: min(520px, 100%);
  }

  h2 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-raised);
    overflow: hidden;
  }

  li + li {
    border-top: 1px solid var(--border);
  }

  .recent {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    text-align: left;
  }

  .recent:hover {
    background: var(--bg-hover);
  }

  .lines {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .file-name {
    font-weight: 600;
  }

  .file-name,
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path {
    font-size: 11px;
    /* Long paths are more identifiable from the tail than the head. */
    direction: rtl;
    text-align: left;
  }

  .size {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
</style>
