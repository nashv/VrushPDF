/**
 * The loaded document(s).
 *
 * Holds everything that comes *out* of a file and is not user-editable: the
 * original bytes, the pdf.js proxies, page geometry and the outline. Editable
 * state (page order, annotations) lives in `edits.svelte.ts`.
 *
 * One instance per open tab. Within a tab more than one source document can be
 * live at once: merging another PDF in registers it here under a fresh id, and
 * `PageEntry.sourceDocId` points back.
 *
 * pdf.js proxies and raw byte arrays are held in `$state.raw`. Svelte's deep
 * proxy would wrap the proxies' class instances and break their private-field
 * access, and deep-proxying a multi-megabyte byte array is pure overhead.
 */
import { blankPdfBytes } from "$lib/annotations/blank";
import type { FieldValues } from "$lib/annotations/fields";
import { loadWidgets, sameValue, storageEntry, type FormWidget } from "$lib/pdf/forms";
import { loadDocument, loadOutline, type OutlineNode, type PDFDocumentProxy, type PDFPageProxy } from "$lib/pdf/pdfjs";
import { pageSize } from "$lib/pdf/render";
import { fileMeta } from "$lib/tauri/files";

import { recents } from "./recents.svelte";

export const MAIN_DOC = "main";

export interface SourceDoc {
  id: string;
  path: string | null;
  name: string;
  bytes: Uint8Array;
  proxy: PDFDocumentProxy;
  /** Unrotated size and intrinsic `/Rotate` of each page, by 0-based index. */
  pages: { width: number; height: number; rotate: number }[];
  /**
   * Object numbers of the annotation dictionaries we imported from this file.
   * Saving drops exactly these and re-emits from the model; everything else in
   * `/Annots` is left untouched.
   */
  managedRefs: Set<number>;
}

async function describe(proxy: PDFDocumentProxy) {
  const pages: SourceDoc["pages"] = [];
  for (let i = 1; i <= proxy.numPages; i++) {
    const page = await proxy.getPage(i);
    pages.push({ ...pageSize(page), rotate: page.rotate });
  }
  return pages;
}

export class DocStore {
  /** Source documents by id; `MAIN_DOC` is the file the window represents. */
  sources = $state.raw(new Map<string, SourceDoc>());
  /** Generated blank-page sources, by `"<width>x<height>"`. */
  #blanks = new Map<string, string>();
  outline = $state.raw<OutlineNode[]>([]);
  /** Set when the opened file was encrypted. */
  wasEncrypted = $state(false);
  /** The password used to open the document, retained to re-encrypt on save. */
  password = $state<string | undefined>(undefined);
  loading = $state(false);
  error = $state<string | null>(null);

  /*
   * Form widgets of the main document, registered page by page as pages load
   * rather than all at once on open, which would parse every page's
   * annotations up front.
   */
  #widgets = new Map<string, FormWidget>();
  #widgetPages = new Map<number, Promise<FormWidget[]>>();
  /** The values last pushed into pdf.js's storage, re-applied to late pages. */
  #fieldValues: FieldValues = {};
  /**
   * Bumped when field values change what a page should draw; the page views
   * re-render on it. Debounced so typing does not re-render every keystroke —
   * the field being typed in hides the canvas beneath it anyway.
   */
  formRevision = $state(0);
  #revisionTimer: ReturnType<typeof setTimeout> | undefined;

  get main(): SourceDoc | null {
    return this.sources.get(MAIN_DOC) ?? null;
  }

  get isOpen(): boolean {
    return this.main !== null;
  }

  get path(): string | null {
    return this.main?.path ?? null;
  }

  get name(): string {
    return this.main?.name ?? "";
  }

  source(id: string): SourceDoc | null {
    return this.sources.get(id) ?? null;
  }

  /** pdf.js caches page proxies internally, so repeat calls are cheap. */
  page(sourceDocId: string, srcIndex: number): Promise<PDFPageProxy> {
    const src = this.sources.get(sourceDocId);
    if (!src) return Promise.reject(new Error(`unknown source document ${sourceDocId}`));
    return src.proxy.getPage(srcIndex + 1);
  }

  /** Replace the main document. Returns the newly registered source. */
  async openMain(
    bytes: Uint8Array,
    path: string | null,
    password?: string,
    displayName?: string,
  ): Promise<SourceDoc> {
    await this.close();

    const { doc, wasEncrypted } = await loadDocument(bytes, password);
    const name = displayName ?? path?.split("/").pop() ?? "Untitled.pdf";
    const source: SourceDoc = {
      id: MAIN_DOC,
      path,
      name,
      bytes,
      proxy: doc,
      pages: await describe(doc),
      managedRefs: new Set(),
    };

    this.sources = new Map([[MAIN_DOC, source]]);
    this.wasEncrypted = wasEncrypted;
    this.password = password;
    this.outline = await loadOutline(doc);
    if (path) void recents.add(path);
    return source;
  }

