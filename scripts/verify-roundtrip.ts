/**
 * Round-trip verification for the annotation persistence layer.
 *
 * Builds a PDF containing one annotation of every kind we write, saves it,
 * reads it back through the importer, and asserts the geometry, colour,
 * opacity and text all survived. Then saves a second time to prove annotations
 * are replaced rather than duplicated, and exercises the page-ops rebuild path.
 *
 * Runs against the same modules the app uses (`src/lib/annotations/*`), which
 * are deliberately free of Svelte and `$lib` imports so they load under plain
 * Node.
 *
 *   npm run verify:roundtrip
 */
import assert from "node:assert/strict";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
} from "pdf-lib";

import { makePng } from "./fixtures/png.ts";

import { buildSavedPdf, type SourceBytes } from "../src/lib/annotations/save.ts";
import { auditPdf, optimizePdf, PRESETS } from "../src/lib/annotations/optimize.ts";
import {
  latin1,
  serialize,
  tilesExactly,
  tokenize,
} from "../src/lib/content/tokenizer.ts";
import { shownText } from "../src/lib/content/text.ts";
import { detectBlocks, type TextRun } from "../src/lib/content/blocks.ts";
import { createFreeText, freeTextRectAt } from "../src/lib/annotations/create.ts";
import { importAnnots } from "../src/lib/annotations/import.ts";
import type { ImageSource } from "../src/lib/annotations/write.ts";
import {
  annotBounds,
  isBoxShape,
  isFreeText,
  isInk,
  isLineShape,
  isNote,
  isStamp,
  isTextMarkup,
  type Annot,
  type AnnotKind,
  type PageEntry,
  type Quad,
} from "../src/lib/annotations/types.ts";

const MAIN = "main";
const PAGE_COUNT = 3;

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const STAMP_PNG = makePng(4, 2, [220, 30, 60, 255]);

const stampImage: ImageSource = { id: "img:test", bytes: STAMP_PNG, mime: "image/png" };
const resolveImage = (id: string) => (id === stampImage.id ? stampImage : null);

// ------------------------------------------------------------- base document

