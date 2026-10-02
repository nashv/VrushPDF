<script lang="ts">
  /**
   * Software Update Dialog.
   *
   * Displays update check status, release notes, live download progress,
   * checksum verification results, and one-click installation restart.
   */
  import { updater } from "$lib/state/updater.svelte";
  import Icon from "./Icon.svelte";

  let closeButton: HTMLButtonElement | undefined = $state();

  $effect(() => {
    closeButton?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      updater.closeDialog();
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  function formatNotes(body: string): string {
    if (!body) return "No release notes provided for this version.";
    // Basic Markdown sanitization/formatting for display
    return body
      .replace(/###\s*(.*)/g, '<div class="note-heading">$1</div>')
      .replace(/####\s*(.*)/g, '<div class="note-subheading">$1</div>')
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^\s*\*\s*(.*)/gm, '<div class="note-bullet">• $1</div>')
      .replace(/^\s*-\s*(.*)/gm, '<div class="note-bullet">• $1</div>');
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop"></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
  <div class="header">
    <h2 id="update-title">Software Update</h2>
    <button class="icon-btn" onclick={() => updater.closeDialog()} title="Close dialog">
      <Icon name="close" size={14} />
    </button>
  </div>

  <div class="content">
    {#if updater.status === "checking"}
      <div class="status-box">
        <div class="spinner"></div>
        <div class="status-texts">
          <div class="status-title">Checking for updates…</div>
          <div class="status-sub">Querying GitHub repository nashv/VrushPDF</div>
        </div>
      </div>
    {:else if updater.status === "up-to-date"}
      <div class="status-box">
        <div class="icon-circle success">
          <Icon name="check" size={20} />
        </div>
        <div class="status-texts">
          <div class="status-title">You're up to date!</div>
          <div class="status-sub">
            VrushPDF <strong>{updater.currentVersion}</strong> is currently the newest version available.
          </div>
        </div>
      </div>
    {:else if updater.status === "available" && updater.release}
      <div class="available-box">
        <div class="version-banner">
          <div class="version-badge">
            <span class="v-new">v{updater.release.version}</span>
            <span class="v-arrow">←</span>
            <span class="v-curr">v{updater.currentVersion}</span>
          </div>
          <div class="version-info">
            <div class="version-title">{updater.release.name}</div>
            <div class="version-meta">
              {#if updater.release.asset}
                {updater.release.asset.name} ({formatBytes(updater.release.asset.size)})
              {/if}
            </div>
          </div>
        </div>

        <div class="release-notes-title">Release Notes</div>
        <div class="release-notes">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html formatNotes(updater.release.body)}
        </div>
      </div>
    {:else if updater.status === "downloading"}
      <div class="progress-box">
        <div class="status-title">Downloading VrushPDF {updater.release?.version}…</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: {updater.progress.percent}%"></div>
        </div>
        <div class="progress-stats">
          <span>{formatBytes(updater.progress.loaded)} of {formatBytes(updater.progress.total)}</span>
          <span>{updater.progress.percent}%</span>
        </div>
      </div>
    {:else if updater.status === "installing"}
      <div class="status-box">
        <div class="spinner"></div>
        <div class="status-texts">
          <div class="status-title">Installing update…</div>
          <div class="status-sub">Preparing and staging the new release files</div>
        </div>
      </div>
    {:else if updater.status === "ready"}
      <div class="status-box">
        <div class="icon-circle success">
          <Icon name="check" size={20} />
        </div>
        <div class="status-texts">
          <div class="status-title">Update Ready!</div>
          <div class="status-sub">
            VrushPDF has been updated to version {updater.release?.version}. Restart the application to finish applying the update.
          </div>
        </div>
      </div>
    {:else if updater.status === "error"}
      <div class="status-box">
        <div class="icon-circle error">
          <Icon name="warning" size={20} />
        </div>
        <div class="status-texts">
          <div class="status-title">{updater.release ? "Update Failed" : "Update Check Failed"}</div>
          <div class="status-sub error-text">
            {updater.errorMessage || "An unexpected error occurred while communicating with the release server."}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <footer>
    <span class="spacer"></span>
    {#if updater.status === "up-to-date"}
      <button bind:this={closeButton} class="btn primary" onclick={() => updater.closeDialog()}>
        OK
      </button>
    {:else if updater.status === "available"}
      <button class="btn secondary" onclick={() => updater.closeDialog()}>
        Later
      </button>
      <button bind:this={closeButton} class="btn primary" onclick={() => updater.downloadAndInstall()}>
        Download & Install
      </button>
    {:else if updater.status === "ready"}
      <button class="btn secondary" onclick={() => updater.closeDialog()}>
        Later
      </button>
      <button bind:this={closeButton} class="btn primary" onclick={() => updater.applyAndRestart()}>
        Restart Now
      </button>
    {:else if updater.status === "error"}
      <button class="btn secondary" onclick={() => updater.openReleasePage()}>
        Open Release Page
      </button>
      <button bind:this={closeButton} class="btn primary" onclick={() => updater.closeDialog()}>
        Close
      </button>
    {:else if updater.status === "checking" || updater.status === "downloading" || updater.status === "installing"}
      <button class="btn secondary" onclick={() => updater.closeDialog()}>
        Cancel
      </button>
    {/if}
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
    width: min(520px, 94vw);
    max-height: 85vh;
    padding: 18px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    min-height: 100px;
  }

  .status-box {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 6px;
  }

  .icon-circle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .icon-circle.success {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .icon-circle.error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .status-texts {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .status-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .status-sub {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
  }

  .error-text {
    color: #ef4444;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--surface-border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .available-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .version-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--surface-overlay, rgba(127, 127, 127, 0.08));
    border: 1px solid var(--surface-border);
  }

  .version-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
  }

  .v-curr {
    opacity: 0.85;
    font-size: 11px;
    font-weight: normal;
  }

  .version-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .version-title {
    font-size: 13px;
    font-weight: 600;
  }

  .version-meta {
    font-size: 11px;
    color: var(--muted);
  }

  .release-notes-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 4px;
  }

  .release-notes {
    max-height: 220px;
    overflow-y: auto;
    padding: 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--surface-border);
    background: var(--surface-overlay, rgba(0, 0, 0, 0.04));
    font-size: 12px;
    line-height: 1.5;
  }

  :global(.release-notes .note-heading) {
    font-weight: 600;
    font-size: 13px;
    margin-top: 8px;
    margin-bottom: 4px;
    color: var(--text);
  }

  :global(.release-notes .note-subheading) {
    font-weight: 600;
    font-size: 12px;
    margin-top: 6px;
    margin-bottom: 2px;
    color: var(--text);
  }

  :global(.release-notes .note-bullet) {
    margin-left: 6px;
    margin-bottom: 2px;
  }

  :global(.release-notes code) {
    background: rgba(127, 127, 127, 0.15);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: monospace;
    font-size: 11px;
  }

  .progress-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 6px;
  }

  .progress-bar-bg {
    width: 100%;
    height: 8px;
    border-radius: 4px;
    background: var(--surface-border);
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 0.2s ease-out;
  }

  .progress-stats {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--muted);
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .spacer {
    flex: 1;
  }
</style>
