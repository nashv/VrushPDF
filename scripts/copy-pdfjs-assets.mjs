// pdf.js needs its CMap tables (CJK encodings) and the base-14 standard font
// programs available over HTTP. Copy them out of node_modules into static/ so
// they ship with the bundle and the app keeps working offline.
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "static", "pdfjs");

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(src))) {
  console.warn("[pdfjs-assets] pdfjs-dist not installed yet, skipping");
  process.exit(0);
}

await mkdir(dest, { recursive: true });
for (const name of ["cmaps", "standard_fonts"]) {
  await rm(join(dest, name), { recursive: true, force: true });
  await cp(join(src, name), join(dest, name), { recursive: true });
}
console.log(`[pdfjs-assets] copied cmaps + standard_fonts to ${dest}`);
