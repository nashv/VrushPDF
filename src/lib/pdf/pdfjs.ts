/**
 * pdf.js bootstrap.
 *
 * The worker and the CMap / standard-font tables are all served from the bundle
 * (see `scripts/copy-pdfjs-assets.mjs`) so the app never reaches for a CDN and
 * works fully offline.
 */
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };

/** Thrown when a document needs a password we don't have yet. */
export class PasswordRequired extends Error {
  constructor(public readonly wrongPassword: boolean) {
    super(wrongPassword ? "Incorrect password" : "This PDF is password protected");
    this.name = "PasswordRequired";
  }
}

export interface LoadedDoc {
  doc: PDFDocumentProxy;
  /** True when the source file was encrypted, so saving will write it decrypted. */
  wasEncrypted: boolean;
}

/**
 * Load a PDF from bytes.
 *
 * pdf.js transfers the buffer it is handed to the worker, which detaches it on
 * the main thread. We always pass a copy so callers can keep using the original
 * bytes — the save path needs them for the incremental-update fast path.
 */
export async function loadDocument(bytes: Uint8Array, password?: string): Promise<LoadedDoc> {
  let wasEncrypted = false;

  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });

  task.onPassword = (_updatePassword: (p: string) => void, reason: number) => {
    wasEncrypted = true;
    throw new PasswordRequired(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
  };

  try {
    const doc = await task.promise;
    return { doc, wasEncrypted: wasEncrypted || password !== undefined };
  } catch (err) {
    if (err instanceof PasswordRequired) throw err;
    if (err instanceof pdfjs.PasswordException) {
      throw new PasswordRequired(err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    }
    if (err instanceof pdfjs.InvalidPDFException) {
      throw new Error("That file isn't a readable PDF.");
    }
    throw err;
  }
}

export interface OutlineNode {
  title: string;
  /** Resolved 0-based page index, or `null` when the destination can't be resolved. */
  pageIndex: number | null;
  children: OutlineNode[];
}

/** Flatten pdf.js's outline into a tree with destinations resolved to page indices. */
export async function loadOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw) return [];

  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      return await doc.getPageIndex(explicit[0] as never);
    } catch {
      return null;
    }
  };

  const walk = async (items: typeof raw): Promise<OutlineNode[]> =>
    Promise.all(
      items.map(async (item) => ({
        title: item.title,
        pageIndex: await resolve(item.dest),
        children: item.items?.length ? await walk(item.items) : [],
      })),
    );

  return walk(raw);
}
