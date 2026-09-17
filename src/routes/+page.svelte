<script lang="ts">
  /** App shell: toolbar, sidebar, viewer, inspector, plus global wiring. */
  import { onMount } from "svelte";

  import Inspector from "$lib/components/Inspector.svelte";
  import PasswordDialog from "$lib/components/PasswordDialog.svelte";
  import SignaturePad from "$lib/components/SignaturePad.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import Viewer from "$lib/components/Viewer.svelte";
  import Welcome from "$lib/components/Welcome.svelte";
  import { handleShortcut } from "$lib/shortcuts";
  import { doc } from "$lib/state/doc.svelte";
  import { edits } from "$lib/state/edits.svelte";
  import { images } from "$lib/state/images.svelte";
  import { session } from "$lib/state/session.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import { cliFile, onExternalOpen } from "$lib/tauri/files";

  let signaturePadOpen = $state(false);

  onMount(() => {
    void images.loadSignatures();

    // A file association or `open -a` hands us a path on argv.
    void cliFile()
      .then((path) => {
        if (path) return session.openPath(path);
      })
      .catch(() => {
        // Not fatal: the welcome screen is a fine place to land.
      });

    // Finder "Open With" and drag-and-drop both arrive after startup.
    const unlisten = onExternalOpen(([first]) => {
      if (first) void session.openPath(first);
    });

    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  });

  const title = $derived(
    doc.isOpen ? `${edits.dirty ? "• " : ""}${doc.name} — PDF Editor` : "PDF Editor",
  );

  // Keep the window title in step with the document and its dirty state.
  $effect(() => {
    document.title = title;
  });

  /**
   * Warn before losing unsaved work. `beforeunload` covers the webview reload
   * path; a native close still needs Tauri's own close handler to be added if
   * that becomes a concern.
   */
  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (!edits.dirty) return;
    event.preventDefault();
  }
</script>

<svelte:window onkeydown={handleShortcut} onbeforeunload={onBeforeUnload} />

<div class="app">
  <Toolbar onDrawSignature={() => (signaturePadOpen = true)} />

  <div class="body">
    {#if doc.isOpen}
      {#if viewer.sidebarOpen}
        <Sidebar />
      {/if}
      <Viewer />
      {#if viewer.inspectorOpen}
        <Inspector />
      {/if}
    {:else}
      <Welcome />
    {/if}
  </div>

  {#if session.busy}
    <div class="busy" role="status">{session.busy}</div>
  {/if}
</div>

{#if signaturePadOpen}
  <SignaturePad onClose={() => (signaturePadOpen = false)} />
{/if}

{#if session.passwordFor}
  <PasswordDialog />
{/if}

<Toasts />

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .busy {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 45;
    padding: 9px 18px;
    transform: translate(-50%, -50%);
    border-radius: 99px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-3);
  }
</style>
