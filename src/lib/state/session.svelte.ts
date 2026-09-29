/**
 * Document-level actions: open, save, save-as, merge, close.
 *
 * Components call into here rather than coordinating the individual stores, so
 * the ordering rules (import before reset, suppress before first render) live
 * in one place.
 *
 * Everything document-shaped operates on a `DocumentTab`; toasts, the busy
 * indicator and the modal prompts are app-wide because only one of each can be
 * on screen at a time.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DEFAULT_PAGE_SIZE } from "$lib/annotations/blank";
import { importAnnots } from "$lib/annotations/import";
import { buildSavedPdf, type SourceBytes } from "$lib/annotations/save";
import { isStamp, type Annot, type PageEntry } from "$lib/annotations/types";
import type { ImageSource } from "$lib/annotations/write";
import { PasswordRequired } from "$lib/pdf/pdfjs";
import { printPdf } from "$lib/pdf/print";
import {
  pickImage,
  pickPdfToOpen,
  pickSaveTarget,
  readFile,
  writeFile,
} from "$lib/tauri/files";

import { MAIN_DOC } from "./doc.svelte";
import { planFor } from "./edits.svelte";
import { images } from "./images.svelte";
import { license } from "./license.svelte";
import { settings } from "./settings.svelte";
import { viewer } from "./viewer.svelte";
import { workspace, type DocumentTab } from "./workspace.svelte";

export interface Toast {
  id: string;
  kind: "info" | "error";
  message: string;
}

/** A pending "you have unsaved changes" prompt, awaiting the user's answer. */
export interface CloseRequest {
  tab: DocumentTab;
  resolve: (choice: "save" | "discard" | "cancel") => void;
}

/** A pending unflattened signature warning prompt, awaiting user choice. */
export interface SignatureWarningRequest {
  tab: DocumentTab;
  action: "save" | "saveAs";
  resolve: (choice: "flatten" | "unflatten" | "cancel") => void;
}

/** "3 annotation(s) and 2 form field(s)", leaving out whichever is none. */
function summary(result: { annotationsWritten: number; fieldsWritten: number }): string {
  const parts = [`${result.annotationsWritten} annotation(s)`];
  if (result.fieldsWritten > 0) parts.push(`${result.fieldsWritten} form field(s)`);
  return parts.join(" and ");
}

class Session {
  busy = $state<string | null>(null);
  toasts = $state<Toast[]>([]);

  /** Set when a file needs a password; holds the path and tab to retry with. */
  passwordFor = $state<string | null>(null);
  passwordWrong = $state(false);
  #passwordTab: DocumentTab | null = null;

  /** Non-null while the unsaved-changes dialog is up. */
  closeRequest = $state<CloseRequest | null>(null);
  /** Non-null while the unflattened-signature warning dialog is up. */
  signatureWarningRequest = $state<SignatureWarningRequest | null>(null);

  /** True while the merge dialog is up. */
  mergeOpen = $state(false);
  /** True while the settings dialog is up. */
  settingsOpen = $state(false);

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

