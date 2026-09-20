/**
 * The undoable editable state: page plan + annotations + selection.
 *
 * Page order and annotations are kept in one store because they are one
 * undoable unit — deleting a page also drops its annotations, and that has to
 * undo as a single step.
 *
 * Undo is snapshot-based. Annotation counts are small (hundreds at most) and
 * `$state.snapshot` already hands back a plain deep copy, so snapshots cost far
 * less than maintaining hand-written inverse operations for twelve annotation
 * kinds plus arbitrary page permutations.
 */
import {
  annotBounds,
  type Annot,
  type PageEntry,
  type Rect,
  type Rotation,
} from "$lib/annotations/types";
import { type DocStore, type SourceDoc } from "./doc.svelte";

export type { PageEntry };

const MAX_HISTORY = 100;

interface Snapshot {
  pages: PageEntry[];
  annots: Annot[];
}

interface HistoryEntry {
  label: string;
  state: Snapshot;
}

/** Build the initial one-to-one page plan for a freshly opened document. */
export function planFor(source: SourceDoc): PageEntry[] {
  return source.pages.map((_, index) => ({
    id: crypto.randomUUID(),
    sourceDocId: source.id,
    srcIndex: index,
    rotation: 0 as Rotation,
  }));
}

export class EditStore {
  /**
   * The tab's document store. Injected rather than imported: there is one
   * `EditStore` per tab and it must resolve page sizes against *its own*
   * document, not a global one.
   */
  #docs: DocStore;

  constructor(docs: DocStore) {
    this.#docs = docs;
  }

  pages = $state<PageEntry[]>([]);
  annots = $state<Annot[]>([]);
  selectedId = $state<string | null>(null);
  dirty = $state(false);

  /**
   * Pages ticked in the thumbnail strip, empty when nothing is ticked.
   *
   * Lives here rather than inside the strip because the Pages menu operates on
   * the same target, and the menu cannot see a component's local state.
   * `DocumentTab.targetPageIds` applies the "empty means the current page" rule.
   */
  pickedPageIds = $state.raw<Set<string>>(new Set());

  #undo: HistoryEntry[] = $state([]);
  #redo: HistoryEntry[] = $state([]);
  /** Snapshot captured by `begin()` while an interactive gesture is running. */
  #pending: { label: string; state: Snapshot } | null = null;

  // ------------------------------------------------------------- derived views

  /** Annotations grouped by page id, preserving z-order. */
  annotsByPage = $derived.by(() => {
    const map = new Map<string, Annot[]>();
    for (const a of this.annots) {
      const list = map.get(a.pageId);
      if (list) list.push(a);
      else map.set(a.pageId, [a]);
    }
    return map;
  });

  selected = $derived(this.annots.find((a) => a.id === this.selectedId) ?? null);

  get canUndo() {
    return this.#undo.length > 0;
  }

  get canRedo() {
    return this.#redo.length > 0;
  }

  get undoLabel() {
    return this.#undo.at(-1)?.label ?? null;
  }

  get redoLabel() {
    return this.#redo.at(-1)?.label ?? null;
  }

  pageIndexOf(pageId: string): number {
    return this.pages.findIndex((p) => p.id === pageId);
  }

  page(pageId: string): PageEntry | null {
    return this.pages.find((p) => p.id === pageId) ?? null;
  }

  annot(id: string): Annot | null {
    return this.annots.find((a) => a.id === id) ?? null;
  }

  /**
   * On-screen size of a planned page, in points.
   *
   * Accounts for *both* rotations: the page's intrinsic `/Rotate` and whatever
   * the user has applied. Layout and zoom-to-fit must use this — using the
   * unrotated size makes a landscape page overflow its container.
   */
  displayDims(entry: PageEntry): { width: number; height: number } {
    const src = this.#docs.source(entry.sourceDocId);
    const page = src?.pages[entry.srcIndex] ?? { width: 612, height: 792, rotate: 0 };
    const total = (((page.rotate + entry.rotation) % 360) + 360) % 360;
    return total % 180 === 0
      ? { width: page.width, height: page.height }
      : { width: page.height, height: page.width };
  }

