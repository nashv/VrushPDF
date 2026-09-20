/**
 * Drag-to-reorder, built on pointer events.
 *
 * Not HTML5 drag-and-drop, and it cannot be: the window is created with
 * `dragDropEnabled: true` so that dropping a PDF onto it opens the file, and
 * that makes wry install an NSDraggingDestination override on the webview whose
 * handler (`tauri-runtime-wry/src/lib.rs`) returns `true` for every drag event.
 * wry only forwards to `super` — letting WebKit handle the drag — when that
 * handler returns false, so `dragover` and `drop` never reach the document.
 * Tauri's own config docs note the same thing for Windows.
 *
 * Pointer drags never open a native dragging session, so they are unaffected,
 * they behave the same on all three platforms, and unlike HTML5 drags they can
 * be synthesised in the UI test harness.
 */

/** How far the pointer must travel before a press becomes a drag, in px. */
const THRESHOLD = 5;
/** Distance from a scroller's edge at which auto-scroll kicks in, in px. */
const EDGE = 44;
const EDGE_SPEED = 12;

export interface ReorderOptions {
  axis: "x" | "y";
  /** Matches one draggable item; each must carry `data-reorder-index`. */
  itemSelector: string;
  /** Commit the move. Only called when `to` differs from `from`. */
  onDrop: (from: number, to: number) => void;
  /** Scrolls when the pointer nears its edge. Omit for short lists. */
  scroller?: () => HTMLElement | null;
}

export function createReorder(options: ReorderOptions) {
  /** The item being dragged, once the threshold is passed. */
  let from = $state<number | null>(null);
  /** The item it would land on. */
  let to = $state<number | null>(null);

  let pending: number | null = null;
  let origin = { x: 0, y: 0 };
  let frame = 0;
  /** When the last real drag ended, so the click it produces can be ignored. */
  let endedAt = 0;

  const indexUnder = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(options.itemSelector);
    const raw = el?.dataset.reorderIndex;
    return raw === undefined ? null : Number(raw);
  };

  /** Keep scrolling while the pointer sits near an edge, not just on movement. */
  function autoScroll(x: number, y: number) {
    cancelAnimationFrame(frame);
    const box = options.scroller?.();
    if (!box) return;

    const rect = box.getBoundingClientRect();
    const [near, far, lead] =
      options.axis === "y" ? [rect.top, rect.bottom, y] : [rect.left, rect.right, x];

    let delta = 0;
    if (lead - near < EDGE) delta = -EDGE_SPEED;
    else if (far - lead < EDGE) delta = EDGE_SPEED;
    if (delta === 0) return;

    const step = () => {
      if (options.axis === "y") box.scrollTop += delta;
      else box.scrollLeft += delta;
      // The item under the pointer changes as the list slides beneath it.
      const found = indexUnder(x, y);
      if (found !== null) to = found;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function stop() {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey, true);
    pending = null;
    from = null;
    to = null;
  }

  function move(event: PointerEvent) {
    if (pending === null) return;

    if (from === null) {
      /*
       * Total distance, not the distance along `axis`. The thumbnail grid is
       * two columns, so dragging a page onto the one beside it is almost pure
       * horizontal movement — measuring only the vertical component meant that
       * drag never started. `axis` is for auto-scroll, nothing else.
       */
      const travelled = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
      // Below the threshold this is still a click, so leave it alone.
      if (travelled < THRESHOLD) return;
      from = pending;
      to = pending;
    }

    event.preventDefault();
    const found = indexUnder(event.clientX, event.clientY);
    if (found !== null) to = found;
    autoScroll(event.clientX, event.clientY);
  }

  function up() {
    const start = from;
    const target = to;
    if (start !== null) endedAt = performance.now();
    stop();

    if (start !== null && target !== null && start !== target) {
      options.onDrop(start, target);
    }
  }

  const cancel = () => stop();

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    stop();
  }

  return {
    get from() {
      return from;
    },
    get to() {
      return to;
    },
    /** True once a press has become a drag. */
    get active() {
      return from !== null;
    },
    /**
     * True just after a drag finished.
     *
     * A drag ends with a pointerup, and the browser follows that with a click
     * when press and release share a target — which would re-select whatever
     * the drag landed on. Callers check this in their click handler. An earlier
     * version swallowed the click with a one-shot capturing window listener
     * instead, which leaked and ate an unrelated click whenever the drag ended
     * on a different element and no click ever came.
     */
    get justDragged() {
      return performance.now() - endedAt < 250;
    },
    /** Attach to each item's `onpointerdown`. */
    down(index: number, event: PointerEvent) {
      if (event.button !== 0) return;
      stop();

      pending = index;
      origin = { x: event.clientX, y: event.clientY };

      /*
       * Tracked on the window rather than through `setPointerCapture`: capture
       * gives nothing extra here, and it throws `NotFoundError` for a pointer
       * the browser doesn't consider active — which is exactly what synthesised
       * input in the UI test harness produces.
       */
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey, true);
    },
  };
}