  /** Load `path` into `tab` (a fresh or reusable tab by default). */
  async openPath(path: string, options: { tab?: DocumentTab; password?: string } = {}) {
    const tab = options.tab ?? workspace.tabForOpen();
    workspace.activate(tab.id);

    try {
      await this.#withBusy("Opening…", async () => {
        const bytes = await readFile(path);
        const source = await tab.doc.openMain(bytes, path, options.password);

        // Build the plan first: imported annotations attach to plan page ids.
        const pages = planFor(source);
        const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

        tab.doc.setManagedRefs(MAIN_DOC, managedRefs);
        tab.doc.suppressOnCanvas(MAIN_DOC, suppress);

        tab.edits.reset(pages, annots);
        tab.search.clear();

        this.passwordFor = null;
        this.passwordWrong = false;
        this.#passwordTab = null;
      });
    } catch (err) {
      if (err instanceof PasswordRequired) {
        this.passwordFor = path;
        this.passwordWrong = err.wrongPassword;
        this.#passwordTab = tab;
        return;
      }
      throw err;
    }
  }

  /** Retry the pending encrypted file with a password. */
  async submitPassword(password: string) {
    const path = this.passwordFor;
    if (!path) return;
    await this.openPath(path, { tab: this.#passwordTab ?? undefined, password });
  }

  cancelPassword() {
    const tab = this.#passwordTab;
    this.passwordFor = null;
    this.passwordWrong = false;
    this.#passwordTab = null;
    // A tab opened solely for this file has nothing in it; don't strand it.
    if (tab && !tab.isOpen && workspace.count > 1) void workspace.close(tab.id);
  }

  /** Open one or more paths, each in its own tab. */
  async openPaths(paths: string[]) {
    for (const path of paths) {
      await this.openPath(path);
    }
  }

  async openViaDialog() {
    const picked = await pickPdfToOpen(true);
    if (picked?.length) await this.openPaths(picked);
  }

  // ---------------------------------------------------------------- closing

  /**
   * Close a tab, prompting first if it has unsaved work.
   *
   * Returns false if the user cancelled, so callers closing several tabs (like
   * a window-close) can stop.
   */
  async requestClose(tab: DocumentTab): Promise<boolean> {
    if (!tab.dirty) {
      await workspace.close(tab.id);
      return true;
    }

    workspace.activate(tab.id);
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
      this.closeRequest = { tab, resolve };
    });
    this.closeRequest = null;

    if (choice === "cancel") return false;
    if (choice === "save" && !(await this.save(tab))) return false;

    await workspace.close(tab.id);
    return true;
  }

  /** Close every tab, prompting per dirty document. False if cancelled. */
  async requestCloseAll(): Promise<boolean> {
    for (const tab of [...workspace.tabs]) {
      if (!(await this.requestClose(tab))) return false;
    }
    return true;
  }

  answerClose(choice: "save" | "discard" | "cancel") {
    this.closeRequest?.resolve(choice);
  }

  /**
   * Quit, prompting for every dirty document first.
   *
   * Both ways out of the app come through here — the window's close button and
   * the Quit menu item — because the native Quit item would otherwise terminate
   * the process without ever asking about unsaved annotations.
   */
  async requestQuit() {
    if (!(await this.requestCloseAll())) return;
    await getCurrentWindow().destroy();
  }

  // ----------------------------------------------------------------- saving

  #sourceBytes = (tab: DocumentTab) => (id: string): SourceBytes | null => {
    const source = tab.doc.source(id);
    return source ? { bytes: source.bytes, managedRefs: source.managedRefs } : null;
  };

  #resolveImage = (id: string): ImageSource | null => {
    const item = images.get(id);
    return item ? { id: item.id, bytes: item.bytes, mime: item.mime } : null;
  };

  answerSignatureWarning(choice: "flatten" | "unflatten" | "cancel") {
    const req = this.signatureWarningRequest;
    this.signatureWarningRequest = null;
    req?.resolve(choice);
  }

  #tabHasSignature(tab: DocumentTab): boolean {
    return tab.edits.annots.some(
      (a) => isStamp(a) && (a.isSignature || a.imageId.startsWith("sig:")),
    );
  }

  async #promptSignatureWarning(
    tab: DocumentTab,
    action: "save" | "saveAs",
  ): Promise<"flatten" | "unflatten" | "cancel"> {
    return new Promise((resolve) => {
      this.signatureWarningRequest = { tab, action, resolve };
    });
  }

  async #writeTo(tab: DocumentTab, path: string, options: { flatten?: boolean } = {}) {
    const result = await buildSavedPdf({
      pages: $state.snapshot(tab.edits.pages),
      annots: $state.snapshot(tab.edits.annots),
      mainDocId: MAIN_DOC,
      getSource: this.#sourceBytes(tab),
      resolveImage: this.#resolveImage,
      fields: $state.snapshot(tab.edits.fields),
      flatten: options.flatten,
    });

    await writeFile(path, result.bytes, tab.doc.password);
    return result;
  }

  /**
   * Save over the tab's file.
   *
   * The document is then reopened from what was written, so the editable model
   * is backed by the bytes on disk — without that, a second save would replay
   * stale `managedRefs` against a file whose object numbers have changed.
   */
  async save(
    target?: DocumentTab,
    options: { flatten?: boolean; skipWarning?: boolean } = {},
  ): Promise<boolean> {
    const tab = target ?? workspace.active;
    if (!tab) return false;

    if (!license.allow("Saving")) return false;
    const path = tab.doc.path;
    if (!path) return this.saveAs(tab, options);

    let flatten = options.flatten ?? false;
    if (!flatten && !options.skipWarning && this.#tabHasSignature(tab) && settings.warnUnflattenedSignatures) {
      const choice = await this.#promptSignatureWarning(tab, "save");
      if (choice === "cancel") return false;
      if (choice === "flatten") flatten = true;
    }

    const done = await this.#withBusy("Saving…", async () => {
      const result = await this.#writeTo(tab, path, { flatten });
      await this.#reopenAfterSave(tab, path);

      const detail = flatten
        ? " (flattened)"
        : result.strategy === "rebuilt"
          ? " (document rebuilt)"
          : "";
      this.notify(`Saved ${summary(result)}${detail}.`);
      if (result.fieldsFailed.length > 0) {
        this.notify(`Could not fill in ${result.fieldsFailed.join(", ")}.`, "error");
      }
      if (result.annotationsSkipped > 0) {
        this.notify(`${result.annotationsSkipped} stamp(s) had no image and were skipped.`, "error");
      }
      return true;
    });

    return done === true;
  }

  async saveAs(
    target?: DocumentTab,
    options: { flatten?: boolean; skipWarning?: boolean } = {},
  ): Promise<boolean> {
    const tab = target ?? workspace.active;
    if (!tab) return false;

    if (!license.allow("Saving")) return false;

    let flatten = options.flatten ?? false;
    if (!flatten && !options.skipWarning && this.#tabHasSignature(tab) && settings.warnUnflattenedSignatures) {
      const choice = await this.#promptSignatureWarning(tab, "saveAs");
      if (choice === "cancel") return false;
      if (choice === "flatten") flatten = true;
    }

    let defaultName = tab.doc.name || "Untitled.pdf";
    if (flatten && !defaultName.toLowerCase().includes("flattened")) {
      const base = defaultName.replace(/\.pdf$/i, "");
      defaultName = `${base}_flattened.pdf`;
    }

    const chosen = await pickSaveTarget(defaultName);
    if (!chosen) return false;

    const done = await this.#withBusy("Saving…", async () => {
      const result = await this.#writeTo(tab, chosen, { flatten });
      await this.#reopenAfterSave(tab, chosen);
      const detail = flatten ? " (flattened)" : "";
      this.notify(`Saved ${summary(result)}${detail} to ${chosen.split("/").pop()}.`);
      return true;
    });

    return done === true;
  }

  /** Save as a flattened file where annotations and form fields are merged into page graphics. */
  async saveFlattened(target?: DocumentTab): Promise<boolean> {
    return this.saveAs(target, { flatten: true, skipWarning: true });
  }

  /** Print the current document with all edits and forms applied. */
  async print(target?: DocumentTab): Promise<void> {
    const tab = target ?? workspace.active;
    if (!tab?.isOpen) return;

    await this.#withBusy("Preparing to print…", async () => {
      const result = await buildSavedPdf({
        pages: $state.snapshot(tab.edits.pages),
        annots: $state.snapshot(tab.edits.annots),
        mainDocId: MAIN_DOC,
        getSource: this.#sourceBytes(tab),
        resolveImage: this.#resolveImage,
        fields: $state.snapshot(tab.edits.fields),
      });

      const title = tab.doc.name || "Document";
      await printPdf(result.bytes, title);
    });
  }

  /**
   * Reload the just-written file, preserving where the user was.
   *
   * Annotation ids survive because they are written to `/NM` and read back by
   * the importer, so the selection and the annotation list stay stable.
   */
  async #reopenAfterSave(tab: DocumentTab, path: string) {
    const page = tab.view.currentPage;
    const zoom = tab.view.zoom;
    const scrollTop = tab.view.scrollTop;
    const selected = tab.edits.selectedId;

    const bytes = await readFile(path);
    const source = await tab.doc.openMain(bytes, path, tab.doc.password);
    const pages = planFor(source);
    const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

    tab.doc.setManagedRefs(MAIN_DOC, managedRefs);
    tab.doc.suppressOnCanvas(MAIN_DOC, suppress);

    tab.edits.reset(pages, annots);
    tab.edits.markSaved();

    tab.view.zoom = zoom;
    tab.view.scrollTop = scrollTop;
    tab.view.currentPage = Math.min(page, Math.max(pages.length - 1, 0));
    if (selected && annots.some((a) => a.id === selected)) tab.edits.select(selected);

    tab.search.clear();
    tab.view.goToPage(tab.view.currentPage);
  }

  // ------------------------------------------------------------ page sources

  /** Merge another PDF's pages into the active tab's plan at `at`. */
  async mergePdf(at: number) {
    const tab = workspace.active;
    if (!tab || !license.allow("Inserting pages")) return;

    const picked = await pickPdfToOpen(false);
    const path = picked?.[0];
    if (!path) return;

    await this.#withBusy("Merging…", async () => {
      const bytes = await readFile(path);
      const source = await tab.doc.addSource(bytes, path);

      const pages = planFor(source);
      const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

      tab.doc.setManagedRefs(source.id, managedRefs);
      tab.doc.suppressOnCanvas(source.id, suppress);

      const insertAt = Math.max(0, Math.min(at, tab.edits.pages.length));
      tab.edits.commit(`Insert ${source.name}`, () => {
        tab.edits.pages.splice(insertAt, 0, ...pages);
        tab.edits.annots.push(...annots);
      });

      this.notify(`Inserted ${pages.length} page(s) from ${source.name}.`);
      tab.view.goToPage(insertAt);
    });
  }

  // ------------------------------------------------------------------ merging

  openMergeDialog() {
    if (!license.allow("Merging PDFs")) return;
    this.mergeOpen = true;
  }

  closeMergeDialog() {
    this.mergeOpen = false;
  }

  openSettings() {
    this.settingsOpen = true;
  }

  closeSettings() {
    this.settingsOpen = false;
  }

  /**
   * Combine several PDFs, in the given order, into one new document.
   *
   * The result deliberately has **no path**. `openMain` would otherwise bind
   * the tab to the first input, and Save would quietly overwrite a file the
   * user was merging *from*. It is also marked dirty: `reset` clears that flag,
   * and a merge that has never been written anywhere must not close without
   * asking.
   */
  async mergeFiles(paths: string[]) {
    // Builds its result with `reset`, not `commit`, so it needs its own gate.
    if (paths.length === 0 || !license.allow("Merging PDFs")) return;

    // Reuse an empty tab rather than stranding one behind the merge.
    const tab = workspace.tabForOpen();
    workspace.activate(tab.id);

    await this.#withBusy("Merging…", async () => {
      const pages: PageEntry[] = [];
      const annots: Annot[] = [];

      for (const [index, path] of paths.entries()) {
        const bytes = await readFile(path);
        const source =
          index === 0
            ? await tab.doc.openMain(bytes, null, undefined, "Merged.pdf")
            : await tab.doc.addSource(bytes, path);

        const filePages = planFor(source);
        const imported = await importAnnots(bytes, filePages);

        tab.doc.setManagedRefs(source.id, imported.managedRefs);
        tab.doc.suppressOnCanvas(source.id, imported.suppress);

        pages.push(...filePages);
        annots.push(...imported.annots);
      }

      tab.edits.reset(pages, annots);
      tab.edits.dirty = true;
      tab.search.clear();
      tab.view.goToPage(0);

      this.notify(`Merged ${paths.length} file(s) into ${pages.length} page(s).`);
    });
  }

  /** Merge another PDF onto the end of the active document. */
  async appendPdf() {
    const tab = workspace.active;
    if (tab) await this.mergePdf(tab.edits.pages.length);
  }

  /**
   * Insert one empty page, sized to match the page it follows.
   *
   * The blank comes from a generated source document rather than a special kind
   * of page entry, so rotation, annotation and saving all treat it as an
   * ordinary page. `displayDims` accounts for rotation, so a blank inserted
   * after a landscape page is landscape too.
   */
  async addBlankPage(at?: number) {
    const tab = workspace.active;
    if (!tab?.isOpen || !license.allow("Adding pages")) return;

    const index = Math.max(0, Math.min(at ?? tab.insertAt, tab.edits.pages.length));
    const neighbour = tab.edits.pages[index - 1] ?? tab.edits.pages[index] ?? null;
    const { width, height } = neighbour ? tab.edits.displayDims(neighbour) : DEFAULT_PAGE_SIZE;

    await this.#withBusy("Adding page…", async () => {
      const source = await tab.doc.blankSource(width, height);
      const [page] = planFor(source);

      tab.edits.commit("Insert blank page", () => {
        tab.edits.pages.splice(index, 0, page);
      });
      tab.view.goToPage(index);
    });
  }

  /** Load an image from disk and arm the stamp tool with it. */
  async addImageStamp() {
    if (!license.allow("Stamping")) return;
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
