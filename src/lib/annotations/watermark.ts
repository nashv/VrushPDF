/**
 * Batch watermarking generator for PDF documents.
 */
import { DEFAULT_AUTHOR, newId, type FreeTextAnnot, type FontFamily, type PageEntry } from "./types";
import { parsePageRange } from "./split";

export interface WatermarkOptions {
  text: string;
  fontFamily?: FontFamily;
  fontSize?: number;
  color?: string;
  opacity?: number;
  rotation?: number; // degrees, e.g. 45, 0, -45
  position?: "center" | "diagonal" | "top" | "bottom";
  pageRange?: "all" | "odd" | "even" | "custom";
  customRange?: string;
}

export function generateWatermarks(
  pages: PageEntry[],
  dimsGetter: (page: PageEntry) => { width: number; height: number },
  options: WatermarkOptions,
): FreeTextAnnot[] {
  const {
    text,
    fontFamily = "Helvetica",
    fontSize = 48,
    color = "#dc2626",
    opacity = 0.25,
    pageRange = "all",
    customRange = "",
    position = "center",
  } = options;

  if (!text.trim()) return [];

  const totalPages = pages.length;
  let targetIndices: number[] = [];

  if (pageRange === "all") {
    targetIndices = pages.map((_, i) => i);
  } else if (pageRange === "odd") {
    targetIndices = pages.flatMap((_, i) => (i % 2 === 0 ? [i] : []));
  } else if (pageRange === "even") {
    targetIndices = pages.flatMap((_, i) => (i % 2 === 1 ? [i] : []));
  } else if (pageRange === "custom") {
    targetIndices = parsePageRange(customRange, totalPages);
  }

  const now = new Date().toISOString();
  const annots: FreeTextAnnot[] = [];

  for (const pageIdx of targetIndices) {
    const page = pages[pageIdx];
    if (!page) continue;
    const dims = dimsGetter(page);

    // Calculate bounding box centered or positioned on page
    const boxWidth = Math.min(dims.width * 0.85, 480);
    const boxHeight = Math.max(fontSize * 2, 80);

    let x = (dims.width - boxWidth) / 2;
    let y = (dims.height - boxHeight) / 2;

    if (position === "top") {
      y = dims.height - boxHeight - 40;
    } else if (position === "bottom") {
      y = 40;
    }

    annots.push({
      id: newId(),
      pageId: page.id,
      kind: "freetext",
      color,
      opacity,
      contents: "",
      author: DEFAULT_AUTHOR,
      createdAt: now,
      modifiedAt: now,
      text: text.trim(),
      fontSize,
      fontFamily,
      bold: true,
      italic: false,
      align: "center",
      rect: {
        x,
        y,
        w: boxWidth,
        h: boxHeight,
      },
      bgColor: null,
      borderColor: null,
      borderWidth: 0,
      padding: 4,
    });
  }

  return annots;
}
