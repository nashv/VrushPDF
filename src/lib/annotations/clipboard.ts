/**
 * Copy and paste of annotations.
 *
 * The copy goes on the system clipboard under a private MIME type, beside a
 * plain-text rendering for other apps. A copy is also held here: some webviews
 * drop private types, and the page's context menu pastes without a clipboard
 * event at all. The held copy only counts while the system clipboard still has
 * the plain text we wrote, so copying something else in another app wins.
 */
import {
  annotBounds,
  isFreeText,
  newId,
  translateAnnot,
  type Annot,
  type Point,
} from "./types";

export const ANNOT_MIME = "application/x-vrushpdf-annotations";

/** How far each repeated paste onto the same page steps, in points. */
const PASTE_STEP = 12;

interface Held {
  annots: Annot[];
  text: string;
  /** Pastes so far per target page, for the cascading offset. */
  pastes: Map<string, number>;
}

let held: Held | null = null;

/**
 * Deep copy. Annotations are plain JSON data, and the live ones are Svelte
 * state proxies, which `structuredClone` refuses.
 */
const clone = (annots: Annot[]): Annot[] => JSON.parse(JSON.stringify(annots));

function plainText(annots: Annot[]): string {
  const parts = annots.map((a) => (isFreeText(a) ? a.text : a.contents)).filter((t) => t.trim());
  return parts.length > 0 ? parts.join("\n") : `[${annots.length} PDF annotation${annots.length === 1 ? "" : "s"}]`;
}

/** Put `annots` on the clipboard; `data` is the copy event's, when there is one. */
export function copyAnnots(annots: Annot[], data?: DataTransfer | null) {
  if (annots.length === 0) return;
  const copies = clone(annots);
  const text = plainText(copies);
  held = { annots: copies, text, pastes: new Map() };
  if (data) {
    data.setData(ANNOT_MIME, JSON.stringify(copies));
    data.setData("text/plain", text);
  } else {
    // No copy event (the context menu): still claim the system clipboard, or
    // a later ⌘V would see stale text there and refuse the held copy.
    void globalThis.navigator?.clipboard?.writeText(text).catch(() => {});
  }
}

/** True when a context-menu paste has something to paste. */
export const hasHeldAnnots = () => held !== null;

/**
 * The annotations a paste should insert, or null when the clipboard holds
 * something else. Without `data` (a context-menu paste) the held copy is used.
 */
export function readAnnots(data?: DataTransfer | null): Annot[] | null {
  if (data) {
    const raw = data.getData(ANNOT_MIME);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Annot[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // Fall through to the held copy.
      }
    }
    if (!held || data.getData("text/plain") !== held.text) return null;
  }
  return held ? clone(held.annots) : null;
}

/**
 * Fresh copies of `annots` on `pageId`. At `at`, the group's top-left lands
 * there; otherwise repeated pastes cascade down and right so they don't hide
 * one another or the original.
 */
export function placeAnnots(annots: Annot[], pageId: string, at?: Point): Annot[] {
  if (annots.length === 0) return [];
  const now = new Date().toISOString();
  const boxes = annots.map(annotBounds);
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.max(...boxes.map((b) => b.y + b.h));

  let dx = 0;
  let dy = 0;
  if (at) {
    dx = at.x - left;
    dy = at.y - top;
  } else {
    const fromSamePage = annots[0].pageId === pageId;
    const count = held?.pastes.get(pageId) ?? (fromSamePage ? 1 : 0);
    held?.pastes.set(pageId, count + 1);
    dx = PASTE_STEP * count;
    dy = -PASTE_STEP * count;
  }

  return annots.map((a) => {
    const { sourceRef: _dropped, ...rest } = translateAnnot(a, dx, dy);
    return { ...rest, id: newId(), pageId, createdAt: now, modifiedAt: now } as Annot;
  });
}
