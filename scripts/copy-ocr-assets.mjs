// Tesseract.js fetches its worker, its WebAssembly engine and the language
// models over HTTP, from a CDN unless told otherwise. Copy them out of
// node_modules into static/ocr/ so they ship with the bundle and OCR works
// offline. Too large to commit (~24 MB), so static/ocr is git-ignored and this
// runs from `prepare`, which `npm ci` in CI runs too.
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");
const dest = join(root, "static", "ocr");

/** Must match `OCR_LANGUAGES` in src/lib/ocr/engine.ts. */
const LANGUAGES = ["eng", "deu", "fra", "spa", "ita", "nld"];

/*
 * The LSTM-only engine builds: the compact `best_int` models are LSTM-only, and
 * the worker picks one of these three by the CPU features it finds.
 */
const CORES = [
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-lstm.wasm.js",
];

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(join(modules, "tesseract.js")))) {
  console.warn("[ocr-assets] tesseract.js not installed yet, skipping");
  process.exit(0);
}

await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, "core"), { recursive: true });
await mkdir(join(dest, "lang"), { recursive: true });

await cp(join(modules, "tesseract.js", "dist", "worker.min.js"), join(dest, "worker.min.js"));
for (const core of CORES) {
  await cp(join(modules, "tesseract.js-core", core), join(dest, "core", core));
}
for (const lang of LANGUAGES) {
  const file = `${lang}.traineddata.gz`;
  await cp(join(modules, "@tesseract.js-data", lang, "4.0.0_best_int", file), join(dest, "lang", file));
}
console.log(`[ocr-assets] copied worker, ${CORES.length} engines and ${LANGUAGES.length} languages to ${dest}`);
