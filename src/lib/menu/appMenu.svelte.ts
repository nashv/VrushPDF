/**
 * The native application menu.
 *
 * Built from the frontend rather than from Rust: every action here already
 * exists as a method on one of the stores, so the menu can call it directly and
 * read the same state for its enabled/checked marks. A Rust-side menu would
 * need an event round-trip per click and a command per state change to arrive
 * at exactly the same place.
 *
 * On macOS this becomes the global menu bar; on Windows and Linux it is the
 * window's own menu strip. `core:default` already grants `core:menu:default`,
 * so no extra capability is needed.
 *
 * Two rules shape the accelerators:
 *
 *  - A native accelerator is swallowed before the webview sees the key, so
 *    nothing here may be bound to a bare key — `Delete`, `PageDown` or a plain
 *    `N` on a menu item would break typing in a comment or a text box. Those
 *    stay in `shortcuts.ts`, which guards on focus.
 *  - Anything that *is* bound here is removed from `shortcuts.ts`' reach (see
 *    `nativeMenuActive`), so a keystroke can never fire an action twice.
 */
import { getVersion } from "@tauri-apps/api/app";
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";

import { isMac } from "$lib/platform";
import { license } from "$lib/state/license.svelte";
import { recents } from "$lib/state/recents.svelte";
import { session } from "$lib/state/session.svelte";
import { viewer, type SidebarTab, type Tool } from "$lib/state/viewer.svelte";
import { workspace } from "$lib/state/workspace.svelte";


/**
 * True once the OS owns the accelerators. `shortcuts.ts` checks this before
 * handling any ⌘/Ctrl combination, so the browser-only dev server keeps its
 * shortcuts while the packaged app has no double-firing.
 */
let installed = false;
export const nativeMenuActive = () => installed;

// ---------------------------------------------------------------- the spec

type Native = PredefinedMenuItemOptions["item"];

/** An item whose text/enabled/checked state is pushed from app state. */
interface Dynamic {
  id: string;
  label: string;
  accelerator?: string;
  action: () => void;
  enabled?: () => boolean;
  /** Dynamic label; re-applied whenever it changes. */
  text?: () => string;
}

type Spec =
  | { kind: "sep" }
  | { kind: "native"; item: Native; label?: string }
  | { kind: "item"; spec: Dynamic }
  | { kind: "check"; spec: Dynamic & { checked: () => boolean } }
  | { kind: "menu"; label: string; items: Spec[] }
  | { kind: "built"; item: Submenu };

const sep: Spec = { kind: "sep" };
const item = (spec: Dynamic): Spec => ({ kind: "item", spec });
const check = (spec: Dynamic & { checked: () => boolean }): Spec => ({ kind: "check", spec });

// ------------------------------------------------------------- state readers

const tab = () => workspace.active;
const hasDoc = () => workspace.active?.isOpen === true;
const pageCount = () => tab()?.edits.pages.length ?? 0;

/** Tools in the order the toolbar shows them, grouped the same way. */
const TOOL_GROUPS: { tool: Tool; label: string }[][] = [
  [
    { tool: "select", label: "Select" },
    { tool: "pan", label: "Pan" },
    { tool: "text", label: "Select Text" },
  ],
  [
    { tool: "highlight", label: "Highlight" },
    { tool: "underline", label: "Underline" },
    { tool: "strikeout", label: "Strikeout" },
    { tool: "squiggly", label: "Squiggly Underline" },
  ],
  [
    { tool: "ink", label: "Freehand Pen" },
    { tool: "eraser", label: "Erase Ink" },
  ],
  [
    { tool: "square", label: "Rectangle" },
    { tool: "circle", label: "Ellipse" },
    { tool: "line", label: "Line" },
    { tool: "arrow", label: "Arrow" },
  ],
  [
    { tool: "freetext", label: "Text Box" },
    { tool: "note", label: "Comment" },
  ],
];

const SIDEBAR_SECTIONS: { id: SidebarTab; label: string }[] = [
  { id: "thumbnails", label: "Pages" },
  { id: "annotations", label: "Annotations" },
  { id: "outline", label: "Bookmarks" },
  { id: "search", label: "Search" },
];

/** Show the sidebar on a given section; used by both View ▸ Sidebar and Find. */
function showSidebar(section: SidebarTab) {
  viewer.sidebarOpen = true;
  viewer.sidebarTab = section;
}

// ------------------------------------------------------------------- menus

