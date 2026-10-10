/**
 * Test fixtures.
 *
 * Two visibly different documents, so the UI checks can prove that tabs are
 * actually independent rather than sharing one document's state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

import { makePng } from "./png.ts";

const OUT_DIR = "/tmp/vrushpdf-test";

const body = [
  "The quick brown fox jumps over the lazy dog. Pack my box with five dozen",
  "liquor jugs. How vexingly quick daft zebras jump! Sphinx of black quartz,",
  "judge my vow. The five boxing wizards jump quickly at dawn each morning.",
  "",
  "Annotation round-trips are verified against this document: highlight a line,",
  "underline another, strike a third, then save and reopen to confirm the marks",
  "survive as real PDF annotation objects rather than flattened page graphics.",
];

async function build(title: string, heading: string, pageCount: number) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);

  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${heading} ${i + 1}`, { x: 64, y: 706, size: 22, font: bold });
    page.drawText(`Page ${i + 1} of ${pageCount}`, {
      x: 64, y: 684, size: 10, font, color: rgb(0.45, 0.45, 0.5),
    });
    body.forEach((line, n) => {
      page.drawText(line, { x: 64, y: 640 - n * 20, size: 11.5, font });
    });
    page.drawRectangle({
      x: 64, y: 300, width: 484, height: 120,
      borderColor: rgb(0.8, 0.82, 0.86), borderWidth: 1,
    });
    page.drawText("Signature:", { x: 80, y: 340, size: 11, font });
  }

  return doc.save();
}

mkdirSync(OUT_DIR, { recursive: true });

// A stamp image for the UI suite's "Add an image…" path.
writeFileSync(`${OUT_DIR}/stamp.png`, makePng(24, 12, [37, 99, 235, 255]));
console.log(`wrote ${OUT_DIR}/stamp.png`);

// Different page counts, so a tab mix-up shows up immediately.
for (const [name, title, heading, pages] of [
  ["report.pdf", "Quarterly Report", "Section", 4],
  ["appendix.pdf", "Appendix", "Exhibit", 2],
] as const) {
  writeFileSync(`${OUT_DIR}/${name}`, await build(title, heading, pages));
  console.log(`wrote ${OUT_DIR}/${name}`);
}

// Scans to clean up: a page scanned 3° crooked, and a phone photo of an
// A4-shaped sheet lying at an angle on a dark desk.
{
  const doc = await PDFDocument.create();
  doc.setTitle("Scans");
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const tilted = doc.addPage([612, 792]);
  const t = (3 * Math.PI) / 180;
  [...body, ...body].filter(Boolean).forEach((line, n) => {
    // Turn each line's start about the page centre, and the text with it.
    const dx = 64 - 306;
    const dy = 680 - n * 26 - 396;
    tilted.drawText(line, {
      x: 306 + dx * Math.cos(t) - dy * Math.sin(t),
      y: 396 + dx * Math.sin(t) + dy * Math.cos(t),
      size: 13,
      font,
      rotate: degrees(3),
    });
  });
  const photo = doc.addPage([612, 792]);
  photo.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.22, 0.22, 0.24) });
  photo.drawSvgPath("M100 100 L500 120 L510 686 L90 666 Z", { x: 0, y: 792, color: rgb(0.96, 0.96, 0.95) });
  writeFileSync(`${OUT_DIR}/scan.pdf`, await doc.save());
  console.log(`wrote ${OUT_DIR}/scan.pdf`);
}

// A one-page form, for filling in: a text field and a checkbox.
{
  const doc = await PDFDocument.create();
  doc.setTitle("Application");
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Name", { x: 64, y: 706, size: 12, font });
  page.drawText("I agree", { x: 90, y: 650, size: 12, font });
  const form = doc.getForm();
  form.createTextField("applicant").addToPage(page, { x: 64, y: 670, width: 300, height: 24 });
  form.createCheckBox("agree").addToPage(page, { x: 64, y: 646, width: 18, height: 18 });
  writeFileSync(`${OUT_DIR}/form.pdf`, await doc.save());
  console.log(`wrote ${OUT_DIR}/form.pdf`);
}