  // ------------------------------------------------------------------- history

  #snapshot(): Snapshot {
    return {
      pages: $state.snapshot(this.pages) as PageEntry[],
      annots: $state.snapshot(this.annots) as Annot[],
    };
  }

  #restore(state: Snapshot) {
    this.pages = state.pages;
    this.annots = state.annots;
    if (this.selectedId && !this.annots.some((a) => a.id === this.selectedId)) {
      this.selectedId = null;
    }
  }

  #record(label: string, before: Snapshot) {
    this.#undo.push({ label, state: before });
    if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    this.#redo = [];
    this.dirty = true;
  }

  /** Apply an atomic, undoable change. */
  commit(label: string, mutate: () => void) {
    const before = this.#snapshot();
    mutate();
    this.#record(label, before);
  }

  /**
   * Start an interactive gesture (drag, resize, freehand stroke). Mutations made
   * between `begin` and `end` collapse into a single undo entry.
   */
  begin(label: string) {
    if (this.#pending) return;
    this.#pending = { label, state: this.#snapshot() };
  }

  /** Commit a gesture. No-op if nothing actually changed. */
  end() {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    const now = this.#snapshot();
    if (JSON.stringify(now) === JSON.stringify(pending.state)) return;
    this.#record(pending.label, pending.state);
  }

  /** Abandon a gesture, rolling state back to where `begin` found it. */
  cancel() {
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#restore(pending.state);
  }

  undo() {
    const entry = this.#undo.pop();
    if (!entry) return;
    this.#redo.push({ label: entry.label, state: this.#snapshot() });
    this.#restore(entry.state);
    this.dirty = true;
  }

  redo() {
    const entry = this.#redo.pop();
    if (!entry) return;
    this.#undo.push({ label: entry.label, state: this.#snapshot() });
    this.#restore(entry.state);
    this.dirty = true;
  }

  // --------------------------------------------------------------- annotations

  add(annot: Annot, label = "Add annotation") {
    this.commit(label, () => {
      this.annots.push(annot);
      this.selectedId = annot.id;
    });
  }

  /** Patch an annotation. Safe to call repeatedly inside a gesture. */
  update(id: string, patch: Partial<Annot> | ((a: Annot) => Annot), label = "Edit annotation") {
    const apply = () => {
      const index = this.annots.findIndex((a) => a.id === id);
      if (index === -1) return;
      const current = this.annots[index];
      const next = typeof patch === "function" ? patch(current) : ({ ...current, ...patch } as Annot);
      next.modifiedAt = new Date().toISOString();
      this.annots[index] = next;
    };
    // Inside a gesture the surrounding begin/end owns the undo entry.
    if (this.#pending) apply();
    else this.commit(label, apply);
  }

  remove(id: string, label = "Delete annotation") {
    this.commit(label, () => {
      this.annots = this.annots.filter((a) => a.id !== id);
      if (this.selectedId === id) this.selectedId = null;
    });
  }

  /** Raise an annotation to the top of the z-order. */
  bringToFront(id: string) {
    this.commit("Bring to front", () => {
      const index = this.annots.findIndex((a) => a.id === id);
      if (index === -1 || index === this.annots.length - 1) return;
      const [a] = this.annots.splice(index, 1);
      this.annots.push(a);
    });
  }

  select(id: string | null) {
    this.selectedId = id;
  }

  // ---------------------------------------------------------------- page plan

  clearPickedPages() {
    if (this.pickedPageIds.size > 0) this.pickedPageIds = new Set();
  }

  rotatePages(pageIds: string[], delta: 90 | -90) {
    const ids = new Set(pageIds);
    this.commit(pageIds.length > 1 ? "Rotate pages" : "Rotate page", () => {
      for (const page of this.pages) {
        if (ids.has(page.id)) {
          page.rotation = ((((page.rotation + delta) % 360) + 360) % 360) as Rotation;
        }
      }
    });
  }

  deletePages(pageIds: string[]) {
    const ids = new Set(pageIds);
    if (ids.size >= this.pages.length) return; // never leave a zero-page document
    this.commit(ids.size > 1 ? "Delete pages" : "Delete page", () => {
      this.pages = this.pages.filter((p) => !ids.has(p.id));
      this.annots = this.annots.filter((a) => !ids.has(a.pageId));
      if (this.selectedId && !this.annots.some((a) => a.id === this.selectedId)) {
        this.selectedId = null;
      }
    });
    void this.#docs.pruneSources(new Set(this.pages.map((p) => p.sourceDocId)));
  }

  /** Plan indices of `pageIds`, ascending. */
  #indicesOf(pageIds: string[]): number[] {
    const ids = new Set(pageIds);
    return this.pages.flatMap((p, i) => (ids.has(p.id) ? [i] : []));
  }

  /**
   * False when the selection is already against that end of the document.
   *
   * The buttons and menu items disable on this, so a selection that cannot move
   * looks inert rather than silently ignoring a click.
   */
  canMovePages(pageIds: string[], delta: -1 | 1): boolean {
    const indices = this.#indicesOf(pageIds);
    if (indices.length === 0) return false;
    return delta < 0 ? indices[0] > 0 : indices.at(-1)! < this.pages.length - 1;
  }

  /**
   * Slide the selected pages one slot, as one undo step.
   *
   * Moving up walks the indices ascending and moving down walks them
   * descending: each page then lands in a slot the not-yet-moved ones haven't
   * occupied, so a multi-page selection travels as a block and keeps its
   * internal order.
   */
  movePages(pageIds: string[], delta: -1 | 1) {
    if (!this.canMovePages(pageIds, delta)) return;
    const indices = this.#indicesOf(pageIds);
    const order = delta < 0 ? indices : [...indices].reverse();

    this.commit(indices.length > 1 ? "Move pages" : "Move page", () => {
      for (const index of order) {
        const [entry] = this.pages.splice(index, 1);
        this.pages.splice(index + delta, 0, entry);
      }
    });
  }

  /** Move the selected pages to the very start or end, keeping their order. */
  movePagesTo(pageIds: string[], position: "start" | "end") {
    const indices = this.#indicesOf(pageIds);
    if (indices.length === 0) return;
    // Already there: nothing to do, and no empty undo step.
    const atStart = indices.every((index, i) => index === i);
    const atEnd = indices.every((index, i) => index === this.pages.length - indices.length + i);
    if (position === "start" ? atStart : atEnd) return;

    this.commit(indices.length > 1 ? "Move pages" : "Move page", () => {
      const moved = indices.map((i) => this.pages[i]);
      const rest = this.pages.filter((_, i) => !indices.includes(i));
      this.pages = position === "start" ? [...moved, ...rest] : [...rest, ...moved];
    });
  }

  /** Move the page at `from` so it lands at index `to`. */
  movePage(from: number, to: number) {
    if (from === to || from < 0 || from >= this.pages.length) return;
    const target = Math.max(0, Math.min(to, this.pages.length - 1));
    this.commit("Reorder pages", () => {
      const [entry] = this.pages.splice(from, 1);
      this.pages.splice(target, 0, entry);
    });
  }

  /** Reduce the document to `from..to` inclusive (0-based, in plan order). */
  extractRange(from: number, to: number) {
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(this.pages.length - 1, Math.max(from, to));
    if (lo === 0 && hi === this.pages.length - 1) return;
    const keep = new Set(this.pages.slice(lo, hi + 1).map((p) => p.id));
    this.commit(`Keep pages ${lo + 1}–${hi + 1}`, () => {
      this.pages = this.pages.filter((p) => keep.has(p.id));
      this.annots = this.annots.filter((a) => keep.has(a.pageId));
    });
    void this.#docs.pruneSources(new Set(this.pages.map((p) => p.sourceDocId)));
  }

  // ------------------------------------------------------------------ lifecycle

  /** Reset to a freshly opened document. Clears history — nothing to undo into. */
  reset(pages: PageEntry[], annots: Annot[]) {
    this.pages = pages;
    this.annots = annots;
    this.selectedId = null;
    this.pickedPageIds = new Set();
    this.#undo = [];
    this.#redo = [];
    this.#pending = null;
    this.dirty = false;
  }

  markSaved() {
    this.dirty = false;
  }
}