function fileMenu(recentsSubmenu: Submenu, quit: Spec[]): Spec {
  return {
    kind: "menu",
    label: "File",
    items: [
      item({
        id: "file.open",
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        action: () => void session.openViaDialog(),
      }),
      { kind: "built", item: recentsSubmenu },
      sep,
      item({
        id: "file.merge",
        label: "Merge PDFs…",
        action: () => session.openMergeDialog(),
      }),
      sep,
      item({
        id: "file.newTab",
        label: "New Tab",
        accelerator: "CmdOrCtrl+T",
        action: () => void workspace.open(),
      }),
      sep,
      item({
        id: "file.save",
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        enabled: hasDoc,
        action: () => void session.save(),
      }),
      item({
        id: "file.saveAs",
        label: "Save As…",
        accelerator: "CmdOrCtrl+Shift+S",
        enabled: hasDoc,
        action: () => void session.saveAs(),
      }),
      sep,
      item({
        id: "file.closeTab",
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        enabled: () => workspace.count > 0,
        action: () => {
          const current = tab();
          if (current) void session.requestClose(current);
        },
      }),
      ...quit,
    ],
  };
}

const editMenu: Spec = {
  kind: "menu",
  label: "Edit",
  items: [
    item({
      id: "edit.undo",
      label: "Undo",
      accelerator: "CmdOrCtrl+Z",
      enabled: () => tab()?.edits.canUndo === true,
      text: () => {
        const label = tab()?.edits.undoLabel;
        return label ? `Undo ${label}` : "Undo";
      },
      action: () => tab()?.edits.undo(),
    }),
    item({
      id: "edit.redo",
      label: "Redo",
      accelerator: "CmdOrCtrl+Shift+Z",
      enabled: () => tab()?.edits.canRedo === true,
      text: () => {
        const label = tab()?.edits.redoLabel;
        return label ? `Redo ${label}` : "Redo";
      },
      action: () => tab()?.edits.redo(),
    }),
    sep,
    { kind: "native", item: "Cut" },
    { kind: "native", item: "Copy" },
    { kind: "native", item: "Paste" },
    { kind: "native", item: "SelectAll" },
    sep,
    // No accelerator on purpose: a bare Delete would swallow the key while the
    // user is typing into a comment. `shortcuts.ts` handles that, focus-aware.
    item({
      id: "edit.deleteAnnot",
      label: "Delete Annotation",
      enabled: () => !!tab()?.edits.selectedId,
      action: () => {
        const current = tab();
        if (current?.edits.selectedId) current.edits.remove(current.edits.selectedId);
      },
    }),
    sep,
    item({
      id: "edit.find",
      label: "Find…",
      accelerator: "CmdOrCtrl+F",
      enabled: hasDoc,
      action: () => showSidebar("search"),
    }),
    item({
      id: "edit.findNext",
      label: "Find Next",
      accelerator: "CmdOrCtrl+G",
      enabled: hasDoc,
      action: () => tab()?.search.next(),
    }),
    item({
      id: "edit.findPrev",
      label: "Find Previous",
      accelerator: "CmdOrCtrl+Shift+G",
      enabled: hasDoc,
      action: () => tab()?.search.previous(),
    }),
  ],
};

const viewMenu: Spec = {
  kind: "menu",
  label: "View",
  items: [
    item({
      id: "view.zoomIn",
      label: "Zoom In",
      accelerator: "CmdOrCtrl+Equal",
      enabled: hasDoc,
      action: () => tab()?.view.zoomBy(1),
    }),
    item({
      id: "view.zoomOut",
      label: "Zoom Out",
      accelerator: "CmdOrCtrl+Minus",
      enabled: hasDoc,
      action: () => tab()?.view.zoomBy(-1),
    }),
    item({
      id: "view.actualSize",
      label: "Actual Size",
      accelerator: "CmdOrCtrl+Alt+0",
      enabled: hasDoc,
      action: () => tab()?.view.zoomTo(1),
    }),
    sep,
    check({
      id: "view.fitWidth",
      label: "Fit Width",
      enabled: hasDoc,
      checked: () => tab()?.view.zoom === "fit-width",
      action: () => tab()?.view.zoomTo("fit-width"),
    }),
    check({
      id: "view.fitPage",
      label: "Fit Page",
      accelerator: "CmdOrCtrl+0",
      enabled: hasDoc,
      checked: () => tab()?.view.zoom === "fit-page",
      action: () => tab()?.view.zoomTo("fit-page"),
    }),
    sep,
    check({
      id: "view.sidebar",
      label: "Show Sidebar",
      accelerator: "CmdOrCtrl+Backslash",
      checked: () => viewer.sidebarOpen,
      action: () => (viewer.sidebarOpen = !viewer.sidebarOpen),
    }),
    {
      kind: "menu",
      label: "Sidebar",
      items: SIDEBAR_SECTIONS.map((section) =>
        check({
          id: `view.sidebar.${section.id}`,
          label: section.label,
          enabled: hasDoc,
          checked: () => viewer.sidebarOpen && viewer.sidebarTab === section.id,
          action: () => showSidebar(section.id),
        }),
      ),
    },
    check({
      id: "view.inspector",
      label: "Show Properties",
      checked: () => viewer.inspectorOpen,
      action: () => (viewer.inspectorOpen = !viewer.inspectorOpen),
    }),
    sep,
    check({
      id: "view.labels",
      label: "Show Button Labels",
      checked: () => viewer.toolbarLabels,
      action: () => viewer.toggleToolbarLabels(),
    }),
    // Fullscreen is a macOS-only predefined item in muda.
    ...(isMac ? [sep, { kind: "native", item: "Fullscreen" } as Spec] : []),
  ],
};

