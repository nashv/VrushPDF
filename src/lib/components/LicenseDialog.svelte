<script lang="ts">
  /**
   * License status, key entry, and the way to buy one.
   *
   * Opened from the app menu, from the trial capsule in the toolbar, and by any
   * edit the ended trial blocks, in which case `license.reason` says which.
   */
  import { openUrl } from "@tauri-apps/plugin-opener";

  import { readKey } from "$lib/license/key";
  import { license } from "$lib/state/license.svelte";
  import Icon from "./Icon.svelte";

  let input = $state("");
  let busy = $state<"activate" | "remove" | null>(null);
  let error = $state<string | null>(null);
  let field: HTMLTextAreaElement | undefined = $state();

  const status = $derived(license.status);
  const licensed = $derived(status?.state === "licensed");
  const parsed = $derived(readKey(input));

  /** Keys are pasted whole, so anything else is worth saying so at once. */
  const hint = $derived.by(() => {
    if (input.trim() === "") return null;
    if (parsed) return { ok: true, text: `Key for ${parsed.email}.` };
    return { ok: false, text: "That isn't a whole license key. Copy all of it from your purchase email." };
  });

  const headline = $derived.by(() => {
    switch (status?.state) {
      case "licensed":
        return status.email ? `Licensed to ${status.email}` : "Licensed";
      case "trial": {
        const days = status.daysLeft ?? 0;
        return `Free trial: ${days} ${days === 1 ? "day" : "days"} left`;
      }
      case "expired":
        return "Your free trial has ended";
      case "revoked":
        return "This license is no longer valid";
      default:
        return "License";
    }
  });

  $effect(() => {
    if (!licensed) field?.focus();
  });

  async function activate() {
    if (!parsed || busy) return;
    busy = "activate";
    error = null;
    try {
      await license.activate(parsed.key);
      input = "";
    } catch (err) {
      error = String(err);
    } finally {
      busy = null;
    }
  }

  async function remove() {
    if (busy) return;
    busy = "remove";
    error = null;
    try {
      await license.remove();
    } catch (err) {
      error = String(err);
    } finally {
      busy = null;
    }
  }

  function buy() {
    if (status) void openUrl(status.buyUrl).catch(() => {});
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      license.closeDialog();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="license-title">
  <h2 id="license-title">
    {#if licensed}<Icon name="check" />{:else if status?.state === "expired" || status?.state === "revoked"}<Icon
        name="warning"
      />{/if}
    {headline}
  </h2>

  {#if license.reason && !licensed}
    <p class="reason">{license.reason}</p>
  {/if}

  {#if licensed}
    <p class="muted">
      Thank you for buying VrushPDF. Your key (<span class="key">{status?.keyId}</span>) is yours to use on
      your own computers; enter it on each one.
    </p>
  {:else}
    <p class="muted">
      {#if status?.state === "trial"}
        Everything works during the trial. Afterwards you can still open and read PDFs, but saving and editing
        need a license.
      {:else}
        You can still open and read PDFs. Saving, annotating and editing pages need a license.
      {/if}
    </p>

    <form
      class="enter"
      onsubmit={(event) => {
        event.preventDefault();
        void activate();
      }}
    >
      <label class="label" for="license-key">License key</label>
      <textarea
        id="license-key"
        bind:this={field}
        bind:value={input}
        class="field key-input"
        rows="3"
        placeholder="Paste the key from your purchase email. It starts with VRSH."
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        disabled={busy !== null}
        onkeydown={(event) => {
          // The key is one line however it wraps, so Return submits.
          if (event.key === "Enter") {
            event.preventDefault();
            void activate();
          }
        }}
      ></textarea>
      {#if hint}
        <span class="hint" class:bad={!hint.ok}>{hint.text}</span>
      {/if}
    </form>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <footer>
    {#if licensed}
      <button class="btn outlined" disabled={busy !== null} onclick={remove}>Remove License</button>
      <span class="spacer"></span>
      <button class="btn primary" onclick={() => license.closeDialog()}>Done</button>
    {:else}
      <button class="btn outlined" onclick={buy}>Buy VrushPDF…</button>
      <span class="spacer"></span>
      <button class="btn" disabled={busy !== null} onclick={() => license.closeDialog()}>
        {status?.state === "trial" ? "Continue Trial" : "Not Now"}
      </button>
      <button class="btn primary" disabled={!parsed || busy !== null} onclick={activate}>
        {busy === "activate" ? "Activating…" : "Activate"}
      </button>
    {/if}
  </footer>
</div>

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
    width: min(460px, calc(100vw - 32px));
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

  .reason {
    padding: 8px 10px;
    border-radius: var(--radius);
    background: var(--accent-soft);
  }

  .key {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
    white-space: nowrap;
  }

  .enter {
    display: flex;
    flex-direction: column;
  }

  /* Case matters in a key, so no text-transform here. */
  .key-input {
    resize: none;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
    line-height: 1.4;
    word-break: break-all;
  }

  .key-input::placeholder {
    font-family: inherit;
    word-break: normal;
  }

  .hint {
    margin-top: 5px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .hint.bad,
  .error {
    color: var(--danger);
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .spacer {
    flex: 1;
  }
</style>
