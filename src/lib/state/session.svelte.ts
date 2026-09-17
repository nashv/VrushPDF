/**
 * Document-level actions: open, save, save-as, merge, close.
 *
 * Components call into here rather than coordinating the individual stores, so
 * the ordering rules (import before reset, suppress before first render) live
 * in one place.
 */
import { importAnnots } from "$lib/annotations/import";
import { buildSavedPdf, type SourceBytes } from "$lib/annotations/save";
import type { ImageSource } from "$lib/annotations/write";
import { PasswordRequired } from "$lib/pdf/pdfjs";
import {
  pickImage,
  pickPdfToOpen,
  pickSaveTarget,
  readFile,
  writeFile,
} from "$lib/tauri/files";

import { doc, MAIN_DOC } from "./doc.svelte";
import { edits, planFor } from "./edits.svelte";
import { images } from "./images.svelte";
import { search } from "./search.svelte";
import { viewer } from "./viewer.svelte";

export interface Toast {
  id: string;
  kind: "info" | "error";
  message: string;
}

class Session {
  busy = $state<string | null>(null);
  toasts = $state<Toast[]>([]);
  /** Set when the open file needs a password; holds the path to retry. */
  passwordFor = $state<string | null>(null);
  passwordWrong = $state(false);

  notify(message: string, kind: Toast["kind"] = "info") {
    const toast: Toast = { id: crypto.randomUUID(), kind, message };
    this.toasts = [...this.toasts, toast];
    setTimeout(() => this.dismiss(toast.id), kind === "error" ? 8000 : 4000);
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  async #withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    this.busy = label;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PasswordRequired) throw err;
      this.notify(err instanceof Error ? err.message : String(err), "error");
      return null;
    } finally {
      this.busy = null;
    }
  }

  // ---------------------------------------------------------------- opening

  async openPath(path: string, password?: string) {
    try {
      await this.#withBusy("Opening…", async () => {
        const bytes = await readFile(path);
        const source = await doc.openMain(bytes, path, password);

        // Build the plan first: imported annotations attach to plan page ids.
        const pages = planFor(source);
        const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

        doc.setManagedRefs(MAIN_DOC, managedRefs);
        doc.suppressOnCanvas(MAIN_DOC, suppress);

        edits.reset(pages, annots);
        viewer.reset();
        search.clear();
        images.clearTransient();

        this.passwordFor = null;
        this.passwordWrong = false;
      });
    } catch (err) {
      if (err instanceof PasswordRequired) {
        this.passwordFor = path;
        this.passwordWrong = err.wrongPassword;
        return;
      }
      throw err;
    }
  }

  async openViaDialog() {
    const picked = await pickPdfToOpen(false);
    if (picked?.[0]) await this.openPath(picked[0]);
  }

  async close() {
    await doc.close();
    edits.reset([], []);
    viewer.reset();
    search.clear();
    images.clearTransient();
  }

  // ----------------------------------------------------------------- saving

  #sourceBytes = (id: string): SourceBytes | null => {
    const source = doc.source(id);
    return source ? { bytes: source.bytes, managedRefs: source.managedRefs } : null;
  };

  #resolveImage = (id: string): ImageSource | null => {
    const item = images.get(id);
    return item ? { id: item.id, bytes: item.bytes, mime: item.mime } : null;
  };

  async #writeTo(path: string) {
    const result = await buildSavedPdf({
      pages: $state.snapshot(edits.pages),
      annots: $state.snapshot(edits.annots),
      mainDocId: MAIN_DOC,
      getSource: this.#sourceBytes,
      resolveImage: this.#resolveImage,
    });

    await writeFile(path, result.bytes);
    return result;
  }

  /**
   * Save over the open file.
   *
   * The document is then reopened from what was written, so the editable model
   * is backed by the bytes on disk — without that, a second save would replay
   * stale `managedRefs` against a file whose object numbers have changed.
   */
  async save(): Promise<boolean> {
    const path = doc.path;
    if (!path) return this.saveAs();

    const done = await this.#withBusy("Saving…", async () => {
      const result = await this.#writeTo(path);
      await this.#reopenAfterSave(path);

      const detail = result.strategy === "rebuilt" ? " (document rebuilt)" : "";
      this.notify(`Saved ${result.annotationsWritten} annotation(s)${detail}.`);
      if (result.annotationsSkipped > 0) {
        this.notify(`${result.annotationsSkipped} stamp(s) had no image and were skipped.`, "error");
      }
      return true;
    });

    return done === true;
  }

  async saveAs(): Promise<boolean> {
    const suggested = doc.name || "Untitled.pdf";
    const target = await pickSaveTarget(suggested);
    if (!target) return false;

    const done = await this.#withBusy("Saving…", async () => {
      const result = await this.#writeTo(target);
      await this.#reopenAfterSave(target);
      this.notify(`Saved ${result.annotationsWritten} annotation(s) to ${target.split("/").pop()}.`);
      return true;
    });

    return done === true;
  }

  /**
   * Reload the just-written file, preserving where the user was.
   *
   * Annotation ids survive because they are written to `/NM` and read back by
   * the importer, so the selection and the annotation list stay stable.
   */
  async #reopenAfterSave(path: string) {
    const page = viewer.currentPage;
    const zoom = viewer.zoom;
    const tool = viewer.tool;
    const selected = edits.selectedId;

    const bytes = await readFile(path);
    const source = await doc.openMain(bytes, path);
    const pages = planFor(source);
    const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

    doc.setManagedRefs(MAIN_DOC, managedRefs);
    doc.suppressOnCanvas(MAIN_DOC, suppress);

    edits.reset(pages, annots);
    edits.markSaved();

    viewer.zoom = zoom;
    viewer.tool = tool;
    viewer.currentPage = Math.min(page, Math.max(pages.length - 1, 0));
    if (selected && annots.some((a) => a.id === selected)) edits.select(selected);

    search.clear();
    viewer.goToPage(viewer.currentPage);
  }

  // ------------------------------------------------------------ page sources

  /** Merge another PDF's pages into the plan at `at`. */
  async mergePdf(at: number) {
    const picked = await pickPdfToOpen(false);
    const path = picked?.[0];
    if (!path) return;

    await this.#withBusy("Merging…", async () => {
      const bytes = await readFile(path);
      const source = await doc.addSource(bytes, path);

      const pages = planFor(source);
      const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

      doc.setManagedRefs(source.id, managedRefs);
      doc.suppressOnCanvas(source.id, suppress);

      edits.commit(`Insert ${source.name}`, () => {
        edits.pages.splice(Math.max(0, Math.min(at, edits.pages.length)), 0, ...pages);
        edits.annots.push(...annots);
      });

      this.notify(`Inserted ${pages.length} page(s) from ${source.name}.`);
    });
  }

  /** Load an image from disk and arm the stamp tool with it. */
  async addImageStamp() {
    const path = await pickImage();
    if (!path) return;
    await this.#withBusy("Loading image…", async () => {
      const image = await images.addFromPath(path);
      // Order matters: `setTool` clears any armed stamp.
      viewer.setTool("stamp");
      viewer.pendingStamp = image.id;
    });
  }
}

export const session = new Session();
