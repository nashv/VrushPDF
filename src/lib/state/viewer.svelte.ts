/** Transient view state: zoom, current page, active tool and its style defaults. */
import type { AnnotKind } from "$lib/annotations/types";

export type Tool =
  | "select"
  | "pan"
  | "text"
  | AnnotKind
  | "eraser"
  | "signature";

/** Tools that create an annotation by dragging out a rectangle or a line. */
export const DRAG_TOOLS: Tool[] = ["square", "circle", "line", "arrow", "freetext", "stamp", "signature"];
/** Tools that consume a text selection from the text layer. */
export const MARKUP_TOOLS: Tool[] = ["highlight", "underline", "strikeout", "squiggly"];

export type ZoomMode = "fit-width" | "fit-page" | number;

export interface AnnotStyle {
  color: string;
  opacity: number;
  width: number;
  /** Interior colour for closed shapes; `null` means unfilled. */
  fill: string | null;
  fontSize: number;
}

const STYLE_KEY = "pdfeditor.styles.v1";

/**
 * Per-kind defaults. Markup colours are the conventional highlighter set;
 * ink and shapes default to a saturated red so they read as a mark-up layer.
 */
function defaultStyles(): Record<AnnotKind, AnnotStyle> {
  const base: AnnotStyle = { color: "#e11d48", opacity: 1, width: 2, fill: null, fontSize: 12 };
  return {
    highlight: { ...base, color: "#fde047", opacity: 0.45, width: 0 },
    underline: { ...base, color: "#2563eb", width: 1.5 },
    strikeout: { ...base, color: "#dc2626", width: 1.5 },
    squiggly: { ...base, color: "#16a34a", width: 1.5 },
    ink: { ...base, color: "#e11d48", width: 2.5 },
    square: { ...base },
    circle: { ...base },
    line: { ...base },
    arrow: { ...base },
    freetext: { ...base, color: "#111827", fontSize: 12, width: 0 },
    note: { ...base, color: "#fbbf24" },
    stamp: { ...base, width: 0 },
  };
}

function loadStyles(): Record<AnnotKind, AnnotStyle> {
  const defaults = defaultStyles();
  try {
    const raw = globalThis.localStorage?.getItem(STYLE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Record<AnnotKind, Partial<AnnotStyle>>>;
    for (const [kind, style] of Object.entries(saved)) {
      const key = kind as AnnotKind;
      if (defaults[key] && style) defaults[key] = { ...defaults[key], ...style };
    }
  } catch {
    // Corrupt or unavailable storage is not worth surfacing; fall back to defaults.
  }
  return defaults;
}

export type SidebarTab = "thumbnails" | "annotations" | "outline" | "search";

class ViewerStore {
  zoom = $state<ZoomMode>("fit-width");
  /** Effective scale, computed by the viewer once it knows its own width. */
  scale = $state(1);
  /** 0-based index into the page plan. */
  currentPage = $state(0);
  tool = $state<Tool>("select");
  styles = $state<Record<AnnotKind, AnnotStyle>>(loadStyles());

  sidebarOpen = $state(true);
  sidebarTab = $state<SidebarTab>("thumbnails");
  inspectorOpen = $state(true);

  /** Image id the stamp tool will place on the next click. */
  pendingStamp = $state<string | null>(null);

  #scroller: ((pageIndex: number, opts?: { top?: number }) => void) | null = null;

  /** The active tool's style, or the fallback when the tool doesn't draw. */
  get style(): AnnotStyle {
    return this.styles[this.tool as AnnotKind] ?? this.styles.ink;
  }

  setStyle(kind: AnnotKind, patch: Partial<AnnotStyle>) {
    this.styles[kind] = { ...this.styles[kind], ...patch };
    try {
      globalThis.localStorage?.setItem(STYLE_KEY, JSON.stringify($state.snapshot(this.styles)));
    } catch {
      // Non-fatal: styles simply won't persist across restarts.
    }
  }

  setTool(tool: Tool) {
    this.tool = tool;
    if (tool !== "stamp" && tool !== "signature") this.pendingStamp = null;
  }

  /** The viewer registers how to scroll; everything else calls `goToPage`. */
  registerScroller(fn: (pageIndex: number, opts?: { top?: number }) => void) {
    this.#scroller = fn;
    return () => {
      if (this.#scroller === fn) this.#scroller = null;
    };
  }

  goToPage(pageIndex: number, opts?: { top?: number }) {
    this.#scroller?.(pageIndex, opts);
  }

  zoomTo(mode: ZoomMode) {
    this.zoom = mode;
  }

  /** Step through a fixed zoom ladder so repeated presses feel predictable. */
  zoomBy(direction: 1 | -1) {
    const ladder = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8];
    const current = this.scale;
    const next =
      direction > 0
        ? (ladder.find((z) => z > current + 0.001) ?? ladder.at(-1)!)
        : ([...ladder].reverse().find((z) => z < current - 0.001) ?? ladder[0]);
    this.zoom = next;
  }

  reset() {
    this.zoom = "fit-width";
    this.currentPage = 0;
    this.tool = "select";
    this.pendingStamp = null;
  }
}

export const viewer = new ViewerStore();
