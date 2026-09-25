/**
 * View state, in two halves: `ViewState` belongs to a document (zoom, page,
 * scroll) and is created per tab; `viewer` is app-wide (tool, styles, panels).
 */
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

const STYLE_KEY = "vrushpdf.styles.v1";
const LAYOUT_KEY = "vrushpdf.layout.v2";

/*
 * The app was called "PDF Editor" until 0.1.0. Reading the old keys once means
 * the rename does not silently reset saved styles and panel widths.
 */
const LEGACY_STYLE_KEY = "pdfeditor.styles.v1";
const LEGACY_LAYOUT_KEY = "pdfeditor.layout.v2";

function readStored(key: string, legacy: string): string | null {
  const store = globalThis.localStorage;
  return store?.getItem(key) ?? store?.getItem(legacy) ?? null;
}

/** Panel widths, in px. Defaults match `--sidebar-w` / `--inspector-w`. */
export const PANEL_DEFAULTS = { sidebar: 288, inspector: 272 } as const;
const PANEL_LIMITS = { sidebar: { min: 180, max: 620 }, inspector: { min: 200, max: 560 } };

export type Panel = keyof typeof PANEL_DEFAULTS;

interface Layout {
  widths: Record<Panel, number>;
  /** Show a text label under every toolbar button. */
  labels: boolean;
}

function loadLayout(): Layout {
  const layout: Layout = { widths: { ...PANEL_DEFAULTS }, labels: false };
  try {
    const raw = readStored(LAYOUT_KEY, LEGACY_LAYOUT_KEY);
    if (!raw) return layout;
    const saved = JSON.parse(raw) as Partial<Layout>;
    for (const panel of Object.keys(layout.widths) as Panel[]) {
      const value = saved.widths?.[panel];
      if (typeof value === "number" && Number.isFinite(value)) {
        layout.widths[panel] = clampPanel(panel, value);
      }
    }
    if (typeof saved.labels === "boolean") layout.labels = saved.labels;
  } catch {
    // Same as the styles above: corrupt storage just means defaults.
  }
  return layout;
}

function clampPanel(panel: Panel, px: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  return Math.round(Math.max(min, Math.min(max, px)));
}

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
    const raw = readStored(STYLE_KEY, LEGACY_STYLE_KEY);
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

/** Read once at module load; the store owns it from then on. */
const SAVED_LAYOUT = loadLayout();

export type SidebarTab = "thumbnails" | "annotations" | "outline" | "search";

/**
 * Per-document view state.
 *
 * Split out of the global store because these are the things a user expects to
 * belong to *a document*, not to the app: switching tabs and coming back should
 * return you to the same page at the same zoom, scrolled where you left off.
 */
export class ViewState {
  zoom = $state<ZoomMode>("fit-width");
  /** Effective scale, computed by the viewer once it knows its own width. */
  scale = $state(1);
  /** 0-based index into the page plan. */
  currentPage = $state(0);
  /**
   * Last scroll offset, saved as you scroll and restored on mount. Inactive
   * tabs are unmounted, so without this a tab switch would jump to the top.
   */
  scrollTop = $state(0);

  #scroller: ((pageIndex: number, opts?: { top?: number }) => void) | null = null;

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
}

/**
 * App-wide UI state.
 *
 * The active tool, its styles and the panel layout deliberately persist across
 * tabs — picking the highlighter, switching document and having to pick it
 * again would be wrong.
 */
class ViewerStore {
  tool = $state<Tool>("select");
  styles = $state<Record<AnnotKind, AnnotStyle>>(loadStyles());

  sidebarOpen = $state(true);
  sidebarTab = $state<SidebarTab>("thumbnails");
  inspectorOpen = $state(true);

  /**
   * Panel widths. A CSS `max-width` caps these against the window, so a narrow
   * window cannot squeeze the viewer away and no resize listener is needed.
   */
  panelWidth = $state<Record<Panel, number>>(SAVED_LAYOUT.widths);
  /** Icon-and-text toolbar buttons, as in a native macOS toolbar. */
  toolbarLabels = $state(SAVED_LAYOUT.labels);
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** Image id the stamp tool will place on the next click. */
  pendingStamp = $state<string | null>(null);

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

  setPanelWidth(panel: Panel, px: number) {
    this.panelWidth[panel] = clampPanel(panel, px);
    this.#saveLayout();
  }

  toggleToolbarLabels() {
    this.toolbarLabels = !this.toolbarLabels;
    this.#saveLayout();
  }

  /** Debounced: a resize drag calls this on every pointermove. */
  #saveLayout() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      const layout: Layout = {
        widths: $state.snapshot(this.panelWidth),
        labels: this.toolbarLabels,
      };
      try {
        globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
      } catch {
        // Non-fatal: the layout simply won't persist across restarts.
      }
    }, 150);
  }

  resetPanelWidth(panel: Panel) {
    this.setPanelWidth(panel, PANEL_DEFAULTS[panel]);
  }

  /**
   * Asked before every tool change. The license store installs it, so an ended
   * trial can hold the user to the read-only tools without this store having
   * to import that one.
   */
  toolGuard: (tool: Tool) => boolean = () => true;

  setTool(tool: Tool) {
    if (!this.toolGuard(tool)) return;
    this.tool = tool;
    if (tool !== "stamp" && tool !== "signature") this.pendingStamp = null;
  }
}

export const viewer = new ViewerStore();
