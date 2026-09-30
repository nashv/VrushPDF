/**
 * Comprehensive PDF optimization and compression engine.
 *
 * Implements high-resolution image downsampling, JPEG re-compression,
 * annotation/form flattening, object pruning, standard font stripping,
 * and PDF 1.5+ Object Stream (/ObjStm) dictionary compaction.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";

import { optimizeImage } from "../tauri/files";
import { flattenAnnots, prepareWrite, type ImageSource } from "./write";
import type { Annot, PageEntry } from "./types";
import { applyFieldValues, type FieldValues } from "./fields";

export interface ImageOptimizationOptions {
  enabled: boolean;
  /** Downsample images if their resolution is higher than this DPI (e.g. 150, 225, 300) */
  maxDpi: number;
  /** Target resolution in DPI to downsample to (e.g. 72, 150, 300) */
  targetDpi: number;
  /** JPEG compression quality (0.1 to 1.0, e.g. 0.75) */
  jpegQuality: number;
  /** Re-compress images to JPEG when beneficial */
  convertToJpeg: boolean;
  /** Downsample monochrome/1-bit images */
  downsampleMonochrome: boolean;
  monochromeTargetDpi: number;
}

export interface DiscardObjectsOptions {
  /** Flatten annotations into base page contents */
  flattenAnnotations: boolean;
  /** Discard all annotations completely */
  discardAnnotations: boolean;
  /** Flatten form fields into base page contents */
  flattenFormFields: boolean;
  /** Discard document embedded thumbnail images (/Thumb) */
  discardThumbnails: boolean;
  /** Discard document bookmarks & outlines (/Outlines) */
  discardOutlines: boolean;
  /** Discard document structure tags (/StructTreeRoot) */
  discardStructTree: boolean;
  /** Discard XML metadata & private application data (/Metadata) */
  discardMetadata: boolean;
  /** Discard embedded file attachments */
  discardEmbeddedFiles: boolean;
}

export interface FontOptimizationOptions {
  /** Unembed standard 14 fonts (Helvetica, Times, Courier, etc.) */
  unembedStandardFonts: boolean;
  /** Optimize/clean font descriptor streams */
  optimizeFontStreams: boolean;
}

export interface CleanUpOptions {
  /** Enable Object Streams (/ObjStm) to pack indirect objects (PDF 1.5+) */
  useObjectStreams: boolean;
  /** Apply Flate compression to all content streams */
  compressStreams: boolean;
}

export type OptimizePreset = "custom" | "standard" | "high_compression" | "print" | "clean_only";

export interface OptimizeOptions {
  preset: OptimizePreset;
  images: ImageOptimizationOptions;
  discard: DiscardObjectsOptions;
  fonts: FontOptimizationOptions;
  cleanUp: CleanUpOptions;
}

export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = {
  preset: "standard",
  images: {
    enabled: true,
    maxDpi: 225,
    targetDpi: 150,
    jpegQuality: 0.75,
    convertToJpeg: true,
    downsampleMonochrome: false,
    monochromeTargetDpi: 300,
  },
  discard: {
    flattenAnnotations: false,
    discardAnnotations: false,
    flattenFormFields: false,
    discardThumbnails: true,
    discardOutlines: false,
    discardStructTree: false,
    discardMetadata: false,
    discardEmbeddedFiles: false,
  },
  fonts: {
    unembedStandardFonts: false,
    optimizeFontStreams: true,
  },
  cleanUp: {
    useObjectStreams: true,
    compressStreams: true,
  },
};