  /** Register an extra document so its pages can be merged into the plan. */
  async addSource(bytes: Uint8Array, path: string | null, name?: string): Promise<SourceDoc> {
    const { doc } = await loadDocument(bytes);
    const source: SourceDoc = {
      id: crypto.randomUUID(),
      path,
      name: name ?? path?.split("/").pop() ?? "Untitled.pdf",
      bytes,
      proxy: doc,
      pages: await describe(doc),
      managedRefs: new Set(),
    };
    this.sources = new Map(this.sources).set(source.id, source);
    return source;
  }

  /**
   * A source document holding one empty page of the given size.
   *
   * Cached per size, so a document with twenty blank A4 pages carries one
   * generated PDF and one pdf.js instance rather than twenty. Each blank page
   * still gets its own `PageEntry`, and the save path already copies a source
   * page once per plan entry that names it.
   *
   * A cached id that is no longer in `sources` — `pruneSources` drops blanks
   * once the last page using them is deleted — simply regenerates.
   */
  async blankSource(width: number, height: number): Promise<SourceDoc> {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    const cached = this.#blanks.get(key);
    const existing = cached ? this.sources.get(cached) : undefined;
    if (existing) return existing;

    const bytes = await blankPdfBytes(width, height);
    const source = await this.addSource(bytes, null, "blank page");
    this.#blanks.set(key, source.id);
    return source;
  }

  /** Record which of a source's annotation dictionaries we now own. */
  setManagedRefs(sourceDocId: string, refs: Set<number>) {
    const source = this.sources.get(sourceDocId);
    if (!source) return;
    this.sources = new Map(this.sources).set(sourceDocId, { ...source, managedRefs: refs });
  }

  /**
   * Hide annotations from the canvas renderer.
   *
   * Anything we imported into the editable model is drawn by our own overlay,
   * so pdf.js must stop painting it. `noView` in the annotation storage is the
   * supported way to do that (see `pdf/render.ts` for the matching
   * `ENABLE_STORAGE` render mode).
   */
  suppressOnCanvas(sourceDocId: string, annotationIds: string[]) {
    const source = this.sources.get(sourceDocId);
    if (!source || annotationIds.length === 0) return;
    for (const id of annotationIds) {
      source.proxy.annotationStorage.setValue(id, { noView: true });
    }
  }

  /** The main document's fillable widgets on page `srcIndex`. */
  widgetsOn(srcIndex: number): Promise<FormWidget[]> {
    const main = this.main;
    if (!main) return Promise.resolve([]);
    let pending = this.#widgetPages.get(srcIndex);
    if (!pending) {
      pending = main.proxy
        .getPage(srcIndex + 1)
        .then(loadWidgets)
        .then((widgets) => {
          for (const w of widgets) {
            this.#widgets.set(w.id, w);
            this.#applyTo(w);
          }
          if (widgets.some((w) => w.name in this.#fieldValues)) this.#bumpRevision();
          return widgets;
        })
        .catch(() => []);
      this.#widgetPages.set(srcIndex, pending);
    }
    return pending;
  }

  /**
   * Mirror filled-in `values` into pdf.js's annotation storage, so the canvas
   * draws them. A field left at (or returned to) the file's own value is
   * removed rather than stored, so the file's original appearance draws.
   */
  syncFields(values: FieldValues) {
    const before = this.#fieldValues;
    this.#fieldValues = values;
    let changed = false;
    for (const w of this.#widgets.values()) {
      if (sameValue(before[w.name] ?? null, values[w.name] ?? null) && (w.name in before) === (w.name in values)) {
        continue;
      }
      this.#applyTo(w);
      changed = true;
    }
    if (changed) this.#bumpRevision();
  }

  #applyTo(widget: FormWidget) {
    const storage = this.main?.proxy.annotationStorage;
    if (!storage) return;
    const value = this.#fieldValues[widget.name];
    if (value === undefined || sameValue(value, widget.initial)) storage.remove(widget.id);
    else storage.setValue(widget.id, storageEntry(widget, value));
  }

  #bumpRevision() {
    clearTimeout(this.#revisionTimer);
    this.#revisionTimer = setTimeout(() => this.formRevision++, 120);
  }

  /** Drop sources no longer referenced by any page in the plan. */
  async pruneSources(usedIds: Set<string>) {
    const keep = new Map<string, SourceDoc>();
    const drop: SourceDoc[] = [];
    for (const [id, src] of this.sources) {
      if (id === MAIN_DOC || usedIds.has(id)) keep.set(id, src);
      else drop.push(src);
    }
    if (drop.length === 0) return;
    this.sources = keep;
    await Promise.all(drop.map((s) => s.proxy.loadingTask.destroy().catch(() => {})));
  }

  async close() {
    const open = [...this.sources.values()];
    this.sources = new Map();
    this.#blanks.clear();
    this.#widgets.clear();
    this.#widgetPages.clear();
    this.#fieldValues = {};
    this.outline = [];
    this.wasEncrypted = false;
    this.password = undefined;
    this.error = null;
    await Promise.all(open.map((s) => s.proxy.loadingTask.destroy().catch(() => {})));
  }
}
