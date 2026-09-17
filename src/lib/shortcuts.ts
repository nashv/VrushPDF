/**
 * Global keyboard shortcuts.
 *
 * Keys are ignored while focus is in a text field, so typing in a comment or a
 * text box never switches tools.
 */
import { edits } from "$lib/state/edits.svelte";
import { search } from "$lib/state/search.svelte";
import { session } from "$lib/state/session.svelte";
import { viewer, type Tool } from "$lib/state/viewer.svelte";

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

  // Command combinations work everywhere; bare letters do not.
  if (mod) {
    const lower = key.toLowerCase();
    switch (lower) {
      case "o":
        event.preventDefault();
        void session.openViaDialog();
        return;
      case "s":
        event.preventDefault();
        void (event.shiftKey ? session.saveAs() : session.save());
        return;
      case "z":
        event.preventDefault();
        if (event.shiftKey) edits.redo();
        else edits.undo();
        return;
      case "f":
        event.preventDefault();
        viewer.sidebarOpen = true;
        viewer.sidebarTab = "search";
        return;
      case "g":
        event.preventDefault();
        if (event.shiftKey) search.previous();
        else search.next();
        return;
      case "=":
      case "+":
        event.preventDefault();
        viewer.zoomBy(1);
        return;
      case "-":
        event.preventDefault();
        viewer.zoomBy(-1);
        return;
      case "0":
        event.preventDefault();
        viewer.zoomTo("fit-page");
        return;
      case "1":
        // ⌘1 is "actual size", distinct from the bare 1 highlight shortcut.
        event.preventDefault();
        viewer.zoomTo(1);
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
    if (edits.selectedId) edits.select(null);
    else viewer.setTool("select");
    return;
  }

  if ((key === "Backspace" || key === "Delete") && edits.selectedId) {
    event.preventDefault();
    edits.remove(edits.selectedId);
    return;
  }

  if (key === "PageDown") {
    event.preventDefault();
    viewer.goToPage(viewer.currentPage + 1);
    return;
  }
  if (key === "PageUp") {
    event.preventDefault();
    viewer.goToPage(viewer.currentPage - 1);
    return;
  }
  if (key === "Home") {
    event.preventDefault();
    viewer.goToPage(0);
    return;
  }
  if (key === "End") {
    event.preventDefault();
    viewer.goToPage(edits.pages.length - 1);
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