const goMenu: Spec = {
  kind: "menu",
  label: "Go",
  items: [
    item({
      id: "go.next",
      label: "Next Page",
      accelerator: "CmdOrCtrl+Alt+Right",
      enabled: () => hasDoc() && (tab()?.view.currentPage ?? 0) < pageCount() - 1,
      action: () => {
        const current = tab();
        current?.view.goToPage(current.view.currentPage + 1);
      },
    }),
    item({
      id: "go.prev",
      label: "Previous Page",
      accelerator: "CmdOrCtrl+Alt+Left",
      enabled: () => hasDoc() && (tab()?.view.currentPage ?? 0) > 0,
      action: () => {
        const current = tab();
        current?.view.goToPage(current.view.currentPage - 1);
      },
    }),
    sep,
    // No accelerators: Home and End already do these, handled in
    // `shortcuts.ts` where they can be ignored while a text field has focus.
    // That frees Alt+Cmd+Up/Down for Pages > Move Page Up/Down.
    item({
      id: "go.first",
      label: "First Page",
      enabled: hasDoc,
      action: () => tab()?.view.goToPage(0),
    }),
    item({
      id: "go.last",
      label: "Last Page",
      enabled: hasDoc,
      action: () => tab()?.view.goToPage(pageCount() - 1),
    }),
  ],
};

function toolsMenu(onDrawSignature: () => void): Spec {
  const groups = TOOL_GROUPS.map((group) =>
    group.map(({ tool, label }) =>
      check({
        id: `tools.${tool}`,
        label,
        enabled: hasDoc,
        checked: () => viewer.tool === tool,
        action: () => viewer.setTool(tool),
      }),
    ),
  );

  return {
    kind: "menu",
    label: "Tools",
    // Tool items carry no accelerator: the toolbar's single-letter keys are
    // handled in `shortcuts.ts`, which ignores them while a field has focus.
    items: [
      ...groups.flatMap((group, index) => (index === 0 ? group : [sep, ...group])),
      sep,
      item({
        id: "tools.stamp",
        label: "Add Image Stamp…",
        enabled: hasDoc,
        action: () => void session.addImageStamp(),
      }),
      item({
        id: "tools.signature",
        label: "Draw Signature…",
        enabled: hasDoc,
        action: onDrawSignature,
      }),
    ],
  };
}

/** Pages the page operations act on: the strip's selection, else the current page. */
const targets = () => tab()?.targetPageIds ?? [];

