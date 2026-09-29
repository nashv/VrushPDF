/**
 * Document outline (bookmarks) preservation and destination remapping for rebuilt PDFs.
 *
 * `copyPages` only transfers the page tree into the new document, discarding
 * catalog-level `/Outlines`, `/Dests`, `PageMode`, and other document-level navigation.
 *
 * This traverses the source outline hierarchy, remaps explicit page destinations
 * (`/Dest` or `/A -> /D`) to the newly copied pages in the output document,
 * recreates the tree structure in the output document context, and re-attaches it
 * to `/Catalog -> /Outlines`.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFRef,
  PDFString,
  PDFHexString,
} from "pdf-lib";
import type { PageEntry } from "./types";

interface NodeInfo {
  srcRef: PDFRef;
  srcDict: PDFDict;
  outRef: PDFRef;
  outDict: PDFDict;
  children: NodeInfo[];
}

export function registerOutlines(
  out: PDFDocument,
  mainDoc: PDFDocument,
  pagePairs: { entry: PageEntry; page: PDFPage }[],
  mainDocId: string,
) {
  // 1. Preserve viewer preferences, page layout and page mode
  const pageMode = mainDoc.catalog.get(PDFName.of("PageMode"));
  if (pageMode) out.catalog.set(PDFName.of("PageMode"), pageMode);

  const pageLayout = mainDoc.catalog.get(PDFName.of("PageLayout"));
  if (pageLayout) out.catalog.set(PDFName.of("PageLayout"), pageLayout);

  const viewerPrefs = mainDoc.catalog.get(PDFName.of("ViewerPreferences"));
  if (viewerPrefs) out.catalog.set(PDFName.of("ViewerPreferences"), viewerPrefs);

  const outlinesDict = mainDoc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  if (!outlinesDict) return;

  const mainPages = mainDoc.getPages();
  const pageRefMap = new Map<PDFRef, PDFRef>();

  for (const { entry, page } of pagePairs) {
    if (entry.sourceDocId === mainDocId && entry.srcIndex < mainPages.length) {
      const srcPage = mainPages[entry.srcIndex];
      if (srcPage && !pageRefMap.has(srcPage.ref)) {
        pageRefMap.set(srcPage.ref, page.ref);
      }
    }
  }

  const fallbackPageRef = pagePairs[0]?.page ? pagePairs[0].page.ref : undefined;

  function remapDest(destObj: unknown): unknown {
    if (destObj instanceof PDFArray) {
      const cloned = out.context.obj([]) as PDFArray;
      for (let i = 0; i < destObj.size(); i++) {
        const item = destObj.get(i);
        if (i === 0) {
          if (item instanceof PDFRef) {
            const mapped = pageRefMap.get(item);
            cloned.push(mapped ?? fallbackPageRef ?? item);
          } else if (item instanceof PDFNumber) {
            const srcIdx = item.asNumber();
            const srcPage = mainPages[srcIdx];
            const mapped = srcPage ? pageRefMap.get(srcPage.ref) : undefined;
            cloned.push(mapped ?? fallbackPageRef ?? item);
          } else {
            cloned.push(item);
          }
        } else {
          cloned.push(item);
        }
      }
      return cloned;
    }
    if (destObj instanceof PDFDict) {
      const cloned = out.context.obj({}) as PDFDict;
      for (const [k, v] of destObj.entries()) {
        if (k === PDFName.of("D")) {
          cloned.set(k, remapDest(v) as any);
        } else {
          cloned.set(k, v as any);
        }
      }
      return cloned;
    }
    return destObj;
  }

  function cloneAction(actionRefOrDict: unknown): unknown {
    const actionDict =
      actionRefOrDict instanceof PDFRef
        ? mainDoc.context.lookupMaybe(actionRefOrDict, PDFDict)
        : actionRefOrDict instanceof PDFDict
          ? actionRefOrDict
          : null;
    if (!actionDict) return actionRefOrDict;

    const clonedDict = out.context.obj({}) as PDFDict;
    for (const [key, val] of actionDict.entries()) {
      if (key === PDFName.of("D")) {
        clonedDict.set(key, remapDest(val) as any);
      } else if (key === PDFName.of("Next")) {
        clonedDict.set(key, cloneAction(val) as any);
      } else {
        clonedDict.set(key, val as any);
      }
    }
    return actionRefOrDict instanceof PDFRef ? out.context.register(clonedDict) : clonedDict;
  }

  // Clone named destinations dictionary if present in Catalog
  const dests = mainDoc.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (dests) {
    const clonedDests = out.context.obj({}) as PDFDict;
    for (const [key, val] of dests.entries()) {
      clonedDests.set(key, remapDest(val) as any);
    }
    out.catalog.set(PDFName.of("Dests"), out.context.register(clonedDests));
  }

  // Recursive outline node cloner
  const visited = new Set<PDFRef>();

  function processItem(srcRef: PDFRef, parentOutRef: PDFRef): NodeInfo | null {
    if (visited.has(srcRef)) return null;
    visited.add(srcRef);

    const srcDict = mainDoc.context.lookupMaybe(srcRef, PDFDict);
    if (!srcDict) return null;

    const outDict = out.context.obj({}) as PDFDict;
    const outRef = out.context.register(outDict);

    const info: NodeInfo = {
      srcRef,
      srcDict,
      outRef,
      outDict,
      children: [],
    };

    // Copy metadata
    const title = srcDict.get(PDFName.of("Title"));
    if (title instanceof PDFString || title instanceof PDFHexString) {
      outDict.set(PDFName.of("Title"), title);
    }

    const c = srcDict.get(PDFName.of("C"));
    if (c instanceof PDFArray) outDict.set(PDFName.of("C"), c);

    const f = srcDict.get(PDFName.of("F"));
    if (f instanceof PDFNumber) outDict.set(PDFName.of("F"), f);

    // Destination or Action
    const dest = srcDict.get(PDFName.of("Dest"));
    if (dest) {
      outDict.set(PDFName.of("Dest"), remapDest(dest) as any);
    }
    const a = srcDict.get(PDFName.of("A"));
    if (a) {
      outDict.set(PDFName.of("A"), cloneAction(a) as any);
    }

    outDict.set(PDFName.of("Parent"), parentOutRef);

    // Traverse children
    let childRef = srcDict.get(PDFName.of("First"));
    while (childRef instanceof PDFRef) {
      const childInfo = processItem(childRef, outRef);
      if (childInfo) {
        info.children.push(childInfo);
        const nextRef = childInfo.srcDict.get(PDFName.of("Next"));
        if (nextRef instanceof PDFRef) {
          childRef = nextRef;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    // Link children
    if (info.children.length > 0) {
      outDict.set(PDFName.of("First"), info.children[0].outRef);
      outDict.set(PDFName.of("Last"), info.children[info.children.length - 1].outRef);
      for (let i = 0; i < info.children.length; i++) {
        if (i > 0) {
          info.children[i].outDict.set(PDFName.of("Prev"), info.children[i - 1].outRef);
        }
        if (i < info.children.length - 1) {
          info.children[i].outDict.set(PDFName.of("Next"), info.children[i + 1].outRef);
        }
      }
      const count = srcDict.get(PDFName.of("Count"));
      if (count instanceof PDFNumber) {
        outDict.set(PDFName.of("Count"), count);
      }
    }

    return info;
  }

  // Root Outlines dict
  const rootOutDict = out.context.obj({
    Type: "Outlines",
  }) as PDFDict;
  const rootOutRef = out.context.register(rootOutDict);

  const rootChildren: NodeInfo[] = [];
  let rootChildRef = outlinesDict.get(PDFName.of("First"));
  while (rootChildRef instanceof PDFRef) {
    const childInfo = processItem(rootChildRef, rootOutRef);
    if (childInfo) {
      rootChildren.push(childInfo);
      const nextRef = childInfo.srcDict.get(PDFName.of("Next"));
      if (nextRef instanceof PDFRef) {
        rootChildRef = nextRef;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (rootChildren.length > 0) {
    rootOutDict.set(PDFName.of("First"), rootChildren[0].outRef);
    rootOutDict.set(PDFName.of("Last"), rootChildren[rootChildren.length - 1].outRef);
    for (let i = 0; i < rootChildren.length; i++) {
      if (i > 0) {
        rootChildren[i].outDict.set(PDFName.of("Prev"), rootChildren[i - 1].outRef);
      }
      if (i < rootChildren.length - 1) {
        rootChildren[i].outDict.set(PDFName.of("Next"), rootChildren[i + 1].outRef);
      }
    }
    const count = outlinesDict.get(PDFName.of("Count"));
    if (count instanceof PDFNumber) {
      rootOutDict.set(PDFName.of("Count"), count);
    }
    out.catalog.set(PDFName.of("Outlines"), rootOutRef);
  }
}
