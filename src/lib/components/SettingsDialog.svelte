<script lang="ts">
  /**
   * Preferences.
   *
   * Reads from two places on purpose: `settings` is backed by a file because
   * Rust has to read it before the window exists, while `viewer` keeps the
   * purely visual preferences in localStorage. The split is invisible here.
   */
  import { isMac } from "$lib/platform";
  import { session } from "$lib/state/session.svelte";
  import { settings } from "$lib/state/settings.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import Icon from "./Icon.svelte";

  let closeButton: HTMLButtonElement | undefined = $state();

  $effect(() => {
    closeButton?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeSettings();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
  <h2 id="settings-title">Settings</h2>

  <div class="rows">
    <label class="row" class:disabled={isMac}>
      <input
        type="checkbox"
        checked={settings.singleInstance}
        disabled={isMac}
        onchange={(event) => settings.setSingleInstance(event.currentTarget.checked)}
      />
      <span class="lines">
        <span>Open files in the running app</span>
        <span class="note muted">
          {#if isMac}
            macOS always does this — it will not start a second copy of an app.
          {:else}
            Double-clicking a PDF adds a tab here instead of starting another
            copy of VrushPDF.
          {/if}
        </span>
      </span>
    </label>

    <label class="row">
      <input
        type="checkbox"
        checked={viewer.toolbarLabels}
        onchange={() => viewer.toggleToolbarLabels()}
      />
      <span class="lines">
        <span>Show button labels</span>
        <span class="note muted">Put a caption under every toolbar button.</span>
      </span>
    </label>

    <label class="row">
      <input
        type="checkbox"
        checked={settings.warnUnflattenedSignatures}
        onchange={(event) => settings.setWarnUnflattenedSignatures(event.currentTarget.checked)}
      />
      <span class="lines">
        <span>Warn when saving signed documents unflattened</span>
        <span class="note muted">
          Prompt before saving a document that contains signatures to prevent leaving them as editable annotations.
        </span>
      </span>
    </label>

    <label class="row">
      <input
        type="checkbox"
        checked={settings.autoUpdate}
        onchange={(event) => settings.setAutoUpdate(event.currentTarget.checked)}
      />
      <span class="lines">
        <span>Automatically check for updates</span>
        <span class="note muted">
          Check the public VrushPDF repository for later releases and notify when updates are available.
        </span>
      </span>
    </label>
  </div>

  <footer>
    <span class="spacer"></span>
    <button bind:this={closeButton} class="btn primary" onclick={() => session.closeSettings()}>
      Done
    </button>
  </footer>
</div>

<style>
  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(460px, 92vw);
    padding: 18px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  h2 {
    margin: 0;
    font-size: 15px;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .row.disabled {
    opacity: 0.65;
  }

  .row input {
    margin-top: 2px;
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .note {
    font-size: 11px;
    line-height: 1.4;
  }

  footer {
    display: flex;
    align-items: center;
  }

  .spacer {
    flex: 1;
  }
</style>
