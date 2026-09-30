<script lang="ts">
  /**
   * PDF Optimizer Dialog (Adobe Acrobat style).
   *
   * Provides granular controls and presets for image downsampling,
   * object discarding, annotation/form flattening, standard font unembedding,
   * and PDF 1.5+ Object Stream dictionary compression.
   */
  import { auditPdf, DEFAULT_OPTIMIZE_OPTIONS, PRESETS, type OptimizeOptions, type OptimizePreset, type PdfAudit } from "$lib/annotations/optimize";
  import { session } from "$lib/state/session.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon from "./Icon.svelte";

  let activeTab = $state<"images" | "discard" | "fonts" | "cleanup">("images");
  let options = $state<OptimizeOptions>(JSON.parse(JSON.stringify(DEFAULT_OPTIMIZE_OPTIONS)));
  let audit = $state<PdfAudit | null>(null);
  let loadingAudit = $state(false);

  const tab = $derived(workspace.active);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  $effect(() => {
    if (session.optimizeOpen && tab?.isOpen) {
      options = JSON.parse(JSON.stringify(PRESETS.standard));
      const source = tab.doc.source("main");
      if (source) {
        loadingAudit = true;
        void auditPdf(source.bytes)
          .then((res) => {
            audit = res;
          })
          .catch(() => {
            audit = null;
          })
          .finally(() => {
            loadingAudit = false;
          });
      }
    }
  });

  function selectPreset(preset: OptimizePreset) {
    if (preset === "custom") {
      options.preset = "custom";
      return;
    }
    options = JSON.parse(JSON.stringify(PRESETS[preset]));
  }

  function onCustomChange() {
    options.preset = "custom";
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeOptimizeDialog();
    }
  }

  async function handleOptimize() {
    session.closeOptimizeDialog();
    await session.optimize(options);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if session.optimizeOpen}
  <div class="backdrop" onclick={() => session.closeOptimizeDialog()} role="presentation"></div>

  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="optimize-title">
    <header class="dialog-header">
      <div class="title-row">
        <h2 id="optimize-title"><Icon name="optimize" /> PDF Optimizer</h2>
        <button class="btn icon ghost" aria-label="Close" onclick={() => session.closeOptimizeDialog()}>
          ✕
        </button>
      </div>

      <div class="preset-bar">
        <label for="preset-select" class="preset-label">Optimization Preset:</label>
        <select
          id="preset-select"
          class="preset-select"
          value={options.preset}
          onchange={(e) => selectPreset(e.currentTarget.value as OptimizePreset)}
        >
          <option value="standard">Standard (Balanced - 150 DPI)</option>
          <option value="high_compression">Mobile / Web (Maximum Compression - 72 DPI)</option>
          <option value="print">High Quality (Print - 300 DPI)</option>
          <option value="clean_only">Clean & Compact (Discard Junk Only)</option>
          <option value="custom">Custom Settings</option>
        </select>
      </div>

      <div class="stats-banner">
        {#if audit}
          <div class="stat-item">
            <span class="stat-label">File Size:</span>
            <span class="stat-value">{formatBytes(audit.originalSize)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Pages:</span>
            <span class="stat-value">{audit.pageCount}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Images:</span>
            <span class="stat-value">{audit.imageCount} ({formatBytes(audit.totalImageBytes)})</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Fonts:</span>
            <span class="stat-value">{audit.fontCount} ({audit.embeddedFontCount} embedded)</span>
          </div>
        {:else if loadingAudit}
          <div class="stat-placeholder">
            <span class="stat-label">Analyzing document structure & object overhead…</span>
          </div>
        {:else}
          <div class="stat-placeholder">
            <span class="stat-label">Document ready for optimization</span>
          </div>
        {/if}
      </div>
    </header>

    <nav class="tabs-nav" aria-label="Optimizer settings tabs">
      <button
        class="tab-btn"
        class:active={activeTab === "images"}
        onclick={() => (activeTab = "images")}
      >
        Images
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "discard"}
        onclick={() => (activeTab = "discard")}
      >
        Discard Objects
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "fonts"}
        onclick={() => (activeTab = "fonts")}
      >
        Fonts
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "cleanup"}
        onclick={() => (activeTab = "cleanup")}
      >
        Clean Up & Streams
      </button>
    </nav>

    <div class="tab-content">
      {#if activeTab === "images"}
        <div class="panel">
          <div class="panel-section">
            <h3 class="panel-title">Color & Grayscale Image Settings</h3>
            <p class="panel-desc">
              Downsample high-resolution images and re-compress uncompressed raster streams to reduce byte size.
            </p>

            <label class="row master-row">
              <input
                type="checkbox"
                bind:checked={options.images.enabled}
                onchange={onCustomChange}
              />
              <span class="lines">
                <span class="row-title">Enable Image Optimization & Downsampling</span>
                <span class="note muted">Resample raster graphics to target resolution thresholds.</span>
              </span>
            </label>

            <div class="sub-card" class:disabled={!options.images.enabled}>
              <div class="setting-grid">
                <div class="setting-item">
                  <span class="setting-label">Downsample images above:</span>
                  <select
                    class="select-sm"
                    disabled={!options.images.enabled}
                    bind:value={options.images.maxDpi}
                    onchange={onCustomChange}
                  >
                    <option value={100}>100 DPI</option>
                    <option value={150}>150 DPI</option>
                    <option value={225}>225 DPI</option>
                    <option value={300}>300 DPI</option>
                    <option value={450}>450 DPI</option>
                  </select>
                </div>

                <div class="setting-item">
                  <span class="setting-label">Target resolution:</span>
                  <select
                    class="select-sm"
                    disabled={!options.images.enabled}
                    bind:value={options.images.targetDpi}
                    onchange={onCustomChange}
                  >
                    <option value={72}>72 DPI (Screen / Web)</option>
                    <option value={96}>96 DPI (Standard Web)</option>
                    <option value={150}>150 DPI (Office / Reader)</option>
                    <option value={200}>200 DPI (High Detail)</option>
                    <option value={300}>300 DPI (Print Quality)</option>
                  </select>
                </div>
              </div>

              <div class="setting-item full-width">
                <div class="slider-header">
                  <span class="setting-label">JPEG Compression Quality:</span>
                  <span class="slider-val">{Math.round(options.images.jpegQuality * 100)}%</span>
                </div>
                <div class="slider-row">
                  <span class="slider-hint">Smaller file</span>
                  <input
                    type="range"
                    min="0.2"
                    max="0.95"
                    step="0.05"
                    class="slider"
                    disabled={!options.images.enabled}
                    bind:value={options.images.jpegQuality}
                    oninput={onCustomChange}
                  />
                  <span class="slider-hint">Higher quality</span>
                </div>
              </div>

              <div class="sub-checkboxes">
                <label class="row sub-check">
                  <input
                    type="checkbox"
                    disabled={!options.images.enabled}
                    bind:checked={options.images.convertToJpeg}
                    onchange={onCustomChange}
                  />
                  <span class="lines">
                    <span>Re-compress uncompressed / PNG streams to JPEG</span>
                    <span class="note muted">Provides maximum compression ratio for photographic scans and textures.</span>
                  </span>
                </label>

                <label class="row sub-check">
                  <input
                    type="checkbox"
                    disabled={!options.images.enabled}
                    bind:checked={options.images.downsampleMonochrome}
                    onchange={onCustomChange}
                  />
                  <span class="lines">
                    <span>Downsample 1-bit monochrome scanned line drawings</span>
                    <span class="note muted">Downsamples monochrome bitmap drawings to target DPI.</span>
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      {:else if activeTab === "discard"}
        <div class="panel">
          <div class="panel-section">
            <h3 class="panel-title">Flattening & Discarding Document Overhead</h3>
            <p class="panel-desc">
              Discard redundant indirect objects, metadata blocks, and interactive annotations to clean up structure.
            </p>

            <div class="check-grid">
              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.flattenAnnotations}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Flatten annotations into page graphics</span>
                  <span class="note muted">Bakes vector highlights, ink, and stamps directly into the base page streams.</span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.flattenFormFields}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Flatten interactive form fields</span>
                  <span class="note muted">Converts fillable text boxes, checkboxes, and buttons into static text.</span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.discardThumbnails}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Discard embedded page thumbnails (/Thumb)</span>
                  <span class="note muted">Modern PDF viewers dynamically render thumbnails in real-time.</span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.discardMetadata}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Discard XML metadata and private application data</span>
                  <span class="note muted">Strips bloated Photoshop, Illustrator, and vendor editing metadata slices.</span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.discardStructTree}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Discard document accessibility tags (/StructTreeRoot)</span>
                  <span class="note muted">Removes logical structure trees and tagging dictionaries.</span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.discardOutlines}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Discard document bookmarks and outlines</span>
                  <span class="note muted">Removes the table of contents and navigational outline nodes.</span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.discard.discardEmbeddedFiles}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Discard embedded file attachments</span>
                  <span class="note muted">Strips auxiliary file attachments embedded in the PDF catalog.</span>
                </span>
              </label>
            </div>
          </div>
        </div>
      {:else if activeTab === "fonts"}
        <div class="panel">
          <div class="panel-section">
            <h3 class="panel-title">Font Optimization & Unembedding</h3>
            <p class="panel-desc">
              Embedded font descriptors ensure exact typography across devices. For standard fonts,
              removing heavy embedded streams relies on system Helvetica/Times/Courier.
            </p>

            <div class="check-grid">
              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.fonts.unembedStandardFonts}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Unembed Standard 14 Base Fonts</span>
                  <span class="note muted">
                    Strips embedded binary font streams for Helvetica, Times, Courier, and Symbol, saving 50KB–500KB per font descriptor.
                  </span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.fonts.optimizeFontStreams}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Optimize font descriptor tables and charsets</span>
                  <span class="note muted">
                    Removes orphaned glyph metrics, unused TrueType tables, and compacts font dictionary streams.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>
      {:else if activeTab === "cleanup"}
        <div class="panel">
          <div class="panel-section">
            <h3 class="panel-title">Clean Up and Stream Compression</h3>
            <p class="panel-desc">
              Pack document syntax into compressed binary structures and apply Flate encoding across content streams.
            </p>

            <div class="check-grid">
              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.cleanUp.useObjectStreams}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Use PDF 1.5+ Object Streams (/ObjStm)</span>
                  <span class="note muted">
                    Packs thousands of indirect object dictionaries into compressed binary streams, dramatically reducing syntax overhead.
                  </span>
                </span>
              </label>

              <label class="row card-row">
                <input
                  type="checkbox"
                  bind:checked={options.cleanUp.compressStreams}
                  onchange={onCustomChange}
                />
                <span class="lines">
                  <span class="row-title">Apply Flate / Deflate compression to uncompressed content</span>
                  <span class="note muted">
                    Ensures all page drawing commands, form streams, and text content streams are compressed.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <footer class="dialog-footer">
      <button class="btn outlined" onclick={() => session.closeOptimizeDialog()}>
        Cancel
      </button>
      <button class="btn primary" onclick={handleOptimize}>
        <Icon name="optimize" /> Optimize PDF…
      </button>
    </footer>
  </div>
{/if}