export const PRESETS: Record<OptimizePreset, OptimizeOptions> = {
  standard: {
    preset: "standard",
    images: {
      enabled: true,
      maxDpi: 225,
      targetDpi: 150,
      jpegQuality: 0.75,
      convertToJpeg: true,
      downsampleMonochrome: false,
      monochromeTargetDpi: 300,
    },
    discard: {
      flattenAnnotations: false,
      discardAnnotations: false,
      flattenFormFields: false,
      discardThumbnails: true,
      discardOutlines: false,
      discardStructTree: false,
      discardMetadata: false,
      discardEmbeddedFiles: false,
    },
    fonts: {
      unembedStandardFonts: false,
      optimizeFontStreams: true,
    },
    cleanUp: {
      useObjectStreams: true,
      compressStreams: true,
    },
  },
  high_compression: {
    preset: "high_compression",
    images: {
      enabled: true,
      maxDpi: 140,
      targetDpi: 72,
      jpegQuality: 0.55,
      convertToJpeg: true,
      downsampleMonochrome: true,
      monochromeTargetDpi: 150,
    },
    discard: {
      flattenAnnotations: true,
      discardAnnotations: false,
      flattenFormFields: true,
      discardThumbnails: true,
      discardOutlines: false,
      discardStructTree: true,
      discardMetadata: true,
      discardEmbeddedFiles: true,
    },
    fonts: {
      unembedStandardFonts: true,
      optimizeFontStreams: true,
    },
    cleanUp: {
      useObjectStreams: true,
      compressStreams: true,
    },
  },
  print: {
    preset: "print",
    images: {
      enabled: true,
      maxDpi: 450,
      targetDpi: 300,
      jpegQuality: 0.9,
      convertToJpeg: false,
      downsampleMonochrome: false,
      monochromeTargetDpi: 600,
    },
    discard: {
      flattenAnnotations: false,
      discardAnnotations: false,
      flattenFormFields: false,
      discardThumbnails: false,
      discardOutlines: false,
      discardStructTree: false,
      discardMetadata: false,
      discardEmbeddedFiles: false,
    },
    fonts: {
      unembedStandardFonts: false,
      optimizeFontStreams: false,
    },
    cleanUp: {
      useObjectStreams: true,
      compressStreams: true,
    },
  },
  clean_only: {
    preset: "clean_only",
    images: {
      enabled: false,
      maxDpi: 300,
      targetDpi: 150,
      jpegQuality: 0.8,
      convertToJpeg: false,
      downsampleMonochrome: false,
      monochromeTargetDpi: 300,
    },
    discard: {
      flattenAnnotations: false,
      discardAnnotations: false,
      flattenFormFields: false,
      discardThumbnails: true,
      discardOutlines: false,
      discardStructTree: false,
      discardMetadata: false,
      discardEmbeddedFiles: false,
    },
    fonts: {
      unembedStandardFonts: false,
      optimizeFontStreams: true,
    },
    cleanUp: {
      useObjectStreams: true,
      compressStreams: true,
    },
  },
  custom: {
    ...DEFAULT_OPTIMIZE_OPTIONS,
    preset: "custom",
  },
};

export interface PdfAudit {
  originalSize: number;
  pageCount: number;
  imageCount: number;
  totalImageBytes: number;
  fontCount: number;
  embeddedFontCount: number;
  annotationCount: number;
  formFieldCount: number;
  hasOutlines: boolean;
  hasStructTree: boolean;
  hasThumbnails: boolean;
  hasMetadata: boolean;
}

export interface OptimizeRequest {
  docBytes: Uint8Array;
  options: OptimizeOptions;
  pages?: PageEntry[];
  annots?: Annot[];
  fields?: FieldValues;
  resolveImage?: (id: string) => ImageSource | null;
}

export interface OptimizeResult {
  bytes: Uint8Array;
  originalSize: number;
  optimizedSize: number;
  savedBytes: number;
  savedPercentage: number;
  imagesOptimized: number;
  fontsUnembedded: number;
  objectsDiscarded: number;
}

const STANDARD_14_FONTS = new Set([
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats",
]);

function getStreamBytes(obj: PDFRawStream | PDFStream): Uint8Array {
  if (obj instanceof PDFRawStream) {
    return obj.contents;
  }
  const anyObj = obj as unknown as { contents?: Uint8Array; getContents?: () => Uint8Array };
  return anyObj.contents ?? anyObj.getContents?.() ?? new Uint8Array();
}

/**
 * Scan a PDF document and return structural statistics for the Optimizer dialog.
 */
