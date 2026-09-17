import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const doc = await PDFDocument.create();
doc.setTitle("Quarterly Report");
const font = doc.embedStandardFont(StandardFonts.Helvetica);
const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);

const body = [
  "The quick brown fox jumps over the lazy dog. Pack my box with five dozen",
  "liquor jugs. How vexingly quick daft zebras jump! Sphinx of black quartz,",
  "judge my vow. The five boxing wizards jump quickly at dawn each morning.",
  "",
  "Annotation round-trips are verified against this document: highlight a line,",
  "underline another, strike a third, then save and reopen to confirm the marks",
  "survive as real PDF annotation objects rather than flattened page graphics.",
];

for (let i = 0; i < 4; i++) {
  const page = doc.addPage([612, 792]);
  page.drawText(`Section ${i + 1}`, { x: 64, y: 706, size: 22, font: bold });
  page.drawText(`Page ${i + 1} of 4`, { x: 64, y: 684, size: 10, font, color: rgb(0.45, 0.45, 0.5) });
  body.forEach((line, n) => {
    page.drawText(line, { x: 64, y: 640 - n * 20, size: 11.5, font });
  });
  page.drawRectangle({
    x: 64, y: 300, width: 484, height: 120,
    borderColor: rgb(0.8, 0.82, 0.86), borderWidth: 1,
  });
  page.drawText("Signature:", { x: 80, y: 340, size: 11, font });
}

writeFileSync("/tmp/pdfeditor-test/report.pdf", await doc.save());
console.log("wrote /tmp/pdfeditor-test/report.pdf");
