/**
 * Showcase documents for screenshots: a three-page proposal with every kind of
 * markup on it, and a filled-in, signed approval form. The annotations are
 * written by the app's own `buildSavedPdf`, so they open in VrushPDF as real,
 * editable annotations.
 *
 *   npx tsx scripts/fixtures/make-showcase-pdf.ts <dir with approved.png, signature.png>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { buildSavedPdf } from "../../src/lib/annotations/save.ts";
import type { Annot, AnnotKind, PageEntry, Quad } from "../../src/lib/annotations/types.ts";

const dir = process.argv[2] ?? "/tmp/vrushpdf-shots";
const INK = rgb(0.11, 0.13, 0.17);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.05, 0.4, 0.55);
const RULE = rgb(0.85, 0.87, 0.9);
const TINT = rgb(0.94, 0.96, 0.98);

/** Where a drawn line of text ended up, for aiming markup at it. */
interface Placed { x: number; y: number; w: number; size: number }

function writer(page: PDFPage, font: PDFFont, bold: PDFFont) {
  const text = (s: string, x: number, y: number, size = 11, f = font, color = INK): Placed => {
    page.drawText(s, { x, y, size, font: f, color });
    return { x, y, w: f.widthOfTextAtSize(s, size), size };
  };
  const para = (lines: string[], x: number, y: number, size = 11, leading = 16) =>
    lines.map((l, i) => text(l, x, y - i * leading, size));
  const heading = (s: string, y: number) => text(s, 64, y, 14, bold, ACCENT);
  const footer = (n: number) => {
    page.drawLine({ start: { x: 64, y: 56 }, end: { x: 548, y: 56 }, thickness: 0.5, color: RULE });
    text("Harbor Light Research Station · Project Proposal", 64, 40, 8.5, font, MUTED);
    text(`${n} / 3`, 530, 40, 8.5, font, MUTED);
  };
  return { text, para, heading, footer };
}

/** A text-markup quad over a placed line, or part of it. */
function over(p: Placed, from = 0, width = p.w): Quad {
  const x = p.x + from, y = p.y - p.size * 0.25, h = p.size * 1.2;
  return { x1: x, y1: y + h, x2: x + width, y2: y + h, x3: x, y3: y, x4: x + width, y4: y };
}

let n = 0;
function annot(kind: AnnotKind, pageId: string, color: string, extra: object, contents = "", opacity = 1): Annot {
  const now = "2026-09-24T09:30:00Z";
  return {
    id: `showcase-${n++}`, pageId, kind, color, opacity, contents,
    author: "Dana Whitfield", createdAt: now, modifiedAt: now, ...extra,
  } as Annot;
}

