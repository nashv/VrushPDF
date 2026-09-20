/**
 * Open documents, one per tab.
 *
 * Each tab owns a complete, independent copy of the per-document state — its
 * own pdf.js worker and page cache, its own page plan and annotations, its own
 * undo history, zoom and scroll position. Nothing is shared between tabs except
 * the app-wide tool/style state in `viewer` and the signature/stamp library in
 * `images`.
 */
import { DocStore } from "./doc.svelte";
import { EditStore } from "./edits.svelte";
import { SearchStore } from "./search.svelte";
import { ViewState } from "./viewer.svelte";

export class DocumentTab {
  readonly id = crypto.randomUUID();

  readonly doc = new DocStore();
  readonly view = new ViewState();
  readonly edits: EditStore;
  readonly search: SearchStore;

  constructor() {
    // `edits` resolves page geometry through this tab's document, and `search`
    // scans it and scrolls this tab's viewer.
    this.edits = new EditStore(this.doc);
    this.search = new SearchStore({ doc: this.doc, edits: this.edits, view: this.view });
  }

  get title(): string {
    return this.doc.name || "Untitled";
  }

  get path(): string | null {
    return this.doc.path;
  }

  get isOpen(): boolean {
    return this.doc.isOpen;
  }

  get dirty(): boolean {
    return this.edits.dirty;
  }

  /**
   * The pages a page operation applies to: whatever is ticked in the thumbnail
   * strip, or the page you are looking at when nothing is.
   *
   * Both the strip's own buttons and the Pages menu go through this, so the two
   * can never disagree about what "rotate" is about to rotate.
   */
  get targetPageIds(): string[] {
    const picked = this.edits.pickedPageIds;
    if (picked.size > 0) return this.edits.pages.filter((p) => picked.has(p.id)).map((p) => p.id);
    const current = this.edits.pages[this.view.currentPage];
    return current ? [current.id] : [];
  }

  /** Where "insert another PDF here" drops its pages. */
  get insertAt(): number {
    const picked = this.edits.pickedPageIds;
    const indices = this.edits.pages.flatMap((p, i) => (picked.has(p.id) ? [i] : []));
    return indices.length > 0 ? Math.max(...indices) + 1 : this.view.currentPage + 1;
  }

  /**
   * Release the tab's resources. Skipping this leaks a pdf.js worker and the
   * whole rendered page cache for every document ever closed.
   */
  async dispose() {
    this.search.clear();
    await this.doc.close();
  }
}

class Workspace {
  tabs = $state<DocumentTab[]>([]);
  activeId = $state<string | null>(null);

  active = $derived(this.tabs.find((t) => t.id === this.activeId) ?? null);

  get count(): number {
    return this.tabs.length;
  }

  get anyDirty(): boolean {
    return this.tabs.some((t) => t.dirty);
  }

  tab(id: string): DocumentTab | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  indexOf(id: string): number {
    return this.tabs.findIndex((t) => t.id === id);
  }

  /** Create a tab and make it active. */
  open(): DocumentTab {
    const tab = new DocumentTab();
    this.tabs = [...this.tabs, tab];
    this.activeId = tab.id;
    return tab;
  }

  /**
   * A tab that has no document yet, if the active one is empty.
   *
   * Opening a file from the welcome screen should fill the tab you are looking
   * at rather than leaving a blank one behind.
   */
  reusableTab(): DocumentTab | null {
    const current = this.active;
    return current && !current.isOpen ? current : null;
  }

  /** The tab a newly opened file should land in. */
  tabForOpen(): DocumentTab {
    return this.reusableTab() ?? this.open();
  }

  activate(id: string) {
    if (this.tabs.some((t) => t.id === id)) this.activeId = id;
  }

  /** Close without prompting. Callers handle unsaved work first. */
  async close(id: string) {
    const index = this.indexOf(id);
    if (index === -1) return;
    const [tab] = this.tabs.splice(index, 1);
    this.tabs = [...this.tabs];

    if (this.activeId === id) {
      // Prefer the tab that slid into this slot, else the one before it.
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeId = next?.id ?? null;
    }

    await tab.dispose();
  }

  move(from: number, to: number) {
    if (from === to || from < 0 || from >= this.tabs.length) return;
    const target = Math.max(0, Math.min(to, this.tabs.length - 1));
    const next = [...this.tabs];
    const [tab] = next.splice(from, 1);
    next.splice(target, 0, tab);
    this.tabs = next;
  }

  /** Cycle, wrapping at both ends. */
  step(delta: 1 | -1) {
    if (this.tabs.length < 2) return;
    const index = this.indexOf(this.activeId ?? "");
    const next = (((index + delta) % this.tabs.length) + this.tabs.length) % this.tabs.length;
    this.activeId = this.tabs[next].id;
  }

  /** Jump to a 1-based tab number, as ⌘1…⌘9 do. */
  activateNumber(n: number) {
    const tab = this.tabs[n - 1];
    if (tab) this.activeId = tab.id;
  }
}

export const workspace = new Workspace();