export async function auditPdf(bytes: Uint8Array): Promise<PdfAudit> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const originalSize = bytes.length;
  const pageCount = doc.getPageCount();

  let imageCount = 0;
  let totalImageBytes = 0;
  let fontCount = 0;
  let embeddedFontCount = 0;
  let hasThumbnails = false;

  for (const page of doc.getPages()) {
    if (page.node.has(PDFName.of("Thumb"))) {
      hasThumbnails = true;
    }
  }

  const entries = doc.context.enumerateIndirectObjects();
  for (const [, obj] of entries) {
    if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
      const subtype = obj.dict.get(PDFName.of("Subtype"));
      if (subtype === PDFName.of("Image")) {
        imageCount++;
        totalImageBytes += getStreamBytes(obj).length;
      }
    } else if (obj instanceof PDFDict) {
      const type = obj.get(PDFName.of("Type"));
      if (type === PDFName.of("Font")) {
        fontCount++;
        const descRef = obj.get(PDFName.of("FontDescriptor"));
        if (descRef) {
          const desc = descRef instanceof PDFRef ? doc.context.lookup(descRef) : descRef;
          if (desc instanceof PDFDict) {
            if (
              desc.has(PDFName.of("FontFile")) ||
              desc.has(PDFName.of("FontFile2")) ||
              desc.has(PDFName.of("FontFile3"))
            ) {
              embeddedFontCount++;
            }
          }
        }
      }
    }
  }

  let annotationCount = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.get(PDFName.of("Annots"));
    if (annots instanceof PDFArray) {
      annotationCount += annots.size();
    }
  }

  let formFieldCount = 0;
  try {
    const form = doc.getForm();
    formFieldCount = form.getFields().length;
  } catch {
    // Form absent
  }

  const hasOutlines = doc.catalog.has(PDFName.of("Outlines"));
  const hasStructTree = doc.catalog.has(PDFName.of("StructTreeRoot"));
  const hasMetadata = doc.catalog.has(PDFName.of("Metadata"));

  return {
    originalSize,
    pageCount,
    imageCount,
    totalImageBytes,
    fontCount,
    embeddedFontCount,
    annotationCount,
    formFieldCount,
    hasOutlines,
    hasStructTree,
    hasThumbnails,
    hasMetadata,
  };
}

/**
 * Executes PDF optimization according to provided configuration options.
 */
