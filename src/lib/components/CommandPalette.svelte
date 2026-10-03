<script lang="ts">
  /**
   * Command Palette (Cmd+K / Ctrl+K) for rapid power-user access to all actions and tools.
   */
  import { onMount } from "svelte";
  import { session } from "$lib/state/session.svelte";
  import { updater } from "$lib/state/updater.svelte";
  import { viewer, type Tool, type ReadingMode, type PageLayout } from "$lib/state/viewer.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  let searchInput: HTMLInputElement | undefined = $state();
  let query = $state("");
  let selectedIndex = $state(0);
  let listEl: HTMLDivElement | undefined = $state();

  const tab = $derived(workspace.active);
  const totalPages = $derived(tab?.edits.pages.length ?? 0);

  interface CommandItem {
    id: string;
    title: string;
    category: "Tools" | "Document" | "View" | "Panels" | "Edit" | "Navigation" | "App";
    shortcut?: string;
    icon: IconName;
    action: () => void;
  }

  const baseCommands = $derived.by<CommandItem[]>(() => {
    const list: CommandItem[] = [];

    // Tools
    const toolList: { tool: Tool; title: string; key?: string; icon: IconName }[] = [
      { tool: "select", title: "Select Tool", key: "V", icon: "cursor" },
      { tool: "pan", title: "Hand / Pan Tool", key: "H", icon: "hand" },
      { tool: "text", title: "Select Text Tool", key: "T", icon: "text" },
      { tool: "highlight", title: "Highlight Tool", key: "1", icon: "highlight" },
      { tool: "underline", title: "Underline Tool", key: "2", icon: "underline" },
      { tool: "strikeout", title: "Strikeout Tool", key: "3", icon: "strikeout" },
      { tool: "squiggly", title: "Squiggly Underline Tool", key: "4", icon: "squiggly" },
      { tool: "ink", title: "Freehand Pen Tool", key: "P", icon: "pen" },
      { tool: "eraser", title: "Eraser Tool", key: "E", icon: "eraser" },
      { tool: "square", title: "Rectangle Shape Tool", key: "R", icon: "square" },
      { tool: "circle", title: "Ellipse Shape Tool", key: "O", icon: "circle" },
      { tool: "line", title: "Line Shape Tool", key: "L", icon: "line" },
      { tool: "arrow", title: "Arrow Shape Tool", key: "A", icon: "arrow" },
      { tool: "freetext", title: "Text Box Tool", key: "X", icon: "textbox" },
      { tool: "note", title: "Sticky Note / Comment Tool", key: "N", icon: "note" },
      { tool: "measure", title: "Measurement / Caliper Tool", icon: "ruler" },
    ];

    for (const t of toolList) {
      list.push({
        id: `tool-${t.tool}`,
        title: t.title,
        category: "Tools",
        shortcut: t.key,
        icon: t.icon,
        action: () => viewer.setTool(t.tool),
      });
    }

    // Document operations
    list.push(
      {
        id: "doc-open",
        title: "Open PDF…",
        category: "Document",
        shortcut: "⌘O",
        icon: "open",
        action: () => void session.openViaDialog(),
      },
      {
        id: "doc-save",
        title: "Save PDF",
        category: "Document",
        shortcut: "⌘S",
        icon: "save",
        action: () => void session.save(),
      },
      {
        id: "doc-save-as",
        title: "Save As…",
        category: "Document",
        shortcut: "⇧⌘S",
        icon: "save-as",
        action: () => void session.saveAs(),
      },
      {
        id: "doc-save-flattened",
        title: "Save Flattened PDF (Redact/Flatten All)",
        category: "Document",
        shortcut: "⌥⌘S",
        icon: "save-flattened",
        action: () => void session.saveFlattened(),
      },
      {
        id: "doc-print",
        title: "Print PDF…",
        category: "Document",
        shortcut: "⌘P",
        icon: "print",
        action: () => void session.print(),
      },
      {
        id: "doc-merge",
        title: "Merge PDFs…",
        category: "Document",
        icon: "merge",
        action: () => session.openMergeDialog(),
      },
      {
        id: "doc-optimize",
        title: "Optimize / Compress PDF…",
        category: "Document",
        shortcut: "⌥⌘O",
        icon: "optimize",
        action: () => session.openOptimizeDialog(),
      },
      {
        id: "doc-split",
        title: "Split & Extract Pages…",
        category: "Document",
        icon: "scissors",
        action: () => session.openSplitDialog(),
      },
      {
        id: "doc-watermark",
        title: "Add Watermark…",
        category: "Document",
        icon: "watermark",
        action: () => session.openWatermarkDialog(),
      },
      {
        id: "doc-headers-footers",
        title: "Add Headers, Footers & Bates Numbers…",
        category: "Document",
        icon: "header-footer",
        action: () => session.openHeaderFooterDialog(),
      },
      {
        id: "doc-blank-page",
        title: "Insert Blank Page",
        category: "Document",
        icon: "plus",
        action: () => {
          if (tab) session.addBlankPage(tab.insertAt);
        },
      },
    );

    // View & Layout
    const layouts: { mode: PageLayout; title: string; icon: IconName }[] = [
      { mode: "single", title: "Single Page View", icon: "file" },
      { mode: "two-page", title: "Two-Page Spread View", icon: "two-page" },
      { mode: "two-page-cover", title: "Book View (Two Pages with Cover)", icon: "two-page" },
    ];
    for (const l of layouts) {
      list.push({
        id: `layout-${l.mode}`,
        title: l.title,
        category: "View",
        icon: l.icon,
        action: () => (viewer.pageLayout = l.mode),
      });
    }

    const readingModes: { mode: ReadingMode; title: string; icon: IconName }[] = [
      { mode: "default", title: "Normal Reading Mode", icon: "reading-mode" },
      { mode: "dark", title: "Dark Reading Mode (Invert Luminance)", icon: "reading-mode" },
      { mode: "sepia", title: "Sepia Warm Reading Mode", icon: "reading-mode" },
      { mode: "invert", title: "Inverted High-Contrast Mode", icon: "reading-mode" },
    ];
    for (const rm of readingModes) {
      list.push({
        id: `reading-${rm.mode}`,
        title: rm.title,
        category: "View",
        icon: rm.icon,
        action: () => (viewer.readingMode = rm.mode),
      });
    }

    list.push(
      {
        id: "view-presentation",
        title: "Presentation Mode (Distraction-Free Fullscreen)",
        category: "View",
        shortcut: "F5",
        icon: "presentation",
        action: () => (viewer.presentationMode = !viewer.presentationMode),
      },
      {
        id: "view-zoom-in",
        title: "Zoom In",
        category: "View",
        shortcut: "⌘+",
        icon: "zoom-in",
        action: () => tab?.view.zoomBy(1),
      },
      {
        id: "view-zoom-out",
        title: "Zoom Out",
        category: "View",
        shortcut: "⌘-",
        icon: "zoom-out",
        action: () => tab?.view.zoomBy(-1),
      },
      {
        id: "view-fit-width",
        title: "Zoom to Fit Width",
        category: "View",
        icon: "fit-width",
        action: () => tab?.view.zoomTo("fit-width"),
      },
      {
        id: "view-fit-page",
        title: "Zoom to Fit Page",
        category: "View",
        shortcut: "⌘0",
        icon: "fit-page",
        action: () => tab?.view.zoomTo("fit-page"),
      },
    );

    // Panels
    list.push(
      {
        id: "panel-sidebar",
        title: "Toggle Sidebar",
        category: "Panels",
        shortcut: "⌘\\",
        icon: "sidebar",
        action: () => (viewer.sidebarOpen = !viewer.sidebarOpen),
      },
      {
        id: "panel-thumbnails",
        title: "Show Page Thumbnails Panel",
        category: "Panels",
        icon: "thumbnails",
        action: () => {
          viewer.sidebarOpen = true;
          viewer.sidebarTab = "thumbnails";
        },
      },
      {
        id: "panel-annotations",
        title: "Show Annotations Panel",
        category: "Panels",
        icon: "list",
        action: () => {
          viewer.sidebarOpen = true;
          viewer.sidebarTab = "annotations";
        },
      },
      {
        id: "panel-outline",
        title: "Show Bookmarks / Document Outline Panel",
        category: "Panels",
        icon: "outline",
        action: () => {
          viewer.sidebarOpen = true;
          viewer.sidebarTab = "outline";
        },
      },
      {
        id: "panel-search",
        title: "Find in Document Panel",
        category: "Panels",
        shortcut: "⌘F",
        icon: "search",
        action: () => {
          viewer.sidebarOpen = true;
          viewer.sidebarTab = "search";
        },
      },
      {
        id: "panel-inspector",
        title: "Toggle Inspector Panel",
        category: "Panels",
        icon: "inspector",
        action: () => (viewer.inspectorOpen = !viewer.inspectorOpen),
      },
    );

    // Edit
    list.push(
      {
        id: "edit-undo",
        title: "Undo",
        category: "Edit",
        shortcut: "⌘Z",
        icon: "undo",
        action: () => tab?.edits.undo(),
      },
      {
        id: "edit-redo",
        title: "Redo",
        category: "Edit",
        shortcut: "⇧⌘Z",
        icon: "redo",
        action: () => tab?.edits.redo(),
      },
    );

    // Alignment
    const alignments: { dir: "left" | "center" | "right" | "top" | "middle" | "bottom"; title: string; icon: IconName }[] = [
      { dir: "left", title: "Align Left", icon: "align-left" },
      { dir: "center", title: "Align Center (Horizontal)", icon: "align-center" },
      { dir: "right", title: "Align Right", icon: "align-right" },
      { dir: "top", title: "Align Top", icon: "align-top" },
      { dir: "middle", title: "Align Middle (Vertical)", icon: "align-middle" },
      { dir: "bottom", title: "Align Bottom", icon: "align-bottom" },
    ];
    for (const a of alignments) {
      list.push({
        id: `align-${a.dir}`,
        title: `Align Selected Annotations: ${a.title}`,
        category: "Edit",
        icon: a.icon,
        action: () => {
          if (tab?.edits.selectedId) {
            tab.edits.alignSelected(a.dir);
          }
        },
      });
    }

    // App & Help
    list.push(
      {
        id: "app-settings",
        title: "Preferences / Settings…",
        category: "App",
        shortcut: "⌘,",
        icon: "command",
        action: () => session.openSettings(),
      },
      {
        id: "app-updates",
        title: "Check for Updates…",
        category: "App",
        icon: "front",
        action: () => void updater.checkForUpdates({ manual: true }),
      },
    );

    return list;
  });

  // Check if query is jump to page (e.g. "5", "p5", "page 12", ":4")
  const pageJumpMatch = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const match = q.match(/^(?:p|page|:)?\s*(\d+)$/);
    if (!match) return null;
    const pageNum = Number.parseInt(match[1], 10);
    if (pageNum >= 1 && pageNum <= totalPages) return pageNum;
    return null;
  });

  const filteredCommands = $derived.by<CommandItem[]>(() => {
    const q = query.trim().toLowerCase();
    const results: CommandItem[] = [];

    if (pageJumpMatch !== null && tab) {
      const targetPage = pageJumpMatch;
      results.push({
        id: `jump-page-${targetPage}`,
        title: `Jump to Page ${targetPage} of ${totalPages}`,
        category: "Navigation",
        icon: "file",
        action: () => tab.view.goToPage(targetPage - 1),
      });
    }

    if (!q) return [...results, ...baseCommands];

    const terms = q.split(/\s+/).filter(Boolean);
    for (const cmd of baseCommands) {
      const str = `${cmd.title} ${cmd.category} ${cmd.shortcut ?? ""}`.toLowerCase();
      if (terms.every((t) => str.includes(t))) {
        results.push(cmd);
      }
    }
    return results;
  });

  $effect(() => {
    // Reset selection index when filter changes
    void filteredCommands;
    selectedIndex = 0;
  });

  onMount(() => {
    searchInput?.focus();
  });

  function execute(cmd: CommandItem) {
    session.closeCommandPalette();
    cmd.action();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeCommandPalette();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredCommands.length > 0) {
        selectedIndex = (selectedIndex + 1) % filteredCommands.length;
        scrollIntoView();
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredCommands.length > 0) {
        selectedIndex = (selectedIndex - 1 + filteredCommands.length) % filteredCommands.length;
        scrollIntoView();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const target = filteredCommands[selectedIndex];
      if (target) execute(target);
      return;
    }
  }

  function scrollIntoView() {
    const el = listEl?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" onclick={() => session.closeCommandPalette()} role="presentation"></div>

<div class="palette" role="dialog" aria-modal="true" aria-label="Command Palette">
  <div class="search-header">
    <Icon name="search" size={18} />
    <input
      bind:this={searchInput}
      type="text"
      class="search-input"
      placeholder="Type a command, tool, or page number (e.g. 'highlight', 'dark', 'p5')…"
      bind:value={query}
    />
    <button class="close-btn" onclick={() => session.closeCommandPalette()} title="Close">
      <kbd>Esc</kbd>
    </button>
  </div>

  <div class="results-list" bind:this={listEl}>
    {#if filteredCommands.length === 0}
      <div class="empty-state">No matching commands found.</div>
    {:else}
      {#each filteredCommands as cmd, idx (cmd.id)}
        <button
          class="cmd-item"
          class:selected={idx === selectedIndex}
          onclick={() => execute(cmd)}
          onmouseenter={() => (selectedIndex = idx)}
        >
          <div class="icon-wrap">
            <Icon name={cmd.icon} size={16} />
          </div>
          <span class="cmd-title">{cmd.title}</span>
          <span class="cmd-cat">{cmd.category}</span>
          {#if cmd.shortcut}
            <kbd class="cmd-kbd">{cmd.shortcut}</kbd>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    z-index: 90;
  }

  .palette {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 600px;
    max-width: 92vw;
    background: var(--surface-float);
    color: var(--text);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-3);
    z-index: 91;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    font-size: 15px;
    color: var(--text);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--text-muted);
    font-size: 14px;
  }

  .close-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  kbd {
    display: inline-block;
    padding: 2px 6px;
    font-size: 11px;
    font-family: inherit;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
  }

  .results-list {
    max-height: 380px;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .empty-state {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .cmd-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }

  .cmd-item.selected {
    background: var(--bg-hover);
    color: var(--text);
  }

  .icon-wrap {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--text-muted);
  }

  .cmd-item.selected .icon-wrap {
    color: var(--accent);
  }

  .cmd-title {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
  }

  .cmd-cat {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-sunken);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .cmd-kbd {
    font-size: 11px;
  }
</style>
