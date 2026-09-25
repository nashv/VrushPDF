<script lang="ts">
  /**
   * A drag handle between two panels.
   *
   * Sits in the flex row as a sibling of the panels it separates, so there is
   * no absolute positioning or overlap to manage. Pointer events rather than
   * HTML5 drag, for the reason set out in `$lib/reorder.svelte.ts`: the
   * window's file-drop handler stops WebKit from ever dispatching `dragover`.
   */
  import { viewer, type Panel } from "$lib/state/viewer.svelte";

  let {
    panel,
    /** Which side of the handle the panel is on. */
    side,
    label,
  }: { panel: Panel; side: "left" | "right"; label: string } = $props();

  /** Keyboard nudge, in px. */
  const STEP = 16;

  let node: HTMLElement;
  let dragging = $state(false);
  let startX = 0;
  let startWidth = 0;

  /**
   * The panel's rendered width, which is not necessarily the stored one — a
   * `max-width` may be capping it. Starting from the rendered value keeps the
   * handle under the pointer instead of jumping on the first move.
   */
  function panelWidth(): number {
    const el = side === "left" ? node.previousElementSibling : node.nextElementSibling;
    return el instanceof HTMLElement ? el.getBoundingClientRect().width : viewer.panelWidth[panel];
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = panelWidth();
    dragging = true;
    // Document-wide while dragging, so the cursor doesn't flicker as it crosses
    // the viewer and a stray text selection can't start.
    document.documentElement.classList.add("resizing");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(event: PointerEvent) {
    const delta = event.clientX - startX;
    viewer.setPanelWidth(panel, side === "left" ? startWidth + delta : startWidth - delta);
  }

  function onPointerUp() {
    dragging = false;
    document.documentElement.classList.remove("resizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  }

  function onKeyDown(event: KeyboardEvent) {
    const towards = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (towards === 0) return;
    event.preventDefault();
    const delta = (side === "left" ? towards : -towards) * STEP;
    viewer.setPanelWidth(panel, panelWidth() + delta);
  }
</script>

<!--
  A real <button> rather than a div with role="separator": it is focusable and
  keyboard-reachable for free. ARIA's window-splitter pattern would be the
  textbook fit, but svelte-check rejects `role="separator"` on a button and
  rejects `tabindex` on a div carrying that role, so there is no lint-clean way
  to express it — and a plainly labelled button that responds to arrow keys is
  no worse for a screen reader than a splitter it may not announce anyway.
  Bare buttons are already reset in app.css, so only the cursor needs work.
-->
<button
  bind:this={node}
  type="button"
  class="resizer"
  class:dragging
  aria-label="{label} ({viewer.panelWidth[panel]} pixels wide)"
  onpointerdown={onPointerDown}
  onkeydown={onKeyDown}
  ondblclick={() => viewer.resetPanelWidth(panel)}
  title="{label} — drag to resize, double-click to reset"
></button>

<style>
  .resizer {
    position: relative;
    flex: none;
    width: 1px;
    background: var(--border);
    cursor: col-resize;
  }

  /*
   * A 1px line is far too thin to hit. This widens the *target* either side
   * without widening the line or disturbing the layout.
   */
  .resizer::before {
    content: "";
    position: absolute;
    inset: 0 -4px;
    z-index: 5;
  }

  .resizer:hover,
  .resizer:focus-visible,
  .resizer.dragging {
    background: var(--accent);
    outline: none;
  }

  /*
   * Liquid Glass (macOS): the panes are separate cards, so there is no line to
   * draw; the handle is the gutter between them, and shows a short grip.
   */
  :global([data-glass]) .resizer {
    width: var(--pane-gap);
    background: none;
  }

  :global([data-glass]) .resizer:hover,
  :global([data-glass]) .resizer:focus-visible,
  :global([data-glass]) .resizer.dragging {
    background: linear-gradient(var(--accent), var(--accent)) center / 3px 36px no-repeat;
  }

  /* The panels overlay at this width, so there is nothing to divide. */
  @media (max-width: 899px) {
    .resizer {
      display: none;
    }
  }
</style>
