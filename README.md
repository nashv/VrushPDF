# PDF Editor

A desktop PDF viewer and annotation editor built with Tauri 2, SvelteKit 5 and
TypeScript. Annotations are written as **standard PDF annotation objects** with
real appearance streams, so they stay editable in this app *and* in Preview,
Acrobat and Chrome — nothing is flattened into page graphics.

## Features

**Viewing** — continuous scroll with page virtualisation, fit-width / fit-page /
stepped zoom, page rotation, selectable text, whole-document search, bookmarks,
page thumbnails.

**Annotating** — text-selection highlight, underline, strikeout and squiggly;
freehand pen and eraser; rectangle, ellipse, line and arrow; text boxes; sticky
notes; image stamps; and reusable drawn signatures. Each has colour, opacity,
stroke width and comment controls, with snapshot undo/redo across everything.

**Pages** — rotate, delete, drag to reorder, keep a selected range, and merge
another PDF in.

## Running

```sh
npm install
npm run tauri dev          # desktop app
npm run tauri dev -- -- -- path/to/file.pdf   # …opening a file straight away
```

The app also opens files via drag-and-drop, Finder's "Open With", and `⌘O`.

## Verifying

```sh
npm run check              # svelte-check
npm run verify:roundtrip   # annotation persistence (no browser needed)
npm run verify:ui          # the real frontend, driven in headless Chromium
cargo check --manifest-path src-tauri/Cargo.toml
```

`verify:roundtrip` writes one annotation of every kind, reads it back, and
asserts geometry, colour, opacity and text all survive — plus that a second save
replaces rather than duplicates, that form widgets are untouched, and that page
reorder/rotate/delete keep annotations on the right pages.

`verify:ui` runs the actual app in a headless browser with Tauri's IPC stubbed,
then inspects the PDF it writes. It needs a Chromium-based browser and a fixture:

```sh
npm run fixture:pdf        # writes /tmp/pdfeditor-test/report.pdf
```

## How it works

**Coordinates.** Every annotation is stored in PDF user space (origin
bottom-left, 1/72"), so it is immune to zoom and rotation. The overlay applies
pdf.js's `viewport.transform` once to an SVG `<g>`, which handles scale,
rotation and the Y-flip together — and makes stroke widths scale with the page
for free. Text boxes, note pins and resize handles are HTML instead, positioned
in CSS pixels, because the SVG layer is mirrored and `contenteditable` beats SVG
text for editing.

**Page plan.** Annotations reference a stable page id, never a page index:

```ts
type PageEntry = { id; sourceDocId; srcIndex; rotation }
```

Reordering, deleting or merging pages is a permutation of `PageEntry[]`, so it
can never silently retarget an annotation.

**Saving** takes one of two paths. When the plan still matches the file, the
original document is loaded and patched in place, which preserves outlines, form
fields and everything untouched. When pages have been rotated, reordered or
merged, a fresh document is assembled with `copyPages`. Both end in the same
`/Annots` surgery: the dictionaries we took ownership of at import time are
dropped and re-emitted from the model, matched by object number so links, form
widgets and subtypes we never understood are left exactly as found.

**Rendering vs. ownership.** Pages render with `annotationMode: ENABLE_STORAGE`,
and every annotation imported into the editable model is marked `noView` in
pdf.js's annotation storage. So the overlay draws what we own, and pdf.js keeps
drawing straight from the file whatever we don't.

### Known limitations

- **Stamps are not re-imported.** Recovering editable pixels from an appearance
  stream isn't something this can do faithfully, so stamp annotations are left
  untouched in the file. They still display correctly and survive saves; they
  just aren't editable again after a reopen.
- **Encrypted PDFs are saved decrypted.** The file opens with the password, but
  `pdf-lib` writes it back without encryption. The toolbar says so when it
  applies.
- **The rebuild save path loses document-level structure.** `copyPages` only
  moves the page tree, so outlines don't survive page operations. The fast path
  (no page ops) keeps everything.
- **Search highlight positions are approximate within a text run** — matches are
  placed by character proportion rather than per-glyph metrics — and rotated text
  runs are skipped for highlighting.

## Layout

```
src/lib/pdf/           pdf.js setup, rendering, text layer, search
src/lib/annotations/   model, hit-testing, appearance streams, import/write/save
src/lib/state/         doc, edits (undoable), viewer, images, search, session
src/lib/components/    toolbar, sidebar, viewer, page, overlay, inspector
src-tauri/src/         filesystem, recents and signature-store commands
scripts/               asset copy + the two verification suites
```

`src/lib/annotations/` deliberately has no Svelte or `$lib` imports, which is
what lets `verify:roundtrip` load it under plain Node.
