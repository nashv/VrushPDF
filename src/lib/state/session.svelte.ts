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
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PDFDocument } from "pdf-lib";

import { DEFAULT_PAGE_SIZE } from "$lib/annotations/blank";
import { importAnnots } from "$lib/annotations/import";
import { optimizePdf, type OptimizeOptions } from "$lib/annotations/optimize";
import { addOcrText, embedOcrFont, markOcrProducer, type OcrWord } from "$lib/annotations/ocrText";
import { applyRedactionsToDocument, type RedactTarget } from "$lib/annotations/redact";
import { replaceWithImage } from "$lib/annotations/replacePage";
import { buildSavedPdf, type SourceBytes } from "$lib/annotations/save";
import { isRedact, isStamp, rectFromQuad, transformAnnot, type Annot, type PageEntry } from "$lib/annotations/types";
import type { ImageSource } from "$lib/annotations/write";
import { pageHasText, recognizePage, type OcrLanguage } from "$lib/ocr/engine";
import { blankJpegRegions } from "$lib/pdf/imageEdit";
import { PasswordRequired } from "$lib/pdf/pdfjs";
import type { NormQuad } from "$lib/scan/analysis";
import { correctPage, measureSkew, MIN_SKEW_DEGREES, type Correction, type CorrectedPage } from "$lib/scan/correct";
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
  /** True while the optimize dialog is up. */
  optimizeOpen = $state(false);
  /** True while the settings dialog is up. */
  settingsOpen = $state(false);
  /** True while the split & extract dialog is up. */
  splitOpen = $state(false);
  /** True while the watermark dialog is up. */
  watermarkOpen = $state(false);
  /** True while the header & footer dialog is up. */
  headerFooterOpen = $state(false);
  /** True while the command palette is up. */
  commandPaletteOpen = $state(false);
  /** True while the OCR dialog is up. */
  ocrOpen = $state(false);
  /** Set while a cancellable job runs; the busy indicator shows a Cancel button. */
  cancelBusy = $state<(() => void) | null>(null);

  /** True while the straighten-pages dialog is up. */
  straightenOpen = $state(false);
  /** The page whose corners are being placed for perspective correction. */
  perspective = $state<{ tab: DocumentTab; pageId: string } | null>(null);

  openStraightenDialog() {
    this.straightenOpen = true;
  }

  closeStraightenDialog() {
    this.straightenOpen = false;
  }

  /** Show corner handles on a page (the current one by default). */
  startPerspective(tab: DocumentTab, pageIndex = tab.view.currentPage) {
    const entry = tab.edits.pages[pageIndex];
    if (!entry || !license.allow("Correcting perspective")) return;
    viewer.setTool("select");
    this.perspective = { tab, pageId: entry.id };
  }

  cancelPerspective() {
    this.perspective = null;
  }

  openOcrDialog() {
    this.ocrOpen = true;
  }

  closeOcrDialog() {
    this.ocrOpen = false;
  }

  openSplitDialog() {
    this.splitOpen = true;
  }

  closeSplitDialog() {
    this.splitOpen = false;
  }

  openWatermarkDialog() {
    this.watermarkOpen = true;
  }

  closeWatermarkDialog() {
    this.watermarkOpen = false;
  }

  openHeaderFooterDialog() {
    this.headerFooterOpen = true;
  }

  closeHeaderFooterDialog() {
    this.headerFooterOpen = false;
  }

  openCommandPalette() {
    this.commandPaletteOpen = true;
  }

  closeCommandPalette() {
    this.commandPaletteOpen = false;
  }

  toggleCommandPalette() {
    this.commandPaletteOpen = !this.commandPaletteOpen;
  }

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

  /** Open raw PDF bytes in a fresh or specified tab. */
  async openBytes(bytes: Uint8Array, displayName: string = "Untitled.pdf", options: { tab?: DocumentTab } = {}) {
    const tab = options.tab ?? workspace.tabForOpen();
    workspace.activate(tab.id);

    await this.#withBusy("Opening…", async () => {
      const source = await tab.doc.openMain(bytes, null, undefined, displayName);
      const pages = planFor(source);
      const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

      tab.doc.setManagedRefs(MAIN_DOC, managedRefs);
      tab.doc.suppressOnCanvas(MAIN_DOC, suppress);

      tab.edits.reset(pages, annots);
      tab.search.clear();
    });
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
    try {
      await invoke("exit_app");
    } catch {
      await getCurrentWindow().destroy().catch(() => {});
    }
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

  /** Permanently apply and sanitize all pending redactions on the tab. */
  async applyRedactions(target?: DocumentTab): Promise<boolean> {
    const tab = target ?? workspace.active;
    if (!tab?.isOpen) return false;

    const redactions = tab.edits.annots.filter(isRedact);
    if (redactions.length === 0) {
      this.notify("No pending redactions to apply.");
      return false;
    }

    const count = redactions.length;
    const ok = await this.#withBusy("Applying redactions…", async () => {
      const buildResult = await buildSavedPdf({
        pages: $state.snapshot(tab.edits.pages),
        annots: $state.snapshot(tab.edits.annots),
        mainDocId: MAIN_DOC,
        getSource: this.#sourceBytes(tab),
        resolveImage: this.#resolveImage,
        fields: $state.snapshot(tab.edits.fields),
      });

      const pageIndexMap = new Map<string, number>();
      tab.edits.pages.forEach((p, idx) => {
        pageIndexMap.set(p.id, idx);
      });

      const pageRedactions: { pageIndex: number; targets: RedactTarget[] }[] = [];
      const redactionsByPageIndex = new Map<number, RedactTarget[]>();

      for (const redact of redactions) {
        const pageIdx = pageIndexMap.get(redact.pageId);
        if (pageIdx === undefined) continue;
        const list = redactionsByPageIndex.get(pageIdx) ?? [];
        // A text selection over several lines is one box per line: their
        // union would also take the unselected ends of the first and last.
        const boxes = redact.quads?.length ? redact.quads.map(rectFromQuad) : [redact.rect];
        boxes.forEach((rect, i) =>
          list.push({ rect, fillColor: redact.fillColor, overlayText: i === 0 ? redact.overlayText : undefined }),
        );
        redactionsByPageIndex.set(pageIdx, list);
      }

      for (const [pageIndex, targets] of redactionsByPageIndex.entries()) {
        pageRedactions.push({ pageIndex, targets });
      }

      const sanitized = await applyRedactionsToDocument({
        docBytes: buildResult.bytes,
        pageRedactions,
        editImage: blankJpegRegions,
      });

      await this.#reloadTransformed(tab, sanitized.bytes);

      // Say plainly when something was removed whole rather than precisely.
      const notes: string[] = [];
      if (sanitized.imagesRemoved > 0) {
        notes.push(`${sanitized.imagesRemoved} image(s) under the boxes couldn't be edited and were removed entirely.`);
      }
      if (sanitized.runsRemovedWhole > 0) {
        notes.push("Some text in a font that couldn't be measured was removed as whole runs.");
      }
      this.notify(
        `Permanently applied ${count} redaction(s): the content under them is removed from the file.${notes.length ? ` ${notes.join(" ")}` : ""}`,
      );
      return true;
    });

    return ok === true;
  }

  /**
   * Make pages searchable: OCR them and add the text as an invisible layer.
   *
   * Like applying redactions, this rewrites the document: the current edits
   * are built into a PDF, the text layer is added to it, and the result is
   * reopened as the tab's (unsaved) document. pdf.js then sees the new text
   * like any other, so search, selection and copy work with no extra code.
   * `pageIndices` are plan indices.
   */
  async makeSearchable(
    tab: DocumentTab,
    options: { pageIndices: number[]; langs: OcrLanguage[]; skipPagesWithText: boolean },
  ): Promise<boolean> {
    if (!tab.isOpen || options.pageIndices.length === 0) return false;
    if (!license.allow("Making a document searchable")) return false;

    let cancelled = false;
    this.cancelBusy = () => {
      cancelled = true;
    };

    try {
      const done = await this.#withBusy("Recognising text…", async () => {
        const found = new Map<number, OcrWord[]>();
        let skipped = 0;
        const total = options.pageIndices.length;

        for (const [n, index] of options.pageIndices.entries()) {
          if (cancelled) return "cancelled";
          const entry = tab.edits.pages[index];
          if (!entry) continue;
          const page = await tab.doc.page(entry.sourceDocId, entry.srcIndex);
          if (options.skipPagesWithText && (await pageHasText(page))) {
            skipped++;
            continue;
          }
          const label = total > 1 ? `Recognising text… page ${index + 1} (${n + 1} of ${total})` : "Recognising text…";
          this.busy = label;
          const result = await recognizePage(page, entry.rotation, options.langs, (f) => {
            this.busy = `${label} ${Math.round(f * 100)}%`;
          });
          if (result.words.length > 0) found.set(index, result.words);
        }
        if (cancelled) return "cancelled";

        if (found.size === 0) {
          this.notify(
            skipped > 0
              ? `No text added: ${skipped} page(s) already had text, and no text was found on the rest.`
              : "No text was found on the selected pages.",
          );
          return "nothing";
        }

        this.busy = "Adding the text layer…";
        // Past this point the document is rewritten, so cancelling stops here.
        this.cancelBusy = null;
        const built = await buildSavedPdf({
          pages: $state.snapshot(tab.edits.pages),
          annots: $state.snapshot(tab.edits.annots),
          mainDocId: MAIN_DOC,
          getSource: this.#sourceBytes(tab),
          resolveImage: this.#resolveImage,
          fields: $state.snapshot(tab.edits.fields),
        });
        const doc = await PDFDocument.load(built.bytes, { ignoreEncryption: true, updateMetadata: false });
        const font = await embedOcrFont(doc);
        let words = 0;
        for (const [index, pageWords] of found) {
          words += addOcrText(doc, doc.getPage(index), pageWords, font);
        }
        markOcrProducer(doc);
        await this.#reloadTransformed(tab, await doc.save());

        const extra = skipped > 0 ? ` ${skipped} page(s) already had text and were left alone.` : "";
        this.notify(`Made ${found.size} page(s) searchable: ${words} words recognised.${extra}`);
        return "done";
      });
      if (done === "cancelled") this.notify("Text recognition cancelled. The document was not changed.");
      return done === "done";
    } finally {
      this.cancelBusy = null;
    }
  }

  /**
   * Straighten tilted scans. Each page's tilt is measured; pages already
   * level (under 0.1°) are left alone. `pageIndices` are plan indices.
   */
  async straightenPages(
    tab: DocumentTab,
    options: { pageIndices: number[]; reOcr: boolean; langs: OcrLanguage[] },
  ): Promise<boolean> {
    if (!tab.isOpen || options.pageIndices.length === 0) return false;
    if (!license.allow("Straightening pages")) return false;

    let cancelled = false;
    this.cancelBusy = () => {
      cancelled = true;
    };
    let jobs: { pageIndex: number; correction: Correction }[] | null;
    try {
      jobs = await this.#withBusy("Measuring tilt…", async () => {
        const found: { pageIndex: number; correction: Correction }[] = [];
        for (const [n, index] of options.pageIndices.entries()) {
          if (cancelled) return null;
          const entry = tab.edits.pages[index];
          if (!entry) continue;
          this.busy = `Measuring tilt… page ${index + 1} (${n + 1} of ${options.pageIndices.length})`;
          const page = await tab.doc.page(entry.sourceDocId, entry.srcIndex);
          const degrees = await measureSkew(page, entry.rotation);
          if (Math.abs(degrees) >= MIN_SKEW_DEGREES) found.push({ pageIndex: index, correction: { kind: "deskew", degrees } });
        }
        return found;
      });
    } finally {
      this.cancelBusy = null;
    }
    if (cancelled) {
      this.notify("Straightening cancelled. The document was not changed.");
      return false;
    }
    if (!jobs) return false;
    if (jobs.length === 0) {
      this.notify("Those pages are already straight.");
      return false;
    }

    const ok = await this.#applyCorrections(tab, jobs, "Straightening pages…");
    if (!ok) return false;
    const angles = jobs.map((j) => (j.correction.kind === "deskew" ? `${j.correction.degrees.toFixed(1)}°` : "")).join(", ");
    const skipped = options.pageIndices.length - jobs.length;
    this.notify(
      `Straightened ${jobs.length} page(s) (${angles}).${skipped > 0 ? ` ${skipped} were already straight.` : ""}`,
    );
    if (options.reOcr) {
      await this.makeSearchable(tab, { pageIndices: jobs.map((j) => j.pageIndex), langs: options.langs, skipPagesWithText: false });
    }
    return true;
  }

  /** Warp the page's document, marked by `quad`, onto an upright sheet. */
  async correctPerspective(
    tab: DocumentTab,
    pageId: string,
    quad: NormQuad,
    options: { reOcr: boolean; langs: OcrLanguage[] },
  ): Promise<boolean> {
    const pageIndex = tab.edits.pageIndexOf(pageId);
    if (!tab.isOpen || pageIndex < 0) return false;
    this.perspective = null;
    const ok = await this.#applyCorrections(tab, [{ pageIndex, correction: { kind: "perspective", quad } }], "Correcting perspective…");
    if (!ok) return false;
    this.notify(`Corrected the perspective of page ${pageIndex + 1}.`);
    if (options.reOcr) {
      await this.makeSearchable(tab, { pageIndices: [pageIndex], langs: options.langs, skipPagesWithText: false });
    }
    return true;
  }

  /**
   * Render each page's correction and rewrite the document with the new page
   * images. Annotations on those pages move with their content. Like OCR and
   * redaction, the result is reopened as the tab's unsaved document.
   */
  async #applyCorrections(
    tab: DocumentTab,
    jobs: { pageIndex: number; correction: Correction }[],
    label: string,
  ): Promise<boolean> {
    const done = await this.#withBusy(label, async () => {
      const corrected = new Map<number, CorrectedPage>();
      for (const [n, job] of jobs.entries()) {
        const entry = tab.edits.pages[job.pageIndex];
        if (!entry) continue;
        if (jobs.length > 1) this.busy = `${label.replace(/…$/, "")} page ${job.pageIndex + 1} (${n + 1} of ${jobs.length})…`;
        const page = await tab.doc.page(entry.sourceDocId, entry.srcIndex);
        corrected.set(job.pageIndex, await correctPage(page, entry.rotation, job.correction));
      }

      this.busy = "Writing the corrected pages…";
      const pages = $state.snapshot(tab.edits.pages);
      const byPageId = new Map([...corrected].map(([index, result]) => [pages[index].id, result]));
      const annots = ($state.snapshot(tab.edits.annots) as Annot[]).map((a) => {
        const result = byPageId.get(a.pageId);
        return result ? transformAnnot(a, result.mapPoint) : a;
      });

      const built = await buildSavedPdf({
        pages,
        annots,
        mainDocId: MAIN_DOC,
        getSource: this.#sourceBytes(tab),
        resolveImage: this.#resolveImage,
        fields: $state.snapshot(tab.edits.fields),
      });
      const doc = await PDFDocument.load(built.bytes, { ignoreEncryption: true, updateMetadata: false });
      for (const [index, result] of corrected) {
        await replaceWithImage(doc, doc.getPage(index), result.image, result.width, result.height);
      }
      await this.#reloadTransformed(tab, await doc.save());
      return true;
    });
    return done === true;
  }

  /**
   * Reopen `bytes`, a rewritten version of the tab's document, as its unsaved
   * current state, keeping the user's place. Undo history starts over: the
   * rewrite cannot be stepped back through.
   */
  async #reloadTransformed(tab: DocumentTab, bytes: Uint8Array) {
    const page = tab.view.currentPage;
    const zoom = tab.view.zoom;
    const scrollTop = tab.view.scrollTop;

    const source = await tab.doc.openMain(bytes, tab.doc.path, tab.doc.password, tab.doc.name);
    const pages = planFor(source);
    const { annots, suppress, managedRefs } = await importAnnots(bytes, pages);

    tab.doc.setManagedRefs(MAIN_DOC, managedRefs);
    tab.doc.suppressOnCanvas(MAIN_DOC, suppress);

    tab.edits.reset(pages, annots);
    tab.edits.dirty = true;

    tab.view.zoom = zoom;
    tab.view.scrollTop = scrollTop;
    tab.view.currentPage = Math.min(page, Math.max(pages.length - 1, 0));

    tab.search.clear();
    tab.view.goToPage(tab.view.currentPage);
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

  openOptimizeDialog() {
    if (!license.allow("Optimizing PDFs")) return;
    this.optimizeOpen = true;
  }

  closeOptimizeDialog() {
    this.optimizeOpen = false;
  }

  async optimize(options: OptimizeOptions, targetPath?: string): Promise<boolean> {
    const tab = workspace.active;
    if (!tab?.isOpen) return false;
    if (!license.allow("Optimizing PDFs")) return false;

    let destination = targetPath;
    if (!destination) {
      let defaultName = tab.doc.name || "Untitled.pdf";
      const base = defaultName.replace(/\.pdf$/i, "");
      defaultName = `${base}_optimized.pdf`;
      const chosen = await pickSaveTarget(defaultName);
      if (!chosen) return false;
      destination = chosen;
    }

    const done = await this.#withBusy("Optimizing PDF…", async () => {
      const source = tab.doc.source(MAIN_DOC);
      if (!source) throw new Error("no document open");

      const intermediate = await buildSavedPdf({
        pages: $state.snapshot(tab.edits.pages),
        annots: $state.snapshot(tab.edits.annots),
        mainDocId: MAIN_DOC,
        getSource: this.#sourceBytes(tab),
        resolveImage: this.#resolveImage,
        fields: $state.snapshot(tab.edits.fields),
      });

      const optResult = await optimizePdf({
        docBytes: intermediate.bytes,
        options,
        pages: $state.snapshot(tab.edits.pages),
        annots: $state.snapshot(tab.edits.annots),
        fields: $state.snapshot(tab.edits.fields),
        resolveImage: this.#resolveImage,
      });

      await writeFile(destination!, optResult.bytes, tab.doc.password);
      await this.#reopenAfterSave(tab, destination!);

      const origMb = (optResult.originalSize / (1024 * 1024)).toFixed(2);
      const optMb = (optResult.optimizedSize / (1024 * 1024)).toFixed(2);

      this.notify(
        `Optimized: Reduced from ${origMb}MB to ${optMb}MB (${optResult.savedPercentage}% saved).`,
      );
      return true;
    });

    return done === true;
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
