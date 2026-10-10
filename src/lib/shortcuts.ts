/**
 * Global keyboard shortcuts.
 *
 * Keys are ignored while focus is in a text field, so typing in a comment or a
 * text box never switches tools.
 *
 * Once the native menu is up (see `menu/appMenu.svelte.ts`) the OS owns every
 * ⌘/Ctrl combination the menu declares as an accelerator, and this file steps
 * aside for those so nothing fires twice. Without the menu — the browser dev
 * server, the UI test harness — it keeps handling them itself.
 */
import { copyAnnots, hasHeldAnnots, placeAnnots, readAnnots } from "$lib/annotations/clipboard";
import { nativeMenuActive } from "$lib/menu/appMenu.svelte";
import { session } from "$lib/state/session.svelte";
import { viewer, type Tool } from "$lib/state/viewer.svelte";
import { workspace } from "$lib/state/workspace.svelte";

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  h: "pan",
  t: "text",
  "1": "highlight",
  "2": "underline",
  "3": "strikeout",
  "4": "squiggly",
  p: "ink",
  e: "eraser",
  r: "square",
  o: "circle",
  l: "line",
  a: "arrow",
  x: "freetext",
  n: "note",
  s: "signature",
  m: "measure",
  d: "redact",
  c: "check",
};

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// ----------------------------------------------------------------- clipboard

/**
 * The selected annotation, when copy/cut should take it rather than leave the
 * event to text. Text wins whenever focus is in a field or text is selected.
 */
function annotToCopy(event: Event) {
  if (isTyping(event.target) || isTyping(document.activeElement)) return null;
  if (window.getSelection()?.isCollapsed === false) return null;
  return workspace.active?.edits.selected ?? null;
}

function canPasteAnnots(event: Event): boolean {
  if (isTyping(event.target) || isTyping(document.activeElement)) return false;
  return workspace.active?.isOpen === true;
}

/**
 * Ctrl/⌘ C, X and V on annotations. These ride on the DOM clipboard events, so
 * the native Edit menu items and the keyboard reach them the same way and
 * copying text in a field is untouched.
 */
export function installClipboard(): () => void {
  const onCopy = (event: ClipboardEvent, cut: boolean) => {
    const annot = annotToCopy(event);
    const tab = workspace.active;
    if (!annot || !tab) return;
    event.preventDefault();
    copyAnnots([annot], event.clipboardData);
    if (cut) tab.edits.remove(annot.id, "Cut annotation");
  };

  const onPaste = (event: ClipboardEvent) => {
    const tab = workspace.active;
    if (!tab || !canPasteAnnots(event)) return;
    const annots = readAnnots(event.clipboardData);
    const page = tab.edits.pages[tab.view.currentPage] ?? tab.edits.pages[0];
    if (!annots || !page) return;
    event.preventDefault();
    const pasted = placeAnnots(annots, page.id);
    tab.edits.add(pasted, pasted.length > 1 ? "Paste annotations" : "Paste annotation");
    viewer.setTool("select");
  };

  // WebKit greys out Edit ▸ Copy/Paste when there is no text selection unless
  // the page claims the command by cancelling the matching `before*` event.
  const onBeforeCopy = (event: Event) => {
    if (annotToCopy(event)) event.preventDefault();
  };
  const onBeforePaste = (event: Event) => {
    if (hasHeldAnnots() && canPasteAnnots(event)) event.preventDefault();
  };

  const copy = (event: ClipboardEvent) => onCopy(event, false);
  const cut = (event: ClipboardEvent) => onCopy(event, true);
  document.addEventListener("copy", copy);
  document.addEventListener("cut", cut);
  document.addEventListener("paste", onPaste);
  document.addEventListener("beforecopy", onBeforeCopy);
  document.addEventListener("beforecut", onBeforeCopy);
  document.addEventListener("beforepaste", onBeforePaste);
  return () => {
    document.removeEventListener("copy", copy);
    document.removeEventListener("cut", cut);
    document.removeEventListener("paste", onPaste);
    document.removeEventListener("beforecopy", onBeforeCopy);
    document.removeEventListener("beforecut", onBeforeCopy);
    document.removeEventListener("beforepaste", onBeforePaste);
  };
}

