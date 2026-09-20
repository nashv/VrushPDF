/** Search box state and the running scan. */
import { searchDocument, type SearchMatch, type SearchOptions } from "$lib/pdf/search";
import type { DocStore } from "./doc.svelte";
import type { EditStore } from "./edits.svelte";
import type { ViewState } from "./viewer.svelte";

/** The parts of a tab a search needs: what to scan, and where to scroll. */
export interface SearchTarget {
  doc: DocStore;
  edits: EditStore;
  view: ViewState;
}

export class SearchStore {
  /**
   * Injected rather than imported: each tab searches its own document and
   * scrolls its own viewer.
   */
  #target: SearchTarget;

  constructor(target: SearchTarget) {
    this.#target = target;
  }

  query = $state("");
  matchCase = $state(false);
  wholeWords = $state(false);
  results = $state.raw<SearchMatch[]>([]);
  activeIndex = $state(-1);
  running = $state(false);

  #abort: AbortController | null = null;

  get active(): SearchMatch | null {
    return this.results[this.activeIndex] ?? null;
  }

  /** Matches on a given planned page, for the overlay to draw. */
  matchesOn(pageIndex: number): SearchMatch[] {
    return this.results.filter((m) => m.pageIndex === pageIndex);
  }

  async run() {
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;

    this.results = [];
    this.activeIndex = -1;

    if (this.query.trim().length === 0) {
      this.running = false;
      return;
    }

    this.running = true;
    const options: SearchOptions = { matchCase: this.matchCase, wholeWords: this.wholeWords };

    try {
      const pages = $state.snapshot(this.#target.edits.pages);
      const iterator = searchDocument(
        pages,
        (id) => this.#target.doc.source(id)?.proxy ?? null,
        this.query,
        options,
        controller.signal,
      );
      for await (const batch of iterator) {
        if (controller.signal.aborted) return;
        this.results = [...this.results, ...batch];
        // Jump to the first hit as soon as there is one.
        if (this.activeIndex === -1) this.goTo(0);
      }
    } finally {
      if (this.#abort === controller) {
        this.running = false;
        this.#abort = null;
      }
    }
  }

  goTo(index: number) {
    if (this.results.length === 0) return;
    const wrapped = ((index % this.results.length) + this.results.length) % this.results.length;
    this.activeIndex = wrapped;
    this.#target.view.goToPage(this.results[wrapped].pageIndex);
  }

  next() {
    this.goTo(this.activeIndex + 1);
  }

  previous() {
    this.goTo(this.activeIndex - 1);
  }

  clear() {
    this.#abort?.abort();
    this.#abort = null;
    this.query = "";
    this.results = [];
    this.activeIndex = -1;
    this.running = false;
  }
}
