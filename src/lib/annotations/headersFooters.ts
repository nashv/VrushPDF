/**
 * Header, footer, and Bates numbering generation for PDF documents.
 */
import { DEFAULT_AUTHOR, newId, type FreeTextAnnot, type FontFamily, type PageEntry } from "./types";
import { parsePageRange } from "./split";

export interface HeaderFooterOptions {
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
  fontFamily?: FontFamily;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  margin?: number; // Margin from page edges in points (default: 24)
  pageRange?: "all" | "odd" | "even" | "custom";
  customRange?: string;
  batesPrefix?: string;
  batesStart?: number;
  batesDigits?: number;
}

export function generateHeadersFooters(
  pages: PageEntry[],
  dimsGetter: (page: PageEntry) => { width: number; height: number },
  docTitle: string,
  options: HeaderFooterOptions,
): FreeTextAnnot[] {
  const {
    headerLeft = "",
    headerCenter = "",
    headerRight = "",
    footerLeft = "",
    footerCenter = "",
    footerRight = "",
    fontFamily = "Helvetica",
    fontSize = 10,
    color = "#374151",
    bold = false,
    italic = false,
    margin = 24,
    pageRange = "all",
    customRange = "",
    batesPrefix = "",
    batesStart = 1,
    batesDigits = 6,
  } = options;

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

  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();
  const annots: FreeTextAnnot[] = [];

  const slotHeight = Math.max(16, fontSize * 1.5);

  targetIndices.forEach((pageIdx, sequenceIdx) => {
    const page = pages[pageIdx];
    if (!page) return;
    const dims = dimsGetter(page);
    const availableWidth = Math.max(100, dims.width - margin * 2);
    const slotWidth = availableWidth / 3;

    const pageNum = pageIdx + 1;
    const batesNum = (batesStart + sequenceIdx).toString().padStart(batesDigits, "0");
    const batesStr = `${batesPrefix}${batesNum}`;

    const formatTemplate = (template: string) => {
      return template
        .replace(/\{page\}/gi, String(pageNum))
        .replace(/\{pages\}/gi, String(totalPages))
        .replace(/\{date\}/gi, today)
        .replace(/\{title\}/gi, docTitle.replace(/\.pdf$/i, ""))
        .replace(/\{bates\}/gi, batesStr);
    };

    const slots: { text: string; x: number; y: number; align: "left" | "center" | "right" }[] = [
      // Headers (top of page: y = height - margin - slotHeight)
      {
        text: formatTemplate(headerLeft),
        x: margin,
        y: dims.height - margin - slotHeight,
        align: "left",
      },
      {
        text: formatTemplate(headerCenter),
        x: margin + slotWidth,
        y: dims.height - margin - slotHeight,
        align: "center",
      },
      {
        text: formatTemplate(headerRight),
        x: margin + slotWidth * 2,
        y: dims.height - margin - slotHeight,
        align: "right",
      },
      // Footers (bottom of page: y = margin)
      {
        text: formatTemplate(footerLeft),
        x: margin,
        y: margin,
        align: "left",
      },
      {
        text: formatTemplate(footerCenter),
        x: margin + slotWidth,
        y: margin,
        align: "center",
      },
      {
        text: formatTemplate(footerRight),
        x: margin + slotWidth * 2,
        y: margin,
        align: "right",
      },
    ];

    for (const slot of slots) {
      if (!slot.text.trim()) continue;

      annots.push({
        id: newId(),
        pageId: page.id,
        kind: "freetext",
        color,
        opacity: 1,
        contents: "",
        author: DEFAULT_AUTHOR,
        createdAt: now,
        modifiedAt: now,
        text: slot.text,
        fontSize,
        fontFamily,
        bold,
        italic,
        align: slot.align,
        rect: {
          x: slot.x,
          y: slot.y,
          w: slotWidth,
          h: slotHeight,
        },
        bgColor: null,
        borderColor: null,
        borderWidth: 0,
        padding: 0,
      });
    }
  });

  return annots;
}
