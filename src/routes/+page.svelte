<script lang="ts">
  /** App shell: tab strip, toolbar, sidebar, viewer, inspector, global wiring. */
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import Inspector from "$lib/components/Inspector.svelte";
  import LicenseDialog from "$lib/components/LicenseDialog.svelte";
  import MergeDialog from "$lib/components/MergeDialog.svelte";
  import OptimizeDialog from "$lib/components/OptimizeDialog.svelte";
  import PasswordDialog from "$lib/components/PasswordDialog.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import SignatureWarningDialog from "$lib/components/SignatureWarningDialog.svelte";
  import UpdateDialog from "$lib/components/UpdateDialog.svelte";
  import Resizer from "$lib/components/Resizer.svelte";
  import SignaturePad from "$lib/components/SignaturePad.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import Viewer from "$lib/components/Viewer.svelte";
  import Welcome from "$lib/components/Welcome.svelte";
  import { installAppMenu } from "$lib/menu/appMenu.svelte";
  import { hasGlass } from "$lib/platform";
  import { handleShortcut } from "$lib/shortcuts";
  import { images } from "$lib/state/images.svelte";
  import { license } from "$lib/state/license.svelte";
  import { recents } from "$lib/state/recents.svelte";
  import { session } from "$lib/state/session.svelte";
  import { settings } from "$lib/state/settings.svelte";
  import { updater } from "$lib/state/updater.svelte";
  import { viewer } from "$lib/state/viewer.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import { cliFile, onExternalOpen } from "$lib/tauri/files";

  let signaturePadOpen = $state(false);

  const tab = $derived(workspace.active);
  /** True once a document is loaded; an empty tab still shows the welcome screen. */
  const hasDocument = $derived(tab?.isOpen === true);

  onMount(() => {
    void images.loadSignatures();
    void images.loadStandard();
    void recents.refresh();
    void settings.load().then(() => {
      // Auto-check for updates after launch if enabled
      setTimeout(() => {
        void updater.checkForUpdates({ manual: false });
      }, 3000);
    });
    void license.load();

    // The native menu bar: macOS gets it app-wide, Windows and Linux in-window.
    const menu = installAppMenu({ onDrawSignature: () => (signaturePadOpen = true) });

    // Start with one empty tab so the welcome screen has somewhere to open into.
    if (workspace.count === 0) workspace.open();

    // A file association or `open -a` hands us a path on argv.
    void cliFile()
      .then((path) => {
        if (path) return session.openPath(path);
      })
      .catch(() => {
        // Not fatal: the welcome screen is a fine place to land.
      });

    // Finder "Open With" and drag-and-drop can both deliver several files.
    const unlisten = onExternalOpen((paths) => {
      void session.openPaths(paths);
    });

    // Intercept the window close so dirty documents get a chance to be saved.
    const closeGuard = getCurrentWindow().onCloseRequested(async (event) => {
      if (!workspace.anyDirty) return;
      event.preventDefault();
      void session.requestQuit();
    });

    // Under glass the toolbar leaves room for the traffic lights, which leave
    // the window in full screen. Entering and leaving it both resize.
    const fullscreenWatch = hasGlass ? watchFullscreen() : Promise.resolve(() => {});

    return () => {
      void fullscreenWatch.then((off) => off()).catch(() => {});
      void unlisten.then((off) => off()).catch(() => {});
      void closeGuard.then((off) => off()).catch(() => {});
      void menu.then((dispose) => dispose()).catch(() => {});
    };
  });

  function watchFullscreen() {
    const win = getCurrentWindow();
    const sync = () =>
      win
        .isFullscreen()
        .then((on) => document.documentElement.toggleAttribute("data-fullscreen", on))
        .catch(() => {});
    void sync();
    return win.onResized(sync);
  }

  const title = $derived(
    tab && hasDocument ? `${tab.dirty ? "• " : ""}${tab.title} — VrushPDF` : "VrushPDF",
  );

  // Keep the window title in step with the active document and its dirty state.
  $effect(() => {
    // `document.title` is what a browser tab shows under `vite dev`; it has no
    // bearing on a Tauri window, whose title bar has to be set explicitly.
    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {
        // No window to title when the frontend runs outside Tauri.
      });
  });
</script>

<svelte:window onkeydown={handleShortcut} />

<div class="app">
  <Toolbar {tab} onDrawSignature={() => (signaturePadOpen = true)} />

  <!--
    Below the toolbar, above the content: where AppKit puts a window's tab bar,
    and where Finder, Preview, Terminal and Xcode all show theirs. Tabs above
    the toolbar is the browser convention, which this is not.
  -->
  {#if workspace.count > 1 || hasDocument}
    <TabBar />
  {/if}

  <div class="body">
    {#if tab && hasDocument}
      <!--
        Keyed on the tab so switching documents remounts the viewer rather than
        reconciling one document's canvases and text layers into another's.
        Scroll position is restored from `tab.view.scrollTop`.
      -->
      {#key tab.id}
        {#if viewer.sidebarOpen}
          <Sidebar {tab} />
          <Resizer panel="sidebar" side="left" label="Resize sidebar" />
        {/if}
        <Viewer {tab} />
        {#if viewer.inspectorOpen}
          <Resizer panel="inspector" side="right" label="Resize properties panel" />
          <Inspector {tab} />
        {/if}
      {/key}
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

{#if session.mergeOpen}
  <MergeDialog />
{/if}

{#if session.optimizeOpen}
  <OptimizeDialog />
{/if}

{#if session.settingsOpen}
  <SettingsDialog />
{/if}

{#if license.dialogOpen}
  <LicenseDialog />
{/if}

{#if updater.dialogOpen}
  <UpdateDialog />
{/if}

<ConfirmDialog />
<SignatureWarningDialog />
<Toasts />

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }

  /* Liquid Glass (macOS): the panes float, inset from the window edge. The
     resizers are the gutters between them. */
  :global([data-glass]) .body {
    padding: 0 var(--pane-gap) var(--pane-gap);
  }

  .busy {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 45;
    padding: 9px 18px;
    transform: translate(-50%, -50%);
    border-radius: 99px;
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    border: 1px solid var(--surface-float-border);
    box-shadow: var(--shadow-3);
  }
</style>