const pagesMenu: Spec = {
  kind: "menu",
  label: "Pages",
  items: [
    item({
      id: "pages.blank",
      label: "Insert Blank Page",
      enabled: hasDoc,
      action: () => void session.addBlankPage(),
    }),
    item({
      id: "pages.insert",
      label: "Insert PDF Here…",
      enabled: hasDoc,
      action: () => {
        const current = tab();
        if (current) void session.mergePdf(current.insertAt);
      },
    }),
    item({
      id: "pages.append",
      label: "Append PDF…",
      enabled: hasDoc,
      action: () => void session.appendPdf(),
    }),
    sep,
    item({
      id: "pages.moveUp",
      label: "Move Page Up",
      accelerator: "CmdOrCtrl+Alt+Up",
      enabled: () => tab()?.edits.canMovePages(targets(), -1) === true,
      action: () => tab()?.edits.movePages(targets(), -1),
    }),
    item({
      id: "pages.moveDown",
      label: "Move Page Down",
      accelerator: "CmdOrCtrl+Alt+Down",
      enabled: () => tab()?.edits.canMovePages(targets(), 1) === true,
      action: () => tab()?.edits.movePages(targets(), 1),
    }),
    item({
      id: "pages.moveStart",
      label: "Move to Start",
      enabled: () => tab()?.edits.canMovePages(targets(), -1) === true,
      action: () => tab()?.edits.movePagesTo(targets(), "start"),
    }),
    item({
      id: "pages.moveEnd",
      label: "Move to End",
      enabled: () => tab()?.edits.canMovePages(targets(), 1) === true,
      action: () => tab()?.edits.movePagesTo(targets(), "end"),
    }),
    sep,
    item({
      id: "pages.rotateLeft",
      label: "Rotate Left",
      accelerator: "CmdOrCtrl+Shift+Minus",
      enabled: hasDoc,
      action: () => {
        const current = tab();
        current?.edits.rotatePages(current.targetPageIds, -90);
      },
    }),
    item({
      id: "pages.rotateRight",
      label: "Rotate Right",
      accelerator: "CmdOrCtrl+Shift+Equal",
      enabled: hasDoc,
      action: () => {
        const current = tab();
        current?.edits.rotatePages(current.targetPageIds, 90);
      },
    }),
    sep,
    item({
      id: "pages.delete",
      label: "Delete Page",
      text: () => ((tab()?.targetPageIds.length ?? 0) > 1 ? "Delete Pages" : "Delete Page"),
      // A document needs at least one page left over.
      enabled: () => hasDoc() && (tab()?.targetPageIds.length ?? 0) < pageCount(),
      action: () => {
        const current = tab();
        if (!current) return;
        current.edits.deletePages(current.targetPageIds);
        current.edits.clearPickedPages();
      },
    }),
    item({
      id: "pages.keep",
      label: "Keep Only Selected Pages",
      enabled: () => (tab()?.edits.pickedPageIds.size ?? 0) > 0,
      action: () => {
        const current = tab();
        if (!current) return;
        const picked = current.edits.pickedPageIds;
        const indices = current.edits.pages.flatMap((p, i) => (picked.has(p.id) ? [i] : []));
        if (indices.length === 0) return;
        current.edits.extractRange(Math.min(...indices), Math.max(...indices));
        current.edits.clearPickedPages();
      },
    }),
  ],
};

const windowMenu: Spec = {
  kind: "menu",
  label: "Window",
  items: [
    { kind: "native", item: "Minimize" },
    { kind: "native", item: "Maximize", label: isMac ? "Zoom" : undefined },
    sep,
    item({
      id: "window.nextTab",
      label: "Next Tab",
      accelerator: "Ctrl+Tab",
      enabled: () => workspace.count > 1,
      action: () => workspace.step(1),
    }),
    item({
      id: "window.prevTab",
      label: "Previous Tab",
      accelerator: "Ctrl+Shift+Tab",
      enabled: () => workspace.count > 1,
      action: () => workspace.step(-1),
    }),
    ...(isMac ? [sep, { kind: "native", item: "BringAllToFront" } as Spec] : []),
  ],
};

// ------------------------------------------------------------------ building

/** An item that has state to push, paired with what was last pushed to it. */
interface Live {
  spec: Dynamic & { checked?: () => boolean };
  item: MenuItem | CheckMenuItem;
  last: { text?: string; enabled?: boolean; checked?: boolean };
}

type Built = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

async function buildItems(specs: Spec[], live: Live[]): Promise<Built[]> {
  const built: Built[] = [];
  for (const spec of specs) {
    switch (spec.kind) {
      case "sep":
        built.push(await PredefinedMenuItem.new({ item: "Separator" }));
        break;
      case "native":
        built.push(await PredefinedMenuItem.new({ item: spec.item, text: spec.label }));
        break;
      case "built":
        built.push(spec.item);
        break;
      case "menu":
        built.push(
          await Submenu.new({ text: spec.label, items: await buildItems(spec.items, live) }),
        );
        break;
      case "item":
      case "check": {
        const text = spec.spec.text?.() ?? spec.spec.label;
        const enabled = spec.spec.enabled?.() ?? true;
        const options = {
          id: spec.spec.id,
          text,
          accelerator: spec.spec.accelerator,
          enabled,
          action: spec.spec.action,
        };
        if (spec.kind === "check") {
          const checked = spec.spec.checked();
          const node = await CheckMenuItem.new({ ...options, checked });
          live.push({ spec: spec.spec, item: node, last: { text, enabled, checked } });
          built.push(node);
        } else {
          const node = await MenuItem.new(options);
          live.push({ spec: spec.spec, item: node, last: { text, enabled } });
          built.push(node);
        }
        break;
      }
    }
  }
  return built;
}