/** A 3-page PDF with text and one AcroForm text field, to test preservation. */
async function makeBasePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = pdf.embedStandardFont(StandardFonts.Helvetica);

  for (let i = 0; i < PAGE_COUNT; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Page ${i + 1} — the quick brown fox jumps over the lazy dog.`, {
      x: 56,
      y: 700,
      size: 14,
      font,
    });
  }

  const field = pdf.getForm().createTextField("verify.field");
  field.setText("widget");
  field.addToPage(pdf.getPages()[0], { x: 56, y: 120, width: 200, height: 24 });

  return pdf.save({ useObjectStreams: false });
}

/**
 * Two pages with one field of every fillable kind: a nested text field (so the
 * fully qualified name matters), a prefilled multiline field, a checkbox, a
 * radio group, a dropdown, and a text field with a length limit.
 */
async function makeFormPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const [one, two] = [pdf.addPage([612, 792]), pdf.addPage([612, 792])];
  const form = pdf.getForm();

  form.createTextField("applicant.name").addToPage(one, { x: 56, y: 700, width: 240, height: 22 });
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.setText("already here");
  notes.addToPage(one, { x: 56, y: 560, width: 240, height: 100 });
  form.createCheckBox("agree").addToPage(one, { x: 56, y: 520, width: 16, height: 16 });

  const size = form.createRadioGroup("size");
  for (const [i, option] of ["S", "M", "L"].entries()) {
    size.addOptionToPage(option, two, { x: 56 + i * 40, y: 700, width: 16, height: 16 });
  }
  const country = form.createDropdown("country");
  country.addOptions(["DE", "FR", "IT"]);
  country.addToPage(two, { x: 56, y: 640, width: 160, height: 22 });
  const code = form.createTextField("code");
  code.setMaxLength(6);
  code.addToPage(two, { x: 56, y: 600, width: 120, height: 22 });

  return pdf.save({ useObjectStreams: false });
}

// --------------------------------------------------------------- the annots

const quad = (x: number, y: number, w: number, h: number): Quad => ({
  x1: x, y1: y + h,
  x2: x + w, y2: y + h,
  x3: x, y3: y,
  x4: x + w, y4: y,
});

function makeAnnots(pages: PageEntry[]): Annot[] {
  const now = new Date("2026-03-04T05:06:07Z").toISOString();
  const base = (kind: AnnotKind, pageIndex: number, color: string, opacity: number) => ({
    id: `annot-${kind}`,
    pageId: pages[pageIndex].id,
    kind,
    color,
    opacity,
    contents: `comment for ${kind}`,
    author: "Verifier",
    createdAt: now,
    modifiedAt: now,
  });

  return [
    { ...base("highlight", 0, "#fde047", 0.45), kind: "highlight", quads: [quad(56, 694, 300, 18)], quotedText: "Page 1" },
    { ...base("underline", 0, "#2563eb", 1), kind: "underline", quads: [quad(56, 660, 260, 16)], quotedText: "" },
    { ...base("strikeout", 0, "#dc2626", 1), kind: "strikeout", quads: [quad(56, 630, 240, 16)], quotedText: "" },
    { ...base("squiggly", 0, "#16a34a", 1), kind: "squiggly", quads: [quad(56, 600, 220, 16)], quotedText: "" },
    {
      ...base("ink", 1, "#e11d48", 0.9),
      kind: "ink",
      paths: [
        [{ x: 80, y: 500 }, { x: 120, y: 540 }, { x: 160, y: 500 }],
        [{ x: 200, y: 500 }, { x: 240, y: 540 }],
      ],
      width: 2.5,
    },
    { ...base("square", 1, "#0ea5e9", 1), kind: "square", rect: { x: 300, y: 480, w: 120, h: 80 }, width: 2, fill: "#bae6fd" },
    { ...base("circle", 1, "#a855f7", 0.75), kind: "circle", rect: { x: 440, y: 480, w: 100, h: 60 }, width: 3, fill: null },
    { ...base("line", 2, "#f97316", 1), kind: "line", from: { x: 80, y: 300 }, to: { x: 260, y: 360 }, width: 2 },
    // Deliberately points down-left, which is the direction a normalised /Rect
    // would destroy.
    { ...base("arrow", 2, "#0f766e", 1), kind: "arrow", from: { x: 400, y: 380 }, to: { x: 300, y: 300 }, width: 2.5 },
    {
      ...base("freetext", 2, "#111827", 1),
      kind: "freetext",
      rect: { x: 80, y: 180, w: 220, h: 70 },
      // A FreeText's `/Contents` is its body text, so the two must agree.
      contents: "Wrapped FreeText annotation that needs more than one line.",
      text: "Wrapped FreeText annotation that needs more than one line.",
      fontSize: 11,
      align: "left",
      bgColor: "#fef9c3",
      borderColor: "#111827",
      borderWidth: 1,
    },
    { ...base("note", 2, "#fbbf24", 1), kind: "note", point: { x: 500, y: 250 }, icon: "Comment" },
    {
      ...base("stamp", 0, "#000000", 1),
      kind: "stamp",
      rect: { x: 400, y: 600, w: 120, h: 60 },
      imageId: stampImage.id,
      rotation: 0,
      isSignature: false,
    },
  ] as Annot[];
}

// ------------------------------------------------------------------- helpers

async function countAnnots(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const bySubtype = new Map<string, number>();
  let total = 0;

  for (const page of pdf.getPages()) {
    const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!array) continue;
    for (let i = 0; i < array.size(); i++) {
      const dict = array.lookup(i);
      total++;
      const subtype =
        dict && "lookupMaybe" in dict
          ? // @ts-expect-error narrowed structurally; pdf-lib types don't express this
            (dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ?? "?")
          : "?";
      bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);
    }
  }
  return { total, bySubtype };
}

const plan = (n: number, sourceDocId = MAIN): PageEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `page-${i}`,
    sourceDocId,
    srcIndex: i,
    rotation: 0 as const,
  }));

const close = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

function assertClose(label: string, actual: number, expected: number, tol = 0.02) {
  assert.ok(
    close(actual, expected, tol),
    `${label}: expected ~${expected}, got ${actual}`,
  );
}

// ---------------------------------------------------------------------- main

async function main() {
  console.log("PDF annotation round-trip verification\n");

  const baseBytes = await makeBasePdf();
  const basePlan = plan(PAGE_COUNT);
  const original = makeAnnots(basePlan);

  const sources = (bytes: Uint8Array, managedRefs: Set<number>) =>
    (id: string): SourceBytes | null => (id === MAIN ? { bytes, managedRefs } : null);

  // ---- save #1
  console.log("save #1 (fast path)");
  const save1 = await buildSavedPdf({
    pages: basePlan,
    annots: original,
    mainDocId: MAIN,
    getSource: sources(baseBytes, new Set()),
    resolveImage,
  });

  check("uses the fast path", () => assert.equal(save1.strategy, "patched"));
  check("writes every annotation", () => {
    assert.equal(save1.annotationsWritten, original.length);
    assert.equal(save1.annotationsSkipped, 0);
  });

  const counted1 = await countAnnots(save1.bytes);
  check("file holds our annots plus the form widget", () =>
    assert.equal(counted1.total, original.length + 1),
  );
  check("form widget survived the save", () =>
    assert.equal(counted1.bySubtype.get("Widget"), 1),
  );
  check("arrow was written as a /Line", () =>
    assert.equal(counted1.bySubtype.get("Line"), 2),
  );

  // ---- import #1
  console.log("\nimport #1");
  const import1 = await importAnnots(save1.bytes, basePlan);
  const byId = new Map(import1.annots.map((a) => [a.id, a]));

  check("imports every kind including stamp", () => {
    assert.equal(import1.annots.length, original.length);
    assert.ok(import1.annots.some((a) => a.kind === "stamp"), "stamp should import");
  });

  check("ids are stable via /NM", () => {
    for (const a of original) {
      assert.ok(byId.has(a.id), `missing ${a.id}`);
    }
  });

  check("does not claim the form widget", () =>
    assert.equal(import1.managedRefs.size, original.length),
  );

  for (const before of original) {
    const after = byId.get(before.id);

    check(`${before.kind}: round-trips`, () => {
      assert.ok(after, "not imported");
      assert.equal(after.kind, before.kind);
      assert.equal(after.color.toLowerCase(), before.color.toLowerCase());
      assertClose("opacity", after.opacity, before.opacity);
      assert.equal(after.contents, before.contents);
      assert.equal(after.author, before.author);

      if (isTextMarkup(before) && isTextMarkup(after)) {
        assert.equal(after.quads.length, before.quads.length);
        const q0 = before.quads[0];
        const q1 = after.quads[0];
        for (const key of Object.keys(q0) as (keyof Quad)[]) {
          assertClose(`quad.${key}`, q1[key], q0[key]);
        }
      }

      if (isInk(before) && isInk(after)) {
        assert.equal(after.paths.length, before.paths.length);
        assert.equal(after.paths[0].length, before.paths[0].length);
        assertClose("ink x", after.paths[0][1].x, before.paths[0][1].x);
        assertClose("ink y", after.paths[0][1].y, before.paths[0][1].y);
        assertClose("ink width", after.width, before.width);
      }

      if (isBoxShape(before) && isBoxShape(after)) {
        assertClose("rect.x", after.rect.x, before.rect.x);
        assertClose("rect.y", after.rect.y, before.rect.y);
        assertClose("rect.w", after.rect.w, before.rect.w);
        assertClose("rect.h", after.rect.h, before.rect.h);
        assertClose("border width", after.width, before.width);
        if (before.fill) {
          assert.equal(after.fill?.toLowerCase(), before.fill.toLowerCase());
        } else {
          assert.equal(after.fill, null);
        }
      }

      if (isLineShape(before) && isLineShape(after)) {
        // The direction check: a normalised rect would silently flip this.
        assertClose("from.x", after.from.x, before.from.x);
        assertClose("from.y", after.from.y, before.from.y);
        assertClose("to.x", after.to.x, before.to.x);
        assertClose("to.y", after.to.y, before.to.y);
        assert.equal(after.kind, before.kind, "arrowhead lost");
      }

      if (isFreeText(before) && isFreeText(after)) {
        assert.equal(after.text, before.text);
        assertClose("fontSize", after.fontSize, before.fontSize);
        assert.equal(after.align, before.align);
        // `/C` is a FreeText's background, so the text colour must not leak
        // into it.
        assert.equal(after.bgColor?.toLowerCase() ?? null, before.bgColor?.toLowerCase() ?? null);
        assert.equal(after.borderColor?.toLowerCase() ?? null, before.borderColor?.toLowerCase() ?? null);
        assertClose("borderWidth", after.borderWidth, before.borderWidth);
      }

      if (isNote(before) && isNote(after)) {
        assert.equal(after.icon, before.icon);
        assertClose("note.x", after.point.x, before.point.x);
        assertClose("note.y", after.point.y, before.point.y);
      }

      if (isStamp(before) && isStamp(after)) {
        assert.equal(after.imageId, before.imageId);
        assert.equal(after.rotation, before.rotation);
        assert.equal(after.isSignature, before.isSignature);
      }

      // Bounds should be preserved for every kind.
      const b0 = annotBounds(before);
      const b1 = annotBounds(after);
      assertClose("bounds.x", b1.x, b0.x, 0.5);
      assertClose("bounds.y", b1.y, b0.y, 0.5);
    });
  }

  // ---- save #2: no duplication
  console.log("\nsave #2 (replaces, does not duplicate)");
  const save2 = await buildSavedPdf({
    pages: basePlan,
    annots: import1.annots,
    mainDocId: MAIN,
    getSource: sources(save1.bytes, import1.managedRefs),
    resolveImage,
  });

  const counted2 = await countAnnots(save2.bytes);
  check("annotation count is unchanged", () =>
    // 12 re-emitted + the form widget.
    assert.equal(counted2.total, counted1.total),
  );
  check("highlight was not duplicated", () =>
    assert.equal(counted2.bySubtype.get("Highlight"), 1),
  );
  check("stamp was not duplicated", () =>
    assert.equal(counted2.bySubtype.get("Stamp"), 1),
  );
  check("form widget still there", () =>
    assert.equal(counted2.bySubtype.get("Widget"), 1),
  );

  const import2 = await importAnnots(save2.bytes, basePlan);
  check("second import matches the first", () => {
    assert.equal(import2.annots.length, import1.annots.length);
    assert.deepEqual(
      import2.annots.map((a) => a.id).sort(),
      import1.annots.map((a) => a.id).sort(),
    );
  });

  // ---- page ops
  console.log("\npage ops (rebuild path)");
  // Keep pages 3 and 1, in that order, with page 3 rotated 90°.
  const reordered: PageEntry[] = [
    { id: basePlan[2].id, sourceDocId: MAIN, srcIndex: 2, rotation: 90 },
    { id: basePlan[0].id, sourceDocId: MAIN, srcIndex: 0, rotation: 0 },
  ];
  const keptIds = new Set(reordered.map((p) => p.id));
  const keptAnnots = import1.annots.filter((a) => keptIds.has(a.pageId));

  const save3 = await buildSavedPdf({
    pages: reordered,
    annots: keptAnnots,
    mainDocId: MAIN,
    getSource: sources(save1.bytes, import1.managedRefs),
    resolveImage,
  });

  check("uses the rebuild path", () => assert.equal(save3.strategy, "rebuilt"));
  check("writes only the kept annotations", () =>
    assert.equal(save3.annotationsWritten, keptAnnots.length),
  );

  const rebuilt = await PDFDocument.load(save3.bytes, { ignoreEncryption: true });
  check("page count follows the plan", () => assert.equal(rebuilt.getPageCount(), 2));
  /*
   * The product name is written into every file the app saves, as the PDF
   * Producer and as the annotation author. That is the layer a rename is most
   * likely to miss, because nothing on screen looks wrong when it is stale.
   */
  const asWritten = await PDFDocument.load(save3.bytes, {
    ignoreEncryption: true,
    // Without this pdf-lib stamps its own Producer into the in-memory copy as
    // it loads, and the assertion below would only ever see pdf-lib's string.
    updateMetadata: false,
  });
  check("the saved file carries the current product name", () =>
    assert.equal(asWritten.getProducer(), "VrushPDF"),
  );
  check("rotation was applied to the right page", () => {
    assert.equal(rebuilt.getPages()[0].getRotation().angle, 90);
    assert.equal(rebuilt.getPages()[1].getRotation().angle, 0);
  });

  // Reopening builds a fresh plan against the *saved* file, where the kept
  // pages are now at indices 0 and 1. Their plan ids are carried over so the
  // expectation below can check that each annotation followed its page.
  const reopenedPlan: PageEntry[] = reordered.map((entry, i) => ({
    id: entry.id,
    sourceDocId: MAIN,
    srcIndex: i,
    rotation: 0,
  }));

  const import3 = await importAnnots(save3.bytes, reopenedPlan);
  check("annotations follow their page, not the index", () => {
    assert.equal(import3.annots.length, keptAnnots.length);
    const expected = new Map(keptAnnots.map((a) => [a.id, a.pageId]));
    for (const a of import3.annots) {
      assert.equal(a.pageId, expected.get(a.id), `${a.id} landed on the wrong page`);
    }
  });

  const counted3 = await countAnnots(save3.bytes);
  check("no annotations were duplicated by the rebuild", () => {
    // The kept annotations, plus the form widget on page 0.
    assert.equal(counted3.total, keptAnnots.length + 1);
    assert.equal(counted3.bySubtype.get("Highlight"), 1);
  });
  check("stamp and widget survive the rebuild", () => {
    assert.equal(counted3.bySubtype.get("Stamp"), 1);
    assert.equal(counted3.bySubtype.get("Widget"), 1);
  });

  // Verify outline preservation in rebuild path
  const docWithOutline = await PDFDocument.create();
  const pageA = docWithOutline.addPage([200, 200]);
  const pageB = docWithOutline.addPage([200, 200]);
  const pageC = docWithOutline.addPage([200, 200]);

  const outlineRoot = docWithOutline.context.obj({ Type: "Outlines" }) as PDFDict;
  const outlineRootRef = docWithOutline.context.register(outlineRoot);

  const item1 = docWithOutline.context.obj({
    Title: PDFString.of("Chapter 1"),
    Parent: outlineRootRef,
    Dest: [pageA.ref, PDFName.of("XYZ"), null, null, null],
  }) as PDFDict;
  const item1Ref = docWithOutline.context.register(item1);

  const item2 = docWithOutline.context.obj({
    Title: PDFString.of("Chapter 2"),
    Parent: outlineRootRef,
    Prev: item1Ref,
    Dest: [pageC.ref, PDFName.of("XYZ"), null, null, null],
  }) as PDFDict;
  const item2Ref = docWithOutline.context.register(item2);

  item1.set(PDFName.of("Next"), item2Ref);
  outlineRoot.set(PDFName.of("First"), item1Ref);
  outlineRoot.set(PDFName.of("Last"), item2Ref);
  outlineRoot.set(PDFName.of("Count"), PDFNumber.of(2));
  docWithOutline.catalog.set(PDFName.of("Outlines"), outlineRootRef);

  const docBytes = await docWithOutline.save();
  const outlinePlan: PageEntry[] = [
    { id: "pC", sourceDocId: MAIN, srcIndex: 2, rotation: 0 },
    { id: "pA", sourceDocId: MAIN, srcIndex: 0, rotation: 0 },
  ];
  const outlineSave = await buildSavedPdf({
    pages: outlinePlan,
    annots: [],
    mainDocId: MAIN,
    getSource: sources(docBytes, new Set()),
    resolveImage,
  });

  const rebuiltOutDoc = await PDFDocument.load(outlineSave.bytes);
  check("rebuild path preserves and remaps document outlines", () => {
    assert.equal(outlineSave.strategy, "rebuilt");
    const outRoot = rebuiltOutDoc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
    assert.ok(outRoot, "Outlines dictionary missing from rebuilt document");
    const firstRef = outRoot.get(PDFName.of("First")) as PDFRef;
    assert.ok(firstRef, "First item missing");
    const firstItem = rebuiltOutDoc.context.lookup(firstRef, PDFDict);
    assert.equal(firstItem.lookup(PDFName.of("Title"), PDFString)?.decodeText(), "Chapter 1");
    const dest1 = firstItem.get(PDFName.of("Dest")) as PDFArray;
    assert.ok(dest1 instanceof PDFArray);
    // Page A was at srcIndex 0, in outlinePlan it is placed at index 1 in the new doc
    const newPages = rebuiltOutDoc.getPages();
    assert.equal(dest1.get(0), newPages[1].ref);

    const nextRef = firstItem.get(PDFName.of("Next")) as PDFRef;
    const secondItem = rebuiltOutDoc.context.lookup(nextRef, PDFDict);
    assert.equal(secondItem.lookup(PDFName.of("Title"), PDFString)?.decodeText(), "Chapter 2");
    const dest2 = secondItem.get(PDFName.of("Dest")) as PDFArray;
    // Page C was at srcIndex 2, in outlinePlan it is placed at index 0 in the new doc
    assert.equal(dest2.get(0), newPages[0].ref);
  });

  // ------------------------------------------------- content-stream tokenizer
  /*
   * The tokenizer underpins any editing of page text, and the failure mode of a
   * subtly wrong one is a corrupted document rather than an error. So the
   * requirement it is held to is that token spans tile the input exactly — no
   * gaps, no overlaps — which makes re-serialisation byte-identical by
   * construction.
   */
  const bytesOf = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

  const nasties: [string, string][] = [
    ["plain operators", "BT /F1 12 Tf 72 700 Td (Hello) Tj ET"],
    ["nested parens", "((a(b)c)) Tj"],
    ["escaped backslash before the close", "(a\\\\) Tj (b) Tj"],
    ["escaped paren", "(a\\)b) Tj"],
    ["comment containing string delimiters", "BT % this ) is ( not a string\n/F1 12 Tf ET"],
    ["hex string", "<48656C6C6F> Tj"],
    ["dictionary and array", "<< /A [1 2 3] /B <</C 4>> >> BDC"],
    ["signed and bare-point numbers", "-1.5 .5 +2 0 Td"],
    ["inline image whose payload contains EI-like bytes", "BI /W 2 /H 2 ID \u0000EI\u0001junk\u0000 EI Q"],
    ["empty stream", ""],
  ];

  for (const [label, source] of nasties) {
    const bytes = bytesOf(source);
    const tokens = tokenize(bytes);
    check(`tokens tile exactly: ${label}`, () => {
      assert.ok(tilesExactly(bytes, tokens), "spans leave a gap or overlap");
      assert.deepEqual(serialize(bytes, tokens), bytes, "re-serialising changed the bytes");
    });
  }

  /*
   * Tiling alone does not prove correct segmentation: a lexer that ends a
   * string early still covers the input, because the leftover bytes simply
   * become other tokens. These assert structure instead, and exist because a
   * deliberately broken escape handler passed every tiling check.
   */
  const structure = (source: string) => {
    const bytes = bytesOf(source);
    const tokens = tokenize(bytes);
    return {
      strings: tokens
        .filter((t) => t.kind === "string")
        .map((t) => latin1(bytes, t.start, t.end)),
      ops: tokens.filter((t) => t.kind === "operator").map((t) => t.op),
      comments: tokens.filter((t) => t.kind === "comment").length,
    };
  };

  check("an escaped close paren does not end the string", () => {
    const { strings, ops } = structure("(a\\)b) Tj");
    assert.deepEqual(strings, ["(a\\)b)"]);
    assert.deepEqual(ops, ["Tj"]);
  });

  check("nested parens balance rather than ending at the first close", () => {
    const { strings, ops } = structure("((a(b)c)) Tj");
    assert.deepEqual(strings, ["((a(b)c))"]);
    assert.deepEqual(ops, ["Tj"]);
  });

  check("an escaped backslash does not escape the close paren", () => {
    const { strings, ops } = structure("(a\\\\) Tj (b) Tj");
    assert.deepEqual(strings, ["(a\\\\)", "(b)"]);
    assert.deepEqual(ops, ["Tj", "Tj"]);
  });

  check("a comment does not eat the operators after it", () => {
    const { ops, comments } = structure("BT % this ) is ( not a string\n/F1 12 Tf ET");
    assert.equal(comments, 1);
    assert.deepEqual(ops, ["BT", "Tf", "ET"]);
  });

  check("a percent sign inside a string is not a comment", () => {
    const bytes = bytesOf("(50% off) Tj");
    const strings = tokenize(bytes).filter((t) => t.kind === "string");
    assert.equal(strings.length, 1);
    assert.equal(latin1(bytes, strings[0].start, strings[0].end), "(50% off)");
  });

  check("an inline image is one token and does not swallow what follows", () => {
    const bytes = bytesOf("BI /W 1 ID \u00ff\u00fe( EI Q");
    const tokens = tokenize(bytes);
    assert.equal(tokens.filter((t) => t.kind === "inline-image").length, 1);
    assert.ok(tokens.some((t) => t.op === "Q"), "the operator after the image was lost");
  });

  check("operators are classified", () => {
    const ops = tokenize(bytesOf("BT /F1 12 Tf (x) Tj ET"))
      .filter((t) => t.kind === "operator")
      .map((t) => t.op);
    assert.deepEqual(ops, ["BT", "Tf", "Tj", "ET"]);
  });

  // The same invariant against real page content, which is where the awkward
  // bytes actually live.
  const realPages = await PDFDocument.load(await makeBasePdf(), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  let streamsChecked = 0;
  for (const [index, page] of realPages.getPages().entries()) {
    const contents = page.node.get(PDFName.of("Contents"));
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const ref of refs) {
      const stream = page.node.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const bytes = decodePDFRawStream(stream).decode();
      streamsChecked++;
      check(`real page ${index + 1}: tokens tile exactly`, () => {
        const tokens = tokenize(bytes);
        assert.ok(tilesExactly(bytes, tokens), "spans do not tile the page content");
        assert.deepEqual(serialize(bytes, tokens), bytes);
        assert.ok(
          tokens.some((t) => t.op === "Tj" || t.op === "TJ"),
          "no show-text operator found, so this proves nothing",
        );
      });
    }
  }
  check("real page content was actually exercised", () => assert.ok(streamsChecked > 0));

  // ------------------------------------------------- where the operators draw
  /*
   * `makeBasePdf` draws its text at x:56 y:700 size:14, so the state machine's
   * output can be checked against coordinates the fixture was actually created
   * with rather than against my own arithmetic.
   */
  /*
   * `/Contents` may be an array of streams — it is here, because the fixture
   * adds a form widget to page 1 — and PDF treats those as one stream
   * concatenated with whitespace between. An earlier version of this check
   * assumed a single stream and silently skipped itself.
   */
  const pageContent = (page: PDFPage) => {
    const entry = page.node.get(PDFName.of("Contents"));
    const refs = entry instanceof PDFArray ? entry.asArray() : [entry];
    const parts: Uint8Array[] = [];
    for (const ref of refs) {
      const stream = page.node.context.lookup(ref);
      if (stream instanceof PDFRawStream) parts.push(decodePDFRawStream(stream).decode());
    }
    const size = parts.reduce((n, p) => n + p.length + 1, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
      out[at++] = 0x0a;
    }
    return out;
  };

  {
    const content = pageContent(realPages.getPages()[0]);
    check("page content was read for the position checks", () =>
      assert.ok(content.length > 0, "no content stream found, so the checks below prove nothing"),
    );
    const runs = shownText(content, tokenize(content));

    check("every shown run is found, with its position", () => {
      assert.ok(runs.length >= 1, "no show-text operators were attributed");
      const drawn = runs.find((r) => r.text.includes("quick brown fox"));
      assert.ok(drawn, `the drawn text was not found; got: ${runs.map((r) => r.text).join(" | ")}`);
      assert.ok(Math.abs(drawn.x - 56) < 0.01, `x was ${drawn.x}, drawn at 56`);
      assert.ok(Math.abs(drawn.y - 700) < 0.01, `y was ${drawn.y}, drawn at 700`);
      assert.equal(drawn.size, 14);
      assert.ok(drawn.font.startsWith("/"), `font resource looks wrong: ${drawn.font}`);
    });

    check("runs carry the tokens needed to rewrite them", () => {
      const drawn = runs.find((r) => r.text.includes("quick brown fox"))!;
      assert.ok(drawn.stringTokens.length >= 1, "no string token recorded");
      assert.equal(drawn.ordinal, runs.indexOf(drawn), "ordinals are not sequential");
    });
  }

  // Synthetic streams, where the expected geometry is unambiguous.
  const runsOf = (src: string) => {
    const b = bytesOf(src);
    return shownText(b, tokenize(b));
  };

  check("Td accumulates along the line", () => {
    const runs = runsOf("BT /F1 10 Tf 10 20 Td (a) Tj 5 0 Td (b) Tj ET");
    assert.deepEqual(runs.map((r) => [r.x, r.y]), [[10, 20], [15, 20]]);
  });

  check("T* steps down by the leading", () => {
    const runs = runsOf("BT /F1 10 Tf 15 TL 10 100 Td (a) Tj T* (b) Tj ET");
    assert.deepEqual(runs.map((r) => [r.x, r.y]), [[10, 100], [10, 85]]);
  });

  check("cm offsets the text, and Q restores it", () => {
    const runs = runsOf("q 1 0 0 1 100 200 cm BT /F1 10 Tf 5 5 Td (a) Tj ET Q BT /F1 10 Tf 5 5 Td (b) Tj ET");
    assert.deepEqual(runs.map((r) => [r.x, r.y]), [[105, 205], [5, 5]]);
  });

  check("Tm replaces rather than accumulates", () => {
    const runs = runsOf("BT /F1 10 Tf 10 10 Td 1 0 0 1 70 700 Tm (a) Tj ET");
    assert.deepEqual(runs.map((r) => [r.x, r.y]), [[70, 700]]);
  });

  check("a TJ array is one run, kerning numbers ignored", () => {
    const runs = runsOf("BT /F1 10 Tf 10 10 Td [(Hel) -120 (lo)] TJ ET");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].text, "Hello");
  });

  check("string escapes are decoded", () => {
    const runs = runsOf("BT /F1 10 Tf 0 0 Td (a\\(b\\)c) Tj ET");
    assert.equal(runs[0].text, "a(b)c");
  });

  check("hex strings are decoded", () => {
    const runs = runsOf("BT /F1 10 Tf 0 0 Td <48656C6C6F> Tj ET");
    assert.equal(runs[0].text, "Hello");
  });

  // --------------------------------------------------------- block detection
  /*
   * Synthetic runs, because the expected grouping has to be unambiguous. Every
   * rule here is a heuristic; these fix the behaviour that later stages rely on.
   */
  const line = (text: string, x: number, y: number, width = 200, fontSize = 12): TextRun => ({
    text, x, y, width, fontSize,
  });

  check("consecutive lines at the same leading are one paragraph", () => {
    const blocks = detectBlocks([
      line("first line of the paragraph", 56, 700),
      line("second line of the paragraph", 56, 686),
      line("third line of the paragraph", 56, 672),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lines.length, 3);
  });

  check("a wide vertical gap splits paragraphs", () => {
    const blocks = detectBlocks([
      line("end of the first paragraph", 56, 700),
      line("start of the second", 56, 640),
    ]);
    assert.equal(blocks.length, 2);
  });

  check("two columns do not weld into one block", () => {
    const blocks = detectBlocks([
      line("left column line one", 56, 700, 200),
      line("right column line one", 320, 700, 200),
      line("left column line two", 56, 686, 200),
      line("right column line two", 320, 686, 200),
    ]);
    assert.equal(blocks.length, 2, `got ${blocks.length}: ${blocks.map((b) => b.text).join(" / ")}`);
    assert.ok(blocks.every((b) => b.lines.length === 2), "columns were not kept whole");
  });

  check("a heading is not absorbed into the body below it", () => {
    const blocks = detectBlocks([
      line("A Heading", 56, 700, 120, 22),
      line("body text line one", 56, 676, 200, 11),
      line("body text line two", 56, 663, 200, 11),
    ]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, "A Heading");
  });

  check("an indented line starts a new block", () => {
    const blocks = detectBlocks([
      line("flush left line", 56, 700),
      line("indented line", 90, 686),
    ]);
    assert.equal(blocks.length, 2);
  });

  check("runs on one baseline become a single line with spacing", () => {
    const blocks = detectBlocks([
      line("Hello", 56, 700, 30),
      line("world", 92, 700, 30),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lines.length, 1);
    assert.equal(blocks[0].lines[0].text, "Hello world");
  });

  check("a block reports a bounding box covering its lines", () => {
    const blocks = detectBlocks([
      line("one", 56, 700, 100),
      line("two", 56, 686, 140),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].x, 56);
    assert.equal(blocks[0].width, 140);
    assert.ok(blocks[0].y <= 686 && blocks[0].y + blocks[0].height >= 700);
  });


  // ------------------------------------------------------------- form fields
  console.log("\nform fields");

  const formBytes = await makeFormPdf();
  const formPlan = plan(2);
  const blankForm = await PDFDocument.load(formBytes);
  // What pdf.js reports as a radio's value is its appearance state name, so
  // take the fixture's own names rather than assuming pdf-lib's labels.
  const sizeStates = blankForm
    .getForm()
    .getRadioGroup("size")
    .acroField.getOnValues()
    .map((n) => n.decodeText());

  const filled = {
    "applicant.name": "Ada Lovelace",
    agree: true,
    size: sizeStates[1],
    country: ["FR"],
    code: "ABCDEFGHIJ",
  };
  const formSave = await buildSavedPdf({
    pages: formPlan,
    annots: [],
    mainDocId: MAIN,
    getSource: sources(formBytes, new Set()),
    resolveImage,
    fields: filled,
  });
  const formOut = (await PDFDocument.load(formSave.bytes)).getForm();

  check("fills every kind of field", () => {
    assert.equal(formSave.fieldsWritten, 5);
    assert.deepEqual(formSave.fieldsFailed, []);
    assert.equal(formOut.getTextField("applicant.name").getText(), "Ada Lovelace");
    assert.equal(formOut.getCheckBox("agree").isChecked(), true);
    assert.equal(
      formOut.getRadioGroup("size").acroField.getValue().decodeText(),
      sizeStates[1],
    );
    assert.deepEqual(formOut.getDropdown("country").getSelected(), ["FR"]);
  });
  check("text over a field's limit is cut to it, not refused", () =>
    assert.equal(formOut.getTextField("code").getText(), "ABCDEF"),
  );
  check("a field left alone keeps what the file had", () =>
    assert.equal(formOut.getTextField("notes").getText(), "already here"),
  );
  check("filled fields carry a regenerated appearance", () => {
    const widget = formOut.getTextField("applicant.name").acroField.getWidgets()[0];
    const normal = widget.getAppearances()?.normal;
    assert.ok(normal instanceof PDFRawStream, "no normal appearance stream");
    // pdf-lib shows text as a hex string of Helvetica codes; "Ada" is 416461.
    const content = new TextDecoder("latin1").decode(decodePDFRawStream(normal).decode());
    assert.match(content, /416461/i);
  });
  check("Latin text does not need the viewer to draw it", () =>
    assert.equal(formOut.acroForm.dict.get(PDFName.of("NeedAppearances")), undefined),
  );

  const greek = await buildSavedPdf({
    pages: formPlan,
    annots: [],
    mainDocId: MAIN,
    getSource: sources(formBytes, new Set()),
    resolveImage,
    fields: { "applicant.name": "Ελένη", nosuchfield: "x" },
  });
  const greekOut = (await PDFDocument.load(greek.bytes)).getForm();
  check("text Helvetica cannot draw is kept, and left to the viewer", () => {
    assert.equal(greekOut.getTextField("applicant.name").getText(), "Ελένη");
    assert.ok(greekOut.acroForm.dict.get(PDFName.of("NeedAppearances")));
  });
  check("an unknown field is reported, and the save still succeeds", () => {
    assert.deepEqual(greek.fieldsFailed, ["nosuchfield"]);
    assert.equal(greek.fieldsWritten, 1);
  });

  const rotated: PageEntry[] = [
    { ...formPlan[1] },
    { ...formPlan[0], rotation: 90 },
  ];
  const formRebuilt = await buildSavedPdf({
    pages: rotated,
    annots: [],
    mainDocId: MAIN,
    getSource: sources(formBytes, new Set()),
    resolveImage,
    fields: filled,
  });
  const rebuiltForm = (await PDFDocument.load(formRebuilt.bytes)).getForm();
  check("the rebuild path keeps the document a fillable form", () => {
    assert.equal(formRebuilt.strategy, "rebuilt");
    const names = rebuiltForm.getFields().map((f) => f.getName()).sort();
    assert.deepEqual(names, ["agree", "applicant.name", "code", "country", "notes", "size"]);
  });
  check("and fills it", () => {
    assert.equal(formRebuilt.fieldsWritten, 5);
    assert.equal(rebuiltForm.getTextField("applicant.name").getText(), "Ada Lovelace");
    assert.equal(rebuiltForm.getCheckBox("agree").isChecked(), true);
  });

  // -------------------------------------------------------- flattening checks
  console.log("\nFlattening…");
  const flattened = await buildSavedPdf({
    pages: basePlan,
    annots: original,
    mainDocId: MAIN,
    getSource: sources(baseBytes, new Set()),
    resolveImage,
    flatten: true,
  });

  check("saving flattened writes all annotations as page graphics", () => {
    assert.equal(flattened.annotationsWritten, original.length);
  });

  const { annots: flattenedReadBack } = await importAnnots(flattened.bytes, basePlan);
  check("flattened annotations are burned into content streams rather than /Annots", () => {
    assert.equal(flattenedReadBack.length, 0);
  });

  const flatFormSaved = await buildSavedPdf({
    pages: formPlan,
    annots: [],
    mainDocId: MAIN,
    getSource: sources(formBytes, new Set()),
    resolveImage,
    fields: filled,
    flatten: true,
  });

  const flatFormDoc = await PDFDocument.load(flatFormSaved.bytes);
  check("flattening a form document burns fields into static graphics", () => {
    assert.equal(flatFormSaved.fieldsWritten, 5);
    assert.equal(flatFormDoc.getForm().getFields().length, 0);
  });

  // -------------------------------------------------------- optimizer checks
  console.log("\nOptimization & Compression…");
  const audit = await auditPdf(baseBytes);
  check("audit correctly reports document structure and page count", () => {
    assert.equal(audit.pageCount, PAGE_COUNT);
    assert.equal(audit.formFieldCount, 1);
  });

  const optimized = await optimizePdf({
    docBytes: baseBytes,
    options: PRESETS.standard,
  });

  check("optimizer packs indirect objects into object streams", () => {
    assert.ok(optimized.bytes.length > 0);
    assert.ok(optimized.savedPercentage >= 0);
  });

  const cleanOptimized = await optimizePdf({
    docBytes: formBytes,
    options: PRESETS.high_compression,
  });

  check("high compression preset optimizes form document successfully", () => {
    assert.ok(cleanOptimized.bytes.length > 0);
    assert.ok(cleanOptimized.objectsDiscarded > 0);
  });

  // ---------------------------------------------------- freetext sizing checks
  console.log("\nFreeText Sizing…");
  const defaultClickRect = freeTextRectAt({ x: 100, y: 200 }, 12);
  check("click placement produces a compact height proportional to font size", () => {
    assert.equal(defaultClickRect.w, 160);
    assert.equal(defaultClickRect.h, 18);
    assert.equal(defaultClickRect.x, 100);
    assert.equal(defaultClickRect.y, 200 - 18);
  });

  const dummyStyle = {
    color: "#000000",
    opacity: 1,
    width: 1,
    fontSize: 12,
    fill: null,
  };

  const smallDragged = createFreeText("p1", { x: 50, y: 50, w: 60, h: 14 }, dummyStyle);
  check("allows small dragged text box heights without forcing 40pt minimum", () => {
    assert.equal(smallDragged.rect.w, 60);
    assert.equal(smallDragged.rect.h, 14);
  });

  const tinyDragged = createFreeText("p1", { x: 50, y: 50, w: 2, h: 2 }, dummyStyle);
  check("clamps below minimum safety margin of 4pt", () => {
    assert.equal(tinyDragged.rect.w, 4);
    assert.equal(tinyDragged.rect.h, 4);
  });

  // ---------------------------------------------------- typography & whiteout roundtrip checks
  console.log("\nFreeText Typography & Whiteout Round-Trip…");
  const typographyAnnot = createFreeText(
    basePlan[0].id,
    { x: 72, y: 500, w: 200, h: 30 },
    {
      color: "#000000",
      opacity: 1,
      width: 0,
      fontSize: 14,
      fill: "#ffffff",
      fontFamily: "Times",
      bold: true,
      italic: true,
      padding: 6,
    },
  );
  typographyAnnot.text = "Whiteout Heading Text";

  const customFtSaved = await buildSavedPdf({
    pages: basePlan,
    annots: [typographyAnnot],
    mainDocId: MAIN,
    getSource: sources(baseBytes, new Set()),
    resolveImage,
  });

  const { annots: readBackFt } = await importAnnots(customFtSaved.bytes, basePlan);
  check("round-trips FreeText font family, bold, italic, padding, and whiteout bgColor", () => {
    assert.equal(readBackFt.length, 1);
    const ft = readBackFt[0];
    assert.equal(ft.kind, "freetext");
    if (ft.kind === "freetext") {
      assert.equal(ft.text, "Whiteout Heading Text");
      assert.equal(ft.fontSize, 14);
      assert.equal(ft.fontFamily, "Times");
      assert.equal(ft.bold, true);
      assert.equal(ft.italic, true);
      assert.equal(ft.padding, 6);
      assert.equal(ft.bgColor, "#ffffff");
    }
  });

  console.log(
    failures === 0 ? "\nAll round-trip checks passed." : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