<style>
  /* Outer Dialog */
  .dialog {
    width: min(650px, calc(100vw - 32px));
    height: min(580px, calc(100vh - 48px));
    overflow: hidden;
  }

  /* Header */
  .dialog-header {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
    flex-shrink: 0;
  }

  :global([data-glass]) .dialog-header {
    background: transparent;
    border-bottom: 1px solid var(--glass-stroke);
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .preset-bar {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .preset-label {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }

  .preset-select {
    flex: 1;
    height: 30px;
    padding: 0 10px;
    font-size: 13px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: inherit;
    font-family: inherit;
  }

  :global([data-glass]) .preset-select {
    background: var(--glass-fill);
    border: 1px solid var(--glass-stroke);
    box-shadow: var(--glass-edge);
    border-radius: var(--radius);
  }

  :global([data-platform="win"]) .preset-select {
    border-radius: 4px;
    background: var(--bg-raised);
  }

  :global([data-platform="gnome"]) .preset-select {
    border-radius: 6px;
    height: 32px;
  }

  :global([data-platform="kde"]) .preset-select {
    border-radius: 3px;
    height: 28px;
  }

  .stats-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    min-height: 28px;
    padding: 5px 12px;
    background: var(--bg-hover);
    border-radius: var(--radius);
    font-size: 12px;
  }

  :global([data-glass]) .stats-banner {
    background: var(--glass-track);
    border-radius: 999px;
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 6%);
    padding: 6px 14px;
  }

  .stat-item {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .stat-placeholder {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    font-style: italic;
  }

  .stat-label {
    opacity: 0.75;
  }

  .stat-value {
    font-weight: 600;
  }

  /* Navigation Tabs */
  .tabs-nav {
    display: flex;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .tab-btn {
    flex: 1;
    padding: 9px 12px;
    font-size: 12.5px;
    font-weight: 500;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.75;
    transition: all 0.15s ease;
    text-align: center;
    white-space: nowrap;
    font-family: inherit;
  }

  .tab-btn:hover {
    opacity: 1;
    background: var(--bg-hover);
  }

  .tab-btn.active {
    opacity: 1;
    font-weight: 600;
    border-bottom-color: var(--accent);
    background: var(--bg-raised);
  }

  /* macOS LiquidGlass Segmented Control Tabs */
  :global([data-glass]) .tabs-nav {
    background: var(--glass-track);
    border-radius: 999px;
    border: none;
    padding: 3px;
    margin: 8px 20px 4px;
    gap: 2px;
  }

  :global([data-glass]) .tab-btn {
    border-radius: 999px;
    border: none;
    border-bottom: none;
    padding: 5px 12px;
    font-size: 12px;
    opacity: 0.8;
  }

  :global([data-glass]) .tab-btn:hover {
    background: var(--bg-hover);
    opacity: 1;
  }

  :global([data-glass]) .tab-btn.active {
    background: var(--glass-fill);
    box-shadow: var(--glass-edge), var(--glass-lift);
    border-bottom: none;
    opacity: 1;
    color: var(--text);
  }

  /* Windows Fluent Pivot Tabs */
  :global([data-platform="win"]) .tabs-nav {
    background: transparent;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    margin: 0;
  }

  :global([data-platform="win"]) .tab-btn {
    border-radius: 4px 4px 0 0;
    padding: 8px 16px;
    font-size: 13px;
    border-bottom: 2px solid transparent;
  }

  :global([data-platform="win"]) .tab-btn.active {
    background: transparent;
    border-bottom-color: var(--accent);
    color: var(--accent);
  }

  /* GNOME Adwaita Segmented Tabs */
  :global([data-platform="gnome"]) .tabs-nav,
  :global([data-platform="linux"]) .tabs-nav {
    background: var(--bg-sunken);
    border-radius: 8px;
    border: none;
    padding: 3px;
    margin: 8px 20px 4px;
    gap: 2px;
  }

  :global([data-platform="gnome"]) .tab-btn,
  :global([data-platform="linux"]) .tab-btn {
    border-radius: 6px;
    border: none;
    padding: 6px 12px;
    font-size: 13px;
  }

  :global([data-platform="gnome"]) .tab-btn.active,
  :global([data-platform="linux"]) .tab-btn.active {
    background: var(--bg-raised);
    box-shadow: 0 1px 3px rgb(0 0 0 / 12%);
    border-bottom: none;
    color: var(--text);
  }

  /* KDE Breeze Tab Bar */
  :global([data-platform="kde"]) .tabs-nav {
    background: var(--bg-sunken);
    border-bottom: 1px solid var(--border);
    padding: 0 10px;
    margin: 0;
  }

  :global([data-platform="kde"]) .tab-btn {
    border-radius: 3px 3px 0 0;
    border: 1px solid transparent;
    border-bottom: none;
    padding: 6px 14px;
    font-size: 12.5px;
  }

  :global([data-platform="kde"]) .tab-btn.active {
    background: var(--bg-raised);
    border-color: var(--border);
    border-top: 2px solid var(--accent);
    color: var(--text);
  }

  /* Tab Content and Cards */
  .tab-content {
    flex: 1;
    min-height: 0;
    padding: 16px 20px;
    overflow-y: auto;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .panel-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .panel-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .panel-desc {
    margin: 0 0 4px 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }

  .row input[type="checkbox"] {
    margin-top: 2px;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .master-row {
    padding: 10px 12px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  :global([data-glass]) .master-row {
    background: var(--glass-fill);
    border: 1px solid var(--glass-stroke);
    box-shadow: var(--glass-edge);
    border-radius: var(--radius);
  }

  :global([data-platform="win"]) .master-row {
    border-radius: 4px;
    background: var(--bg-raised);
  }

  :global([data-platform="gnome"]) .master-row {
    border-radius: 8px;
    background: var(--bg-raised);
  }

  :global([data-platform="kde"]) .master-row {
    border-radius: 3px;
    background: var(--bg-raised);
  }

  .row-title {
    font-weight: 500;
  }

  .sub-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px;
    margin-top: 4px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: opacity 0.15s ease;
  }

  :global([data-glass]) .sub-card {
    background: var(--glass-fill);
    border: 1px solid var(--glass-stroke);
    box-shadow: var(--glass-edge);
    border-radius: var(--radius);
  }

  :global([data-platform="win"]) .sub-card {
    border-radius: 4px;
    background: var(--bg-raised);
  }

  :global([data-platform="gnome"]) .sub-card {
    border-radius: 8px;
    background: var(--bg-raised);
  }

  :global([data-platform="kde"]) .sub-card {
    border-radius: 3px;
    background: var(--bg-raised);
  }

  .sub-card.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .setting-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .setting-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
  }

  .setting-item.full-width {
    grid-column: 1 / -1;
  }

  .setting-label {
    font-weight: 500;
    font-size: 12.5px;
  }

  .select-sm {
    height: 28px;
    padding: 0 8px;
    font-size: 12.5px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: inherit;
    font-family: inherit;
  }

  :global([data-glass]) .select-sm {
    background: var(--glass-fill);
    border: 1px solid var(--glass-stroke);
    box-shadow: var(--glass-edge);
    border-radius: var(--radius);
  }

  :global([data-platform="win"]) .select-sm {
    border-radius: 4px;
  }

  :global([data-platform="gnome"]) .select-sm {
    border-radius: 6px;
    height: 30px;
  }

  :global([data-platform="kde"]) .select-sm {
    border-radius: 3px;
    height: 26px;
  }

  .slider-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .slider-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .slider {
    flex: 1;
    height: 6px;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .slider-val {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
  }

  .slider-hint {
    font-size: 11px;
    opacity: 0.65;
    white-space: nowrap;
  }

  .sub-checkboxes {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  :global([data-glass]) .sub-checkboxes {
    border-top-color: var(--glass-stroke);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
  }

  .note {
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--text-muted);
  }

  .check-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .card-row {
    padding: 9px 12px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: background 0.15s ease;
  }

  .card-row:hover {
    background: var(--bg-active);
  }

  :global([data-glass]) .card-row {
    background: var(--glass-fill);
    border: 1px solid var(--glass-stroke);
    box-shadow: var(--glass-edge);
    border-radius: var(--radius);
  }

  :global([data-glass]) .card-row:hover {
    background: linear-gradient(var(--bg-hover), var(--bg-hover)), var(--glass-fill);
  }

  :global([data-platform="win"]) .card-row {
    border-radius: 4px;
    background: var(--bg-raised);
  }

  :global([data-platform="gnome"]) .card-row {
    border-radius: 8px;
    background: var(--bg-raised);
  }

  :global([data-platform="kde"]) .card-row {
    border-radius: 3px;
    background: var(--bg-raised);
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
    flex-shrink: 0;
  }

  :global([data-glass]) .dialog-footer {
    background: transparent;
    border-top: 1px solid var(--glass-stroke);
  }

  :global([data-platform="win"]) .dialog-footer {
    background: var(--bg-sunken);
  }
</style>
