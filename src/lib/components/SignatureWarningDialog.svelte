<script lang="ts">
  /**
   * Warning prompt shown when saving a signed document unflattened.
   *
   * Allows the user to choose between flattening the document (recommended for
   * signatures), keeping it unflattened, or cancelling the save. A checkbox
   * allows permanently disabling this warning in settings.
   */
  import { session } from "$lib/state/session.svelte";
  import { settings } from "$lib/state/settings.svelte";
  import Icon from "./Icon.svelte";

  const request = $derived(session.signatureWarningRequest);
  let dontWarnAgain = $state(false);
  let flattenButton: HTMLButtonElement | undefined = $state();

  $effect(() => {
    if (request) {
      dontWarnAgain = false;
      flattenButton?.focus();
    }
  });

  function choose(choice: "flatten" | "unflatten" | "cancel") {
    if (dontWarnAgain && choice !== "cancel") {
      void settings.setWarnUnflattenedSignatures(false);
    }
    session.answerSignatureWarning(choice);
  }

  function onKeydown(event: KeyboardEvent) {
    if (!request) return;
    if (event.key === "Escape") {
      event.preventDefault();
      choose("cancel");
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if request}
  <div class="backdrop"></div>

  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="sig-warning-title">
    <h2 id="sig-warning-title"><Icon name="warning" /> Unflattened Signature Warning</h2>
    <p class="muted">
      This document contains one or more signatures. If saved unflattened, signatures remain
      interactive annotation objects that can be moved, modified, or extracted by other PDF viewers.
    </p>
    <p class="muted">
      Saving as a flattened PDF merges signatures and annotations into the page graphics, locking them permanently.
    </p>

    <label class="dont-ask">
      <input type="checkbox" bind:checked={dontWarnAgain} />
      <span>Don't show this warning again</span>
    </label>

    <footer>
      <button class="btn outlined" onclick={() => choose("cancel")}>Cancel</button>
      <button class="btn outlined" onclick={() => choose("unflatten")}>
        Save Unflattened
      </button>
      <button bind:this={flattenButton} class="btn primary" onclick={() => choose("flatten")}>
        Save Flattened
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
    gap: 12px;
    width: min(480px, calc(100vw - 32px));
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
    font-size: 13px;
    line-height: 1.5;
  }

  .dont-ask {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    margin-top: 4px;
    cursor: pointer;
    user-select: none;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
</style>
