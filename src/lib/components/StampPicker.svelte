<script lang="ts">
  /** Dropdown for choosing a saved signature or an image stamp to place. */
  import { images } from "$lib/state/images.svelte";
  import { session } from "$lib/state/session.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import Icon from "./Icon.svelte";

  let { onClose, onDraw }: { onClose: () => void; onDraw: () => void } = $props();

  const signatures = $derived(images.signatures);
  const standard = $derived(images.standard);
  /** Excludes the built-ins, which have their own section. */
  const others = $derived(images.uploaded);

  function arm(id: string, isSignature: boolean) {
    viewer.setTool(isSignature ? "signature" : "stamp");
    viewer.pendingStamp = id;
    onClose();
  }

  async function remove(id: string) {
    if (viewer.pendingStamp === id) viewer.pendingStamp = null;
    await images.deleteSignature(id).catch(() => session.notify("Could not delete that signature.", "error"));
  }

  /** Close on outside click or Escape, like any other menu. */
  function dismissable(node: HTMLElement) {
    const onPointerDown = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener("pointerdown", onPointerDown));
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }
</script>

<div class="menu" {@attach dismissable} role="menu" aria-label="Stamps and signatures">
  <div class="head">Signatures</div>

  {#if signatures.length === 0}
    <p class="empty">No saved signatures yet.</p>
  {:else}
    <ul>
      {#each signatures as item (item.id)}
        <li>
          <button class="entry" onclick={() => arm(item.id, true)} title="Place {item.name}">
            <img src={item.url} alt={item.name} />
            <span class="entry-name">{item.name}</span>
          </button>
          <button
            class="btn square danger"
            title="Delete signature"
            aria-label="Delete {item.name}"
            onclick={() => remove(item.id)}
          >
            <Icon name="trash" size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <button class="action" onclick={onDraw}>
    <Icon name="signature" /> Draw a new signature…
  </button>

  {#if standard.length > 0}
    <div class="head">Standard</div>
    <ul>
      {#each standard as item (item.id)}
        <li>
          <button class="entry" onclick={() => arm(item.id, false)} title="Place {item.name}">
            <img src={item.url} alt={item.name} />
            <span class="entry-name">{item.name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if others.length > 0}
    <div class="head">Images</div>
    <ul>
      {#each others as item (item.id)}
        <li>
          <button class="entry" onclick={() => arm(item.id, false)} title="Place {item.name}">
            <img src={item.url} alt={item.name} />
            <span class="entry-name">{item.name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <button
    class="action"
    onclick={() => {
      onClose();
      session.addImageStamp();
    }}
  >
    <Icon name="stamp" /> Add an image…
  </button>
</div>

<style>
  .menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 40;
    width: 268px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-raised);
    box-shadow: var(--shadow-3);
  }

  .head {
    padding: 6px 8px 4px;
    font-size: 11px
    ;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .empty {
    margin: 0;
    padding: 2px 8px 8px;
    color: var(--text-muted);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .entry {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: var(--radius);
  }

  .entry:hover {
    background: var(--bg-hover);
  }

  .entry img {
    width: 56px;
    height: 28px;
    object-fit: contain;
    /* Signatures are dark ink on transparency; a light tile keeps them visible
       in dark mode. */
    background: #ffffff;
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .entry-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
    padding: 7px 8px;
    border-radius: var(--radius);
    color: var(--accent);
  }

  .action:hover {
    background: var(--bg-hover);
  }
</style>
