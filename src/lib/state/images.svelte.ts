/**
 * Image store backing stamp and signature annotations.
 *
 * Stamp annotations reference an image by id rather than carrying pixels, so
 * placing the same signature twenty times embeds one image. Ids are prefixed
 * `sig:` for saved signatures (persisted under the app data dir), `img:` for
 * one-off image stamps (session-only, but still embedded on save) and `std:`
 * for the built-in stamps, which are regenerated at every launch.
 */
import { renderStandardStamp, STANDARD_STAMPS } from "$lib/stamps";
import {
  signatureDelete,
  signatureRead,
  signatureSave,
  signaturesList,
  readFile,
} from "$lib/tauri/files";

export interface StampImage {
  id: string;
  name: string;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  /** Blob URL for display. Revoked when the entry is dropped. */
  url: string;
  /** Natural pixel size, used to preserve aspect ratio when placing. */
  width: number;
  height: number;
  isSignature: boolean;
}

const mimeFor = (path: string): StampImage["mime"] =>
  /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";

async function measure(bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { ...size, url: URL.createObjectURL(blob) };
}

class ImageStore {
  #items = $state(new Map<string, StampImage>());
  loading = $state(false);

  get all(): StampImage[] {
    return [...this.#items.values()];
  }

  get signatures(): StampImage[] {
    return this.all.filter((i) => i.isSignature);
  }

  /** The built-in stamps. */
  get standard(): StampImage[] {
    return this.all.filter((i) => i.id.startsWith("std:"));
  }

  /** Images the user brought in from disk. */
  get uploaded(): StampImage[] {
    return this.all.filter((i) => !i.isSignature && !i.id.startsWith("std:"));
  }

  get(id: string): StampImage | null {
    return this.#items.get(id) ?? null;
  }

  #put(item: StampImage) {
    const existing = this.#items.get(item.id);
    if (existing) URL.revokeObjectURL(existing.url);
    this.#items = new Map(this.#items).set(item.id, item);
  }

  async #register(
    id: string,
    name: string,
    bytes: Uint8Array,
    mime: StampImage["mime"],
    isSignature: boolean,
  ): Promise<StampImage> {
    const { width, height, url } = await measure(bytes, mime);
    const item: StampImage = { id, name, bytes, mime, url, width, height, isSignature };
    this.#put(item);
    return item;
  }

  /** Load every saved signature. Called once when the app starts. */
  async loadSignatures() {
    this.loading = true;
    try {
      const metas = await signaturesList();
      await Promise.all(
        metas.map(async (meta) => {
          const bytes = await signatureRead(meta.id);
          await this.#register(`sig:${meta.id}`, meta.name, bytes, "image/png", true);
        }),
      );
    } catch {
      // A missing or unreadable signature store just means no saved signatures.
    } finally {
      this.loading = false;
    }
  }

  /**
   * Draw and register the built-in stamps. Called once when the app starts.
   *
   * Session-only by design: they are cheap to redraw and keeping them off disk
   * means a colour change here takes effect without migrating anything.
   */
  async loadStandard() {
    await Promise.all(
      STANDARD_STAMPS.map(async (stamp) => {
        try {
          const bytes = await renderStandardStamp(stamp);
          await this.#register(`std:${stamp.id}`, stamp.label, bytes, "image/png", false);
        } catch (err) {
          // One stamp failing should not cost the user the others, but it
          // should not vanish either — a missing stamp is otherwise invisible.
          console.warn(`could not draw the ${stamp.label} stamp:`, err);
        }
      }),
    );
  }

  /** Persist a freshly drawn signature and register it for immediate use. */
  async saveSignature(name: string, png: Uint8Array): Promise<StampImage> {
    const rawId = crypto.randomUUID();
    const meta = await signatureSave(rawId, name, png);
    return this.#register(`sig:${meta.id}`, meta.name, png, "image/png", true);
  }

  async deleteSignature(id: string) {
    if (!id.startsWith("sig:")) return;
    await signatureDelete(id.slice(4));
    const existing = this.#items.get(id);
    if (existing) URL.revokeObjectURL(existing.url);
    const next = new Map(this.#items);
    next.delete(id);
    this.#items = next;
  }

  /** Load an image file from disk as a session-only stamp. */
  async addFromPath(path: string): Promise<StampImage> {
    const bytes = await readFile(path);
    const name = path.split("/").pop() ?? "Image";
    return this.#register(`img:${crypto.randomUUID()}`, name, bytes, mimeFor(path), false);
  }
}

export const images = new ImageStore();