export function handleShortcut(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key;

  // Everything below the tab shortcuts acts on the focused document.
  const tab = workspace.active;

  // Ctrl+Tab cycles tabs even on macOS, where it is the platform convention
  // and does not collide with the Cmd-based bindings.
  if (event.ctrlKey && key === "Tab") {
    if (nativeMenuActive()) return; // Window ▸ Next/Previous Tab
    event.preventDefault();
    workspace.step(event.shiftKey ? -1 : 1);
    return;
  }

  // Command combinations work everywhere; bare letters do not.
  if (mod) {
    const lower = key.toLowerCase();

    // Tab switching has no menu item of its own — nine numbered entries would
    // only clutter the Window menu — so these stay ours either way.
    if (/^[1-9]$/.test(lower)) {
      event.preventDefault();
      workspace.activateNumber(Number(lower));
      return;
    }
    if ((lower === "[" || lower === "]") && event.shiftKey) {
      event.preventDefault();
      workspace.step(lower === "]" ? 1 : -1);
      return;
    }

    if (nativeMenuActive()) return;

    switch (lower) {
      case "o":
        event.preventDefault();
        if (event.altKey) {
          session.openOptimizeDialog();
        } else {
          void session.openViaDialog();
        }
        return;
      case "t":
      case "n":
        event.preventDefault();
        void session.openViaDialog();
        return;
      case "w":
        event.preventDefault();
        if (tab) void session.requestClose(tab);
        return;
      case "s":
        event.preventDefault();
        if (event.altKey) {
          void session.saveFlattened();
        } else if (event.shiftKey) {
          void session.saveAs();
        } else {
          void session.save();
        }
        return;
      case "p":
        event.preventDefault();
        if (tab) void session.print();
        return;
      case "z":
        event.preventDefault();
        if (event.shiftKey) tab?.edits.redo();
        else tab?.edits.undo();
        return;
      case "f":
        event.preventDefault();
        viewer.sidebarOpen = true;
        viewer.sidebarTab = "search";
        return;
      case "k":
        event.preventDefault();
        session.toggleCommandPalette();
        return;
      case "g":
        event.preventDefault();
        if (event.shiftKey) tab?.search.previous();
        else tab?.search.next();
        return;
      case "=":
      case "+":
        event.preventDefault();
        tab?.view.zoomBy(1);
        return;
      case "-":
        event.preventDefault();
        tab?.view.zoomBy(-1);
        return;
      case "0":
        event.preventDefault();
        // ⌥ makes it "actual size"; ⌘1 is taken by tab switching.
        tab?.view.zoomTo(event.altKey ? 1 : "fit-page");
        return;
      case "\\":
        event.preventDefault();
        viewer.sidebarOpen = !viewer.sidebarOpen;
        return;
    }
    return;
  }

  if (isTyping(event.target)) return;

  if (key === "Escape") {
    // Escape backs out: first the selection, then the tool.
    if (tab?.edits.selectedId) tab.edits.select(null);
    else viewer.setTool("select");
    return;
  }

  if (key === "F5") {
    event.preventDefault();
    viewer.presentationMode = !viewer.presentationMode;
    return;
  }

  if ((key === "Backspace" || key === "Delete") && tab?.edits.selectedId) {
    event.preventDefault();
    tab.edits.remove(tab.edits.selectedId);
    return;
  }

  if (key === "PageDown") {
    event.preventDefault();
    tab?.view.goToPage(tab.view.currentPage + 1);
    return;
  }
  if (key === "PageUp") {
    event.preventDefault();
    tab?.view.goToPage(tab.view.currentPage - 1);
    return;
  }
  if (key === "Home") {
    event.preventDefault();
    tab?.view.goToPage(0);
    return;
  }
  if (key === "End") {
    event.preventDefault();
    tab?.view.goToPage(tab.edits.pages.length - 1);
    return;
  }

  // C places ticks; Shift+C, its counterpart, places crosses.
  const tool = event.shiftKey && key.toLowerCase() === "c" ? "cross" : TOOL_KEYS[key.toLowerCase()];
  if (tool) {
    event.preventDefault();
    // The signature tool is only usable once a signature exists to place.
    if (tool === "signature" && !viewer.pendingStamp) return;
    viewer.setTool(tool);
  }
}