/** Push anything that has drifted from app state. One IPC call per change. */
function syncItems(live: Live[]) {
  for (const { spec, item: node, last } of live) {
    const text = spec.text?.();
    if (text !== undefined && text !== last.text) {
      last.text = text;
      void node.setText(text);
    }
    const enabled = spec.enabled?.() ?? true;
    if (enabled !== last.enabled) {
      last.enabled = enabled;
      void node.setEnabled(enabled);
    }
    if (spec.checked && node instanceof CheckMenuItem) {
      const checked = spec.checked();
      if (checked !== last.checked) {
        last.checked = checked;
        void node.setChecked(checked);
      }
    }
  }
}

/**
 * Refill File ▸ Open Recent from the store.
 *
 * Rebuilt wholesale rather than diffed: the list is at most 15 entries and only
 * changes when a document is opened.
 */
async function fillRecents(menu: Submenu) {
  const existing = await menu.items();
  for (let i = existing.length - 1; i >= 0; i--) await menu.removeAt(i);

  const files = recents.list;
  if (files.length === 0) {
    await menu.append(
      await MenuItem.new({ id: "recent.none", text: "No Recent Files", enabled: false }),
    );
    return;
  }

  for (const file of files) {
    await menu.append(
      await MenuItem.new({
        id: `recent.${file.path}`,
        text: file.name,
        action: () => void session.openPath(file.path),
      }),
    );
  }
  await menu.append(await PredefinedMenuItem.new({ item: "Separator" }));
  await menu.append(
    await MenuItem.new({ id: "recent.clear", text: "Clear Menu", action: () => void recents.clear() }),
  );
}

/**
 * Build the menu, hand it to the OS, and keep it in step with app state.
 *
 * Resolves to a disposer. Failures are not fatal — running the frontend in a
 * plain browser (`npm run dev`, `verify:ui`) has no menu API — in which case
 * the app keeps its own keyboard shortcuts and simply has no menu bar.
 */
export async function installAppMenu(hooks: {
  onDrawSignature: () => void;
}): Promise<() => void> {
  try {
    const version = await getVersion().catch(() => "");
    const quit = item({
      id: "app.quit",
      label: isMac ? "Quit VrushPDF" : "Exit",
      accelerator: "CmdOrCtrl+Q",
      // Never the predefined Quit: that ends the process without giving the
      // unsaved-changes prompt a chance to run.
      action: () => void session.requestQuit(),
    });

    const settingsItem = item({
      id: "app.settings",
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      action: () => session.openSettings(),
    });

    const licenseItem = item({
      id: "app.license",
      label: "Enter License…",
      action: () => license.openDialog(),
    });

    const about: Spec = {
      kind: "native",
      item: {
        About: {
          name: "VrushPDF",
          version,
          copyright: "Copyright © 2026 nashv",
        },
      },
      label: "About VrushPDF",
    };

    const appMenu: Spec[] = isMac
      ? [
          {
            kind: "menu",
            label: "VrushPDF",
            items: [
              about,
              licenseItem,
              sep,
              settingsItem,
              sep,
              { kind: "native", item: "Services" },
              sep,
              { kind: "native", item: "Hide" },
              { kind: "native", item: "HideOthers" },
              { kind: "native", item: "ShowAll" },
              sep,
              quit,
            ],
          },
        ]
      : [];

    const helpMenu: Spec[] = isMac
      ? [] // macOS puts About in the app menu, so a Help menu would hold nothing.
      : [{ kind: "menu", label: "Help", items: [licenseItem, sep, about] }];

    const recentsSubmenu = await Submenu.new({ text: "Open Recent", items: [] });

    const live: Live[] = [];
    const items = await buildItems(
      [
        ...appMenu,
        fileMenu(recentsSubmenu, isMac ? [] : [sep, settingsItem, sep, quit]),
        editMenu,
        viewMenu,
        goMenu,
        toolsMenu(hooks.onDrawSignature),
        pagesMenu,
        windowMenu,
        ...helpMenu,
      ],
      live,
    );

    const menu = await Menu.new({ id: "app-menu", items });
    if (isMac) await menu.setAsAppMenu();
    else await menu.setAsWindowMenu();
    installed = true;

    const stop = $effect.root(() => {
      $effect(() => syncItems(live));

      // Serialised: each refill is a burst of IPC calls that must not interleave.
      let pending = Promise.resolve();
      $effect(() => {
        void recents.list;
        pending = pending.then(() => fillRecents(recentsSubmenu)).catch(() => {});
      });
    });

    return () => {
      installed = false;
      stop();
    };
  } catch (err) {
    // Not fatal, and not an error worth a console.error: the frontend runs
    // outside Tauri during development and in the UI test harness.
    console.warn("native menu unavailable:", err);
    return () => {};
  }
}