export async function optimizePdf(request: OptimizeRequest): Promise<OptimizeResult> {
  const { docBytes, options } = request;
  const originalSize = docBytes.length;

  const doc = await PDFDocument.load(docBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  let imagesOptimized = 0;
  let fontsUnembedded = 0;
  let objectsDiscarded = 0;

  // 1. Process and attach annotations/form fields if provided
  if (request.pages && request.annots && request.resolveImage) {
    const ctx = await prepareWrite(doc, request.annots, request.resolveImage);
    const pages = doc.getPages();
    const byPage = new Map<string, Annot[]>();
    for (const a of request.annots) {
      const list = byPage.get(a.pageId);
      if (list) list.push(a);
      else byPage.set(a.pageId, [a]);
    }

    for (let i = 0; i < request.pages.length && i < pages.length; i++) {
      const entry = request.pages[i];
      const page = pages[i];
      const pageAnnots = byPage.get(entry.id) ?? [];
      if (options.discard.flattenAnnotations) {
        flattenAnnots(ctx, page, pageAnnots);
      }
    }
  }

  if (request.fields) {
    await applyFieldValues(doc, request.fields);
  }

  // 2. Discard and flatten objects
  if (options.discard.flattenFormFields || options.discard.flattenAnnotations) {
    try {
      const form = doc.getForm();
      form.flatten();
      objectsDiscarded++;
    } catch {
      // Form was absent or already flattened
    }
  }

  if (options.discard.discardAnnotations) {
    for (const page of doc.getPages()) {
      if (page.node.has(PDFName.of("Annots"))) {
        page.node.delete(PDFName.of("Annots"));
        objectsDiscarded++;
      }
    }
  }

  if (options.discard.discardThumbnails) {
    for (const page of doc.getPages()) {
      if (page.node.has(PDFName.of("Thumb"))) {
        page.node.delete(PDFName.of("Thumb"));
        objectsDiscarded++;
      }
    }
  }

  if (options.discard.discardOutlines) {
    if (doc.catalog.has(PDFName.of("Outlines"))) {
      doc.catalog.delete(PDFName.of("Outlines"));
      objectsDiscarded++;
    }
  }

  if (options.discard.discardStructTree) {
    if (doc.catalog.has(PDFName.of("StructTreeRoot"))) {
      doc.catalog.delete(PDFName.of("StructTreeRoot"));
      objectsDiscarded++;
    }
  }

  if (options.discard.discardMetadata) {
    if (doc.catalog.has(PDFName.of("Metadata"))) {
      doc.catalog.delete(PDFName.of("Metadata"));
      objectsDiscarded++;
    }
    if (doc.catalog.has(PDFName.of("PieceInfo"))) {
      doc.catalog.delete(PDFName.of("PieceInfo"));
      objectsDiscarded++;
    }
  }

  if (options.discard.discardEmbeddedFiles) {
    const names = doc.catalog.get(PDFName.of("Names"));
    if (names instanceof PDFDict && names.has(PDFName.of("EmbeddedFiles"))) {
      names.delete(PDFName.of("EmbeddedFiles"));
      objectsDiscarded++;
    }
  }

  // 3. Font Optimization
  if (options.fonts.unembedStandardFonts) {
    const entries = doc.context.enumerateIndirectObjects();
    for (const [, obj] of entries) {
      if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font")) {
        const baseFontName = obj.get(PDFName.of("BaseFont"));
        if (baseFontName instanceof PDFName) {
          const fontStr = baseFontName.asString().replace(/^\//, "");
          const isStandard =
            STANDARD_14_FONTS.has(fontStr) ||
            Array.from(STANDARD_14_FONTS).some((sf) => fontStr.endsWith(sf));
          if (isStandard) {
            const descRef = obj.get(PDFName.of("FontDescriptor"));
            if (descRef) {
              const desc = descRef instanceof PDFRef ? doc.context.lookup(descRef) : descRef;
              if (desc instanceof PDFDict) {
                let stripped = false;
                if (desc.has(PDFName.of("FontFile"))) {
                  desc.delete(PDFName.of("FontFile"));
                  stripped = true;
                }
                if (desc.has(PDFName.of("FontFile2"))) {
                  desc.delete(PDFName.of("FontFile2"));
                  stripped = true;
                }
                if (desc.has(PDFName.of("FontFile3"))) {
                  desc.delete(PDFName.of("FontFile3"));
                  stripped = true;
                }
                if (stripped) fontsUnembedded++;
              }
            }
          }
        }
      }
    }
  }

  // 4. Image Downsampling & Re-compression
  if (options.images.enabled) {
    const entries = doc.context.enumerateIndirectObjects();
    for (const [ref, obj] of entries) {
      if ((obj instanceof PDFRawStream || obj instanceof PDFStream) && obj.dict) {
        const subtype = obj.dict.get(PDFName.of("Subtype"));
        if (subtype === PDFName.of("Image")) {
          const widthObj = obj.dict.get(PDFName.of("Width"));
          const heightObj = obj.dict.get(PDFName.of("Height"));
          const curW = widthObj instanceof PDFNumber ? widthObj.asNumber() : 0;
          const curH = heightObj instanceof PDFNumber ? heightObj.asNumber() : 0;
          if (curW <= 0 || curH <= 0) continue;

          // Estimate effective display resolution assuming standard page dimensions (612x792 pt)
          const effectiveDpi = Math.max(72, Math.round((curW / 612) * 72));
          const shouldDownsample = effectiveDpi > options.images.maxDpi;

          let targetW = curW;
          let targetH = curH;
          if (shouldDownsample) {
            const scale = options.images.targetDpi / effectiveDpi;
            targetW = Math.max(16, Math.round(curW * scale));
            targetH = Math.max(16, Math.round(curH * scale));
          }

          // If downsampling or converting to JPEG
          if (shouldDownsample || options.images.convertToJpeg) {
            const filter = obj.dict.get(PDFName.of("Filter"));
            const colorSpace = obj.dict.get(PDFName.of("ColorSpace"));
            const csStr = colorSpace instanceof PDFName ? colorSpace.asString() : "rgb";
            const currentBytes = getStreamBytes(obj);
            if (currentBytes.length === 0) continue;

            const optimized = await optimizeImage({
              bytes: currentBytes,
              target_width: targetW,
              target_height: targetH,
              quality: Math.round(options.images.jpegQuality * 100),
              format: "jpeg",
              color_space: csStr,
              original_width: curW,
              original_height: curH,
            });

            if (optimized && optimized.length > 0 && (shouldDownsample || optimized.length < currentBytes.length)) {
              obj.dict.set(PDFName.of("Width"), PDFNumber.of(targetW));
              obj.dict.set(PDFName.of("Height"), PDFNumber.of(targetH));
              obj.dict.set(PDFName.of("Length"), PDFNumber.of(optimized.length));
              obj.dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
              obj.dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
              obj.dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
              obj.dict.delete(PDFName.of("DecodeParms"));

              const newStream = PDFRawStream.of(obj.dict, optimized);
              doc.context.assign(ref, newStream);
              imagesOptimized++;
            }
          }
        }
      }
    }
  }

  // 5. Serialize with Object Streams and Flate Compression
  const bytes = await doc.save({
    useObjectStreams: options.cleanUp.useObjectStreams,
    updateFieldAppearances: false,
  });

  const optimizedSize = bytes.length;
  const savedBytes = Math.max(0, originalSize - optimizedSize);
  const savedPercentage = originalSize > 0 ? Math.round((savedBytes / originalSize) * 100) : 0;

  return {
    bytes,
    originalSize,
    optimizedSize,
    savedBytes,
    savedPercentage,
    imagesOptimized,
    fontsUnembedded,
    objectsDiscarded,
  };
}
