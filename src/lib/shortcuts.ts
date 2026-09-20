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
};

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
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
        void (event.shiftKey ? session.saveAs() : session.save());
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

  const tool = TOOL_KEYS[key.toLowerCase()];
  if (tool) {
    event.preventDefault();
    // The signature tool is only usable once a signature exists to place.
    if (tool === "signature" && !viewer.pendingStamp) return;
    viewer.setTool(tool);
  }
}
