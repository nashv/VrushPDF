<script lang="ts">
  /** Prompt for an encrypted document's password. */
  import { session } from "$lib/state/session.svelte";
  import Icon from "./Icon.svelte";

  let password = $state("");
  let input: HTMLInputElement | undefined = $state();

  const path = $derived(session.passwordFor);
  const name = $derived(path?.split("/").pop() ?? "");

  $effect(() => {
    input?.focus();
  });

  async function submit(event: Event) {
    event.preventDefault();
    if (!path) return;
    const attempt = password;
    password = "";
    // The session remembers which tab the file was being opened into.
    await session.submitPassword(attempt);
  }

  function cancel() {
    password = "";
    session.cancelPassword();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") cancel();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<form class="dialog" onsubmit={submit} aria-label="Password required">
  <h2><Icon name="warning" /> Password required</h2>
  <p class="muted">“{name}” is encrypted. Enter its password to open it.</p>

  <input
    bind:this={input}
    bind:value={password}
    class="field"
    type="password"
    autocomplete="off"
    placeholder="Password"
    aria-label="Password"
  />

  {#if session.passwordWrong}
    <p class="error">That password didn't work. Try again.</p>
  {/if}

  <footer>
    <button type="button" class="btn outlined" onclick={cancel}>Cancel</button>
    <button type="submit" class="btn primary" disabled={password.length === 0}>Open</button>
  </footer>
</form>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgb(8 10 14 / 45%);
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(400px, calc(100vw - 32px));
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

  .error {
    color: var(--danger);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>
