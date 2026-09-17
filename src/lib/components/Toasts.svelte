<script lang="ts">
  /** Transient status messages, bottom-centre. */
  import { session } from "$lib/state/session.svelte";
  import Icon from "./Icon.svelte";
</script>

<div class="stack" role="status" aria-live="polite">
  {#each session.toasts as toast (toast.id)}
    <div class="toast" class:error={toast.kind === "error"}>
      {#if toast.kind === "error"}<Icon name="warning" size={14} />{:else}<Icon name="check" size={14} />{/if}
      <span>{toast.message}</span>
      <button aria-label="Dismiss" onclick={() => session.dismiss(toast.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    bottom: 18px;
    left: 50%;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    transform: translateX(-50%);
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: min(520px, calc(100vw - 40px));
    padding: 8px 10px 8px 12px;
    border: 1px solid var(--border);
    border-radius: 99px;
    background: var(--bg-raised);
    box-shadow: var(--shadow-3);
    pointer-events: auto;
  }

  .toast.error {
    border-color: var(--danger);
    color: var(--danger);
  }

  .toast button {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: 99px;
    color: var(--text-muted);
  }

  .toast button:hover {
    background: var(--bg-active);
  }
</style>