async function proposal() {
  const doc = await PDFDocument.create();
  doc.setTitle("Harbor Light Research Station — Project Proposal");
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const at: Record<string, Placed> = {};

  // ---- page 1: summary
  {
    const page = doc.addPage([612, 792]);
    const w = writer(page, font, bold);
    w.text("PROJECT PROPOSAL  ·  FY 2027", 64, 728, 9, bold, MUTED);
    w.text("Harbor Light Research Station", 64, 698, 26, bold);
    w.text("Expanding coastal monitoring along the northern shelf", 64, 674, 13, font, MUTED);
    page.drawLine({ start: { x: 64, y: 656 }, end: { x: 548, y: 656 }, thickness: 1, color: RULE });

    w.heading("Summary", 624);
    const summary = w.para([
      "The northern shelf has lost 40% of its seagrass cover since 2011, yet we monitor it",
      "from a single tide gauge. This proposal funds a permanent research station at",
      "Harbor Light with a network of six sensor buoys, giving researchers continuous",
      "readings of temperature, salinity, turbidity and dissolved oxygen for the first time.",
      "Data will be published openly within 24 hours of collection, and the station doubles",
      "as a field classroom for the regional university's marine science programme.",
    ], 64, 600);
    at.s1 = summary[1]; at.s2 = summary[2]; at.s4 = summary[4];

    w.heading("Objectives", 488);
    const objectives = w.para([
      "•   Establish year-round monitoring at six sites across the shelf",
      "•   Publish every reading as open data within 24 hours",
      "•   Train 40 students a year in field sampling methods",
      "•   Give fisheries managers an early warning of low-oxygen events",
    ], 64, 464, 11, 18);
    at.o2 = objectives[1]; at.o4 = objectives[3];

    w.heading("Key figures", 368);
    const stats: [string, string][] = [["$1.84M", "total budget"], ["18 months", "to first data"], ["6", "sensor buoys"]];
    stats.forEach(([big, small], i) => {
      const x = 64 + i * 164;
      page.drawRectangle({ x, y: 262, width: 152, height: 84, color: TINT, borderColor: RULE, borderWidth: 1 });
      at[`stat${i}`] = w.text(big, x + 14, 304, 24, bold, ACCENT);
      w.text(small, x + 14, 280, 10, font, MUTED);
    });
    w.para([
      "Figures are estimates prepared with the facilities team and will be confirmed",
      "during the design phase. Contingency is held at 10% of the capital budget.",
    ], 64, 226, 10, 14);
    w.footer(1);
  }

  // ---- page 2: budget
  {
    const page = doc.addPage([612, 792]);
    const w = writer(page, font, bold);
    w.heading("Budget", 720);
    w.para(["Capital and first-year operating costs, in US dollars."], 64, 698, 10);
    const rows: [string, string][] = [
      ["Station building and pier", "$720,000"],
      ["Sensor buoys (6) and moorings", "$486,000"],
      ["Data platform and telemetry", "$214,000"],
      ["Research vessel refit", "$168,000"],
      ["Staff, first year", "$252,000"],
    ];
    page.drawRectangle({ x: 64, y: 650, width: 484, height: 24, color: TINT });
    w.text("Item", 76, 658, 10, bold);
    w.text("Cost", 480, 658, 10, bold);
    rows.forEach(([item, cost], i) => {
      const y = 628 - i * 26;
      at[`row${i}`] = w.text(item, 76, y, 11);
      at[`cost${i}`] = w.text(cost, 480, y, 11);
      page.drawLine({ start: { x: 64, y: y - 9 }, end: { x: 548, y: y - 9 }, thickness: 0.5, color: RULE });
    });
    w.text("Total", 76, 490, 11, bold);
    at.total = w.text("$1,840,000", 468, 490, 11, bold);

    w.heading("Spend by quarter", 430);
    const bars = [120, 310, 420, 260, 180, 140];
    bars.forEach((h, i) => {
      const x = 96 + i * 72;
      page.drawRectangle({ x, y: 200, width: 40, height: h * 0.45, color: i === 2 ? ACCENT : rgb(0.62, 0.76, 0.82) });
      w.text(`Q${i + 1}`, x + 12, 184, 9, font, MUTED);
    });
    page.drawLine({ start: { x: 80, y: 200 }, end: { x: 532, y: 200 }, thickness: 0.75, color: MUTED });
    w.footer(2);
  }

  // ---- page 3: timeline
  {
    const page = doc.addPage([612, 792]);
    const w = writer(page, font, bold);
    w.heading("Timeline", 720);
    const phases: [string, number, number][] = [
      ["Design and permits", 0, 4], ["Station construction", 3, 10], ["Buoy deployment", 9, 13],
      ["Data platform", 6, 14], ["Commissioning", 14, 18],
    ];
    phases.forEach(([name, from, to], i) => {
      const y = 670 - i * 34;
      w.text(name, 64, y, 10.5);
      page.drawRectangle({ x: 220 + from * 17, y: y - 4, width: (to - from) * 17, height: 16, color: rgb(0.62, 0.76, 0.82) });
    });
    for (let m = 0; m <= 18; m += 3) w.text(`M${m}`, 214 + m * 17, 490, 8.5, font, MUTED);
    w.heading("Risks", 440);
    w.para([
      "Winter storms can delay pier construction by up to two months; the schedule holds",
      "a buffer in months 8–10. Buoy moorings need a seabed survey, booked for month 2.",
    ], 64, 416);
    w.footer(3);
  }

  const bytes = await doc.save();
  const pages: PageEntry[] = [0, 1, 2].map((i) => ({ id: `p${i}`, sourceDocId: "main", srcIndex: i, rotation: 0 }));
  const q = (p: Placed) => over(p);

  const annots: Annot[] = [
    annot("highlight", "p0", "#fde047", { quads: [q(at.s1), q(at.s2)], quotedText: "" },
      "This is the core argument. Lead with it in the board deck.", 0.45),
    annot("underline", "p0", "#2563eb", { quads: [over(at.o2)], quotedText: "" }),
    annot("highlight", "p0", "#86efac", { quads: [q(at.o4)], quotedText: "" }, "", 0.5),
    annot("squiggly", "p0", "#dc2626", { quads: [over(at.s4, 0, 250)], quotedText: "" }, "Is 24 hours realistic in winter?"),
    annot("note", "p0", "#f59e0b", { point: { x: 556, y: 598 }, icon: "Comment" },
      "Can we cite the 2011 survey here?"),
    annot("circle", "p0", "#dc2626", { rect: { x: at.stat0.x - 8, y: at.stat0.y - 10, w: at.stat0.w + 16, h: 40 }, width: 2, fill: null }),
    annot("freetext", "p0", "#111827", {
      rect: { x: 364, y: 146, w: 184, h: 46 },
      text: "Confirm the buoy count with the operations team before sign-off.",
      fontSize: 10, align: "left", bgColor: "#fef9c3", borderColor: "#ca8a04", borderWidth: 1,
    }, "Confirm the buoy count with the operations team before sign-off."),
    annot("arrow", "p0", "#ca8a04", { from: { x: 452, y: 192 }, to: { x: 404, y: 264 }, width: 2 }),

    annot("stamp", "p1", "#000000", { rect: { x: 398, y: 700, w: 150, h: 50 }, imageId: "approved", rotation: 0, isSignature: false }),
    annot("strikeout", "p1", "#dc2626", { quads: [over(at.row3)], quotedText: "" }, "Deferred to phase 2."),
    annot("freetext", "p1", "#b91c1c", {
      rect: { x: 250, y: 536, w: 150, h: 24 }, text: "Deferred to phase 2",
      fontSize: 10, align: "left", bgColor: null, borderColor: "#b91c1c", borderWidth: 1,
    }, "Deferred to phase 2"),
    annot("square", "p1", "#0ea5e9", { rect: { x: 232, y: 193, w: 56, h: 204 }, width: 2, fill: null }, "Peak spend: construction and buoys overlap."),
    annot("ink", "p1", "#16a34a", { paths: [[{ x: 450, y: 488 }, { x: 456, y: 480 }, { x: 466, y: 498 }]], width: 2.5 }),

    annot("highlight", "p2", "#fde047", { quads: [q({ x: 64, y: 416, w: 390, size: 11 })], quotedText: "" }, "", 0.45),
  ];

  const images = {
    approved: { id: "approved", bytes: readFileSync(join(dir, "approved.png")), mime: "image/png" as const },
  };
  const out = await buildSavedPdf({
    pages, annots, mainDocId: "main",
    getSource: (id) => (id === "main" ? { bytes, managedRefs: new Set() } : null),
    resolveImage: (id) => images[id as keyof typeof images] ?? null,
  });
  return out.bytes;
}

