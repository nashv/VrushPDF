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
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
} from "pdf-lib";

import { makePng } from "./fixtures/png.ts";

import { buildSavedPdf, type SourceBytes } from "../src/lib/annotations/save.ts";
import {
  latin1,
  serialize,
  tilesExactly,
  tokenize,
} from "../src/lib/content/tokenizer.ts";
import { importAnnots } from "../src/lib/annotations/import.ts";
import type { ImageSource } from "../src/lib/annotations/write.ts";
import {
  annotBounds,
  isBoxShape,
  isFreeText,
  isInk,
  isLineShape,
  isNote,
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

  check("imports every kind except stamp", () => {
    assert.equal(import1.annots.length, original.length - 1);
    assert.ok(!import1.annots.some((a) => a.kind === "stamp"), "stamp should not import");
  });

  check("ids are stable via /NM", () => {
    for (const a of original) {
      if (a.kind === "stamp") continue;
      assert.ok(byId.has(a.id), `missing ${a.id}`);
    }
  });

  check("does not claim the form widget", () =>
    assert.equal(import1.managedRefs.size, original.length - 1),
  );

  for (const before of original) {
    if (before.kind === "stamp") continue;
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
      }

      if (isNote(before) && isNote(after)) {
        assert.equal(after.icon, before.icon);
        assertClose("note.x", after.point.x, before.point.x);
        assertClose("note.y", after.point.y, before.point.y);
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
    // 11 re-emitted + the un-imported stamp + the form widget.
    assert.equal(counted2.total, counted1.total),
  );
  check("highlight was not duplicated", () =>
    assert.equal(counted2.bySubtype.get("Highlight"), 1),
  );
  check("unmanaged stamp was preserved", () =>
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
    // The kept annotations, plus the two things on page 1 that we never took
    // ownership of and so copied through untouched: the stamp and the widget.
    assert.equal(counted3.total, keptAnnots.length + 2);
    assert.equal(counted3.bySubtype.get("Highlight"), 1);
  });
  check("un-imported annotations survive the rebuild", () => {
    assert.equal(counted3.bySubtype.get("Stamp"), 1);
    assert.equal(counted3.bySubtype.get("Widget"), 1);
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

  console.log(
    failures === 0 ? "\nAll round-trip checks passed." : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
