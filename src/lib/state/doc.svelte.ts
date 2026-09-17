/**
 * The loaded document(s).
 *
 * Holds everything that comes *out* of a file and is not user-editable: the
 * original bytes, the pdf.js proxies, page geometry and the outline. Editable
 * state (page order, annotations) lives in `edits.svelte.ts`.
 *
 * More than one source document can be open at once: merging another PDF in
 * registers it here under a fresh id, and `PageEntry.sourceDocId` points back.
 *
 * pdf.js proxies and raw byte arrays are held in `$state.raw`. Svelte's deep
 * proxy would wrap the proxies' class instances and break their private-field
 * access, and deep-proxying a multi-megabyte byte array is pure overhead.
 */
import { loadDocument, loadOutline, type OutlineNode, type PDFDocumentProxy, type PDFPageProxy } from "$lib/pdf/pdfjs";
import { pageSize } from "$lib/pdf/render";
import { readFile, recentsAdd, fileMeta } from "$lib/tauri/files";

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

class DocStore {
  /** Source documents by id; `MAIN_DOC` is the file the window represents. */
  sources = $state.raw(new Map<string, SourceDoc>());
  outline = $state.raw<OutlineNode[]>([]);
  /** Set when the opened file was encrypted — saving writes it back decrypted. */
  wasEncrypted = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);

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
  async openMain(bytes: Uint8Array, path: string | null, password?: string): Promise<SourceDoc> {
    await this.close();

    const { doc, wasEncrypted } = await loadDocument(bytes, password);
    const name = path?.split("/").pop() ?? "Untitled.pdf";
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
    this.outline = await loadOutline(doc);
    if (path) void recentsAdd(path).catch(() => {});
    return source;
  }

  /** Register an extra document so its pages can be merged into the plan. */
  async addSource(bytes: Uint8Array, path: string | null): Promise<SourceDoc> {
    const { doc } = await loadDocument(bytes);
    const source: SourceDoc = {
      id: crypto.randomUUID(),
      path,
      name: path?.split("/").pop() ?? "Untitled.pdf",
      bytes,
      proxy: doc,
      pages: await describe(doc),
      managedRefs: new Set(),
    };
    this.sources = new Map(this.sources).set(source.id, source);
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

  /** Point the main document at a new path after Save As. */
  async rebind(path: string) {
    const main = this.main;
    if (!main) return;
    const meta = await fileMeta(path).catch(() => null);
    const next: SourceDoc = { ...main, path, name: meta?.name ?? path.split("/").pop() ?? main.name };
    this.sources = new Map(this.sources).set(MAIN_DOC, next);
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
    this.outline = [];
    this.wasEncrypted = false;
    this.error = null;
    await Promise.all(open.map((s) => s.proxy.loadingTask.destroy().catch(() => {})));
  }
}

export const doc = new DocStore();

/** Read a file from disk and open it as the main document. */
export async function openPath(path: string, password?: string) {
  const bytes = await readFile(path);
  return doc.openMain(bytes, path, password);
}