async function approvalForm() {
  const doc = await PDFDocument.create();
  doc.setTitle("Budget Approval Form");
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  const w = writer(page, font, bold);
  const form = doc.getForm();

  w.text("HARBOR LIGHT RESEARCH STATION", 64, 728, 9, bold, MUTED);
  w.text("Budget Approval Form", 64, 698, 26, bold);
  page.drawLine({ start: { x: 64, y: 680 }, end: { x: 548, y: 680 }, thickness: 1, color: RULE });

  const field = (label: string, name: string, value: string, x: number, y: number, width: number) => {
    w.text(label, x, y + 30, 9.5, bold, MUTED);
    const f = form.createTextField(name);
    f.setText(value);
    f.addToPage(page, { x, y, width, height: 24, font, borderColor: RULE, backgroundColor: TINT });
    f.setFontSize(11);
  };
  field("Approver name", "name", "Dana Whitfield", 64, 620, 230);
  field("Role", "role", "Director of Operations", 318, 620, 230);
  field("Date", "date", "24 September 2026", 64, 556, 230);

  w.text("Department", 318, 586, 9.5, bold, MUTED);
  const dept = form.createDropdown("department");
  dept.addOptions(["Coastal Science", "Facilities", "Education", "Finance"]);
  dept.select("Coastal Science");
  dept.addToPage(page, { x: 318, y: 556, width: 230, height: 24, font, borderColor: RULE, backgroundColor: TINT });
  dept.setFontSize(11);

  w.text("Decision", 64, 510, 9.5, bold, MUTED);
  const checks: [string, string, boolean][] = [
    ["approved", "Budget approved as submitted", true],
    ["contingency", "Release contingency funds", true],
    ["board", "Refer to the board for review", false],
  ];
  checks.forEach(([name, label, on], i) => {
    const y = 484 - i * 26;
    const box = form.createCheckBox(name);
    box.addToPage(page, { x: 64, y, width: 16, height: 16, borderColor: MUTED });
    if (on) box.check();
    w.text(label, 90, y + 4, 11);
  });

  w.text("Priority", 318, 510, 9.5, bold, MUTED);
  const priority = form.createRadioGroup("priority");
  ["High", "Normal", "Low"].forEach((option, i) => {
    priority.addOptionToPage(option, page, { x: 318 + i * 78, y: 484, width: 16, height: 16, borderColor: MUTED });
    w.text(option, 340 + i * 78, 488, 11);
  });
  priority.select("High");

  w.text("Notes", 64, 386, 9.5, bold, MUTED);
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.setText("Approved with the vessel refit deferred to phase 2. Revisit buoy count after the seabed survey in month 2.");
  notes.addToPage(page, { x: 64, y: 290, width: 484, height: 84, font, borderColor: RULE, backgroundColor: TINT });
  notes.setFontSize(11);

  page.drawLine({ start: { x: 64, y: 190 }, end: { x: 300, y: 190 }, thickness: 1, color: INK });
  w.text("Signature", 64, 174, 9.5, bold, MUTED);
  form.updateFieldAppearances(font);

  const bytes = await doc.save();
  const images = {
    signature: { id: "signature", bytes: readFileSync(join(dir, "signature.png")), mime: "image/png" as const },
  };
  const out = await buildSavedPdf({
    pages: [{ id: "f0", sourceDocId: "main", srcIndex: 0, rotation: 0 }],
    annots: [annot("stamp", "f0", "#000000", { rect: { x: 70, y: 192, w: 200, h: 42 }, imageId: "signature", rotation: 0, isSignature: true })],
    mainDocId: "main",
    getSource: (id) => (id === "main" ? { bytes, managedRefs: new Set() } : null),
    resolveImage: (id) => images[id as keyof typeof images] ?? null,
  });
  return out.bytes;
}

writeFileSync(join(dir, "Harbor Light Proposal.pdf"), await proposal());
writeFileSync(join(dir, "Budget Approval Form.pdf"), await approvalForm());
console.log(`wrote the proposal and the approval form to ${dir}`);
