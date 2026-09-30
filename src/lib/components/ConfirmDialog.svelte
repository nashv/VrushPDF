<script lang="ts">
  /** The unsaved-changes prompt shown when closing a dirty tab. */
  import { session } from "$lib/state/session.svelte";
  import Icon from "./Icon.svelte";

  const request = $derived(session.closeRequest);
  let saveButton: HTMLButtonElement | undefined = $state();

  $effect(() => {
    // Save is the safe default, so give it the focus and the Return key.
    if (request) saveButton?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    if (!request) return;
    if (event.key === "Escape") {
      event.preventDefault();
      session.answerClose("cancel");
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if request}
  <div class="backdrop"></div>

  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title"><Icon name="warning" /> Unsaved changes</h2>
    <p class="muted">
      “{request.tab.title}” has changes that haven't been saved. Save them before closing?
    </p>

    <footer>
      <button class="btn danger" onclick={() => session.answerClose("discard")}>
        Don't Save
      </button>
      <span class="spacer"></span>
      <button class="btn outlined" onclick={() => session.answerClose("cancel")}>Cancel</button>
      <button bind:this={saveButton} class="btn primary" onclick={() => session.answerClose("save")}>
        Save
      </button>
    </footer>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(440px, calc(100vw - 32px));
    padding: 18px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 15px;
  }

  p {
    margin: 0;
    line-height: 1.5;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }

  .spacer {
    flex: 1;
  }
</style>
