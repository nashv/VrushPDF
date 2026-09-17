/** Search box state and the running scan. */
import { searchDocument, type SearchMatch, type SearchOptions } from "$lib/pdf/search";
import { doc } from "./doc.svelte";
import { edits } from "./edits.svelte";
import { viewer } from "./viewer.svelte";

class SearchStore {
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
      const pages = $state.snapshot(edits.pages);
      const iterator = searchDocument(
        pages,
        (id) => doc.source(id)?.proxy ?? null,
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
    viewer.goToPage(this.results[wrapped].pageIndex);
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

export const search = new SearchStore();
