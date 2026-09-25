# VrushPDF

A desktop PDF viewer and annotation editor built with Tauri 2, SvelteKit 5 and
TypeScript. Annotations are written as **standard PDF annotation objects** with
real appearance streams, so they stay editable in this app *and* in Preview,
Acrobat and Chrome — nothing is flattened into page graphics.

## Features

**Viewing** — tabs for multiple open documents, continuous scroll with page
virtualisation, fit-width / fit-page / stepped zoom, page rotation, selectable
text, whole-document search, bookmarks, page thumbnails. The sidebar and
properties panel are resizable by dragging the divider (double-click to reset)
and remember their widths; the thumbnail grid adds columns as the sidebar
widens. **View ▸ Show Button Labels** puts a caption under every toolbar button,
macOS "Icon and Text" style. The tab bar sits below the toolbar and above the
page, where AppKit puts a window's tabs — not above it, which is the browser
convention.

**Annotating** — text-selection highlight, underline, strikeout and squiggly;
freehand pen and eraser; rectangle, ellipse, line and arrow; text boxes;
comments; image stamps; built-in APPROVED / REVIEWED / DRAFT / CONFIDENTIAL /
FINAL stamps; and reusable drawn signatures. Each has colour, opacity,
stroke width and comment controls, with snapshot undo/redo across everything.

**Forms** — fill in text fields, checkboxes, radio buttons, dropdowns and list
boxes with the Select tool. What you type goes into the PDF's real form fields
on save, with regenerated appearances, so Preview, Acrobat and Chrome show it
too. Filling is undoable like any edit: each field typed into, from click to
leaving it, is one step, and Escape abandons it. Only the opened file's own
fields are fillable; a merged-in document's fields stay as drawn. Signature
fields, push buttons and JavaScript-driven behaviour (calculations, formatting)
are not supported.

**Pages** — insert blank pages, insert or append another PDF, rotate, delete,
keep a selected range, and reorder either by dragging a thumbnail or with the
move buttons. Everything acts on the pages ticked in the thumbnail strip, or on
the current page when nothing is ticked, and each is a single undo step.

**Menus** — a native menu bar covering every action in the app: the global menu
bar on macOS, the window's own menu strip on Windows and Linux. Items enable,
tick and relabel themselves from app state, so Undo reads *Undo Add annotation*
and the Tools menu shows which tool is armed.

## Running

```sh
npm install
npm run tauri dev          # desktop app
npm run tauri dev -- -- -- path/to/file.pdf   # …opening a file straight away
```

The app also opens files via drag-and-drop, Finder's "Open With", and `⌘O`.
Dropping several PDFs at once opens each in its own tab.

### Shortcuts worth knowing

`⌘T` new tab · `⌘W` close tab (prompts if unsaved) · `⌘1`–`⌘9` jump to a tab ·
`⌃Tab` / `⌘⇧[` `⌘⇧]` cycle tabs · `⌘O` open · `⌘S` / `⇧⌘S` save · `⌘Z` / `⇧⌘Z`
undo · `⌘F` find · `⌘0` fit page · `⌥⌘0` actual size · `⌘\` toggle sidebar ·
`⌥⌘←` `⌥⌘→` page back/forward · `Home` / `End` first/last page · `⌥⌘↑` `⌥⌘↓`
move the selected page · `⇧⌘−` `⇧⌘=` rotate.
Single letters pick tools: `V` select, `H` pan, `T` text, `1`–`4` markup, `P`
pen, `E` erase, `R`/`O`/`L`/`A` shapes, `X` text box, `N` comment.

Everything with a modifier is a menu accelerator owned by the OS; the single
letters are handled in the app and ignored while a text field has focus.

## Verifying

```sh
npm run check              # svelte-check
npm run verify:roundtrip   # annotation persistence (no browser needed)
npm run verify:ui          # the real frontend, driven in headless Chromium
cargo test --manifest-path src-tauri/Cargo.toml   # license key + trial checks
cargo test --manifest-path keygen/Cargo.toml      # the keygen
npm run tauri build      # the real release bundle
```

`verify:roundtrip` writes one annotation of every kind, reads it back, and
asserts geometry, colour, opacity and text all survive — plus that a second save
replaces rather than duplicates, that form widgets are untouched, and that page
reorder/rotate/delete keep annotations on the right pages.

`verify:ui` runs the actual app in a headless browser with Tauri's IPC stubbed
by a small in-memory filesystem, then inspects the PDF it writes. As well as
rendering and annotating it covers tab isolation (per-tab documents, annotations
and undo), the unsaved-changes prompt, and layout assertions — that each panel
toggle sits on the edge it controls, that sidebar tab labels aren't clipped, and
that the style controls stay on screen at 1100px. It needs a Chromium-based
browser and the fixtures:

```sh
npm run fixture:pdf        # writes report.pdf, appendix.pdf and form.pdf to /tmp/vrushpdf-test
```

### Platform fit

`app.css` carries one token set per desktop: macOS keeps 13px text, 6px corners
and 28px controls; Windows switches to Segoe UI Variable at 14px with Fluent's
tighter 4px corners and taller controls; Linux to `system-ui`/Cantarell. An
inline script in `app.html` tags `<html data-platform>` before the first paint,
so nothing flashes the wrong metrics. Where the engine supports the `AccentColor`
system colour the UI follows the accent chosen in system settings, falling back
to the built-in blue otherwise.

Below 900px the sidebar and properties panel overlay the page instead of
squeezing it, the resize handles disappear, and the top toolbar row scrolls. The
window minimum is 640×480.

> The Windows and Linux token sets are covered by the UI suite, which forces
> each `data-platform` value, but they have not been run on real Windows or
> Linux hardware.

### Settings

**⌘,** opens Settings. *Open files in the running app* decides whether
double-clicking a PDF adds a tab to the window you already have or starts
another copy; it is stored in `settings.json` under the app config directory
rather than in `localStorage`, because Rust reads it while the app is still
being assembled and no webview exists yet to ask. On macOS the control is shown
but disabled: the system never launches a second copy of a bundled app, and
delivers the file as an Apple Event instead.

### Licensing

VrushPDF is paid: a one-time purchase through Paddle, with a personal license key. There is no license server.
- **Trial:** a new install gets 14 days of everything. After that, PDFs still open and read, but saving, annotating and page edits need a key. The toolbar shows the days left; **VrushPDF ▸ Enter License…** (Help menu on Windows and Linux) takes a key or opens the checkout.
- **Keys:** a key is `VRSH.<payload>.<signature>`. The payload names the buyer's email, and the signature is Ed25519 (`src-tauri/src/license_key.rs`). The app checks it offline against `src-tauri/src/license_key.pub` and never uses the network. Keys aren't tied to a machine; the email shown in the app is what discourages sharing.
- **Revoking:** add a key's id to `src-tauri/src/revoked_keys.txt`. It stops working from the next release.
- **Enforcement:** the check that actually stops an expired copy is in Rust, on `write_file` and `signature_save`. The frontend (`src/lib/state/license.svelte.ts`) only disables tools and explains.

This keeps honest people honest. It does not survive someone patching the binary, and no offline scheme can.

**Issuing keys** with the keygen (`keygen/`, run on your own machine):

```sh
npm run keygen -- init                       # once: signing key + license_key.pub
npm run -s keygen -- issue buyer@example.com # prints the key; email it to them
npm run -s keygen -- show <key>              # who a key is for, and its id
```

`init` writes the private key to `~/.vrushpdf-signing-key`; set `VRUSHPDF_SIGNING_KEY` to use a different path. It never goes in the repo. Back it up: without it you can't issue keys that already-released builds accept. Running `init --force` makes a new pair, and every key issued before that stops working. `issue` refuses to run if the signing key doesn't match the committed `license_key.pub`.

When Paddle reports a sale, run `issue` with the buyer's email and send them the key. To license your own debug build, issue one to yourself.

## Distribution

Tauri cannot cross-compile, so each installer is built on its own OS by
`.github/workflows/release.yml`. To cut a release:

```sh
npm version 0.2.0 --no-git-tag-version   # tauri.conf.json reads this
git commit -am "Release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The workflow then builds on four runners and opens a **draft** GitHub Release
with everything attached:

| Platform | Artifacts |
| --- | --- |
| macOS (Apple Silicon, Intel) | `.dmg`, `.app` |
| Windows | `.msi` (WiX), `-setup.exe` (NSIS) |
| Linux x86-64 | `.deb`, `.rpm`, `.AppImage` |

Run the workflow manually (`workflow_dispatch`) to build without publishing —
the installers come back as workflow artifacts. It takes a `platforms` input
(`all`, `no-macos`, `macos`, `windows`, `linux`) so iterating on one platform's
build failure doesn't pay for macOS runners at 10x:

```sh
gh workflow run release.yml -f platforms=no-macos
```

arm64 Linux is left out because GitHub's free arm64 runner is public-repo only.

The matrix jobs only *build*; a single `release` job afterwards assembles the
draft from their artifacts. Letting each job create the release does not work:
a draft cannot be looked up by tag, so parallel jobs each make their own and the
installers scatter across several drafts.

> `RunEvent::Opened` is macOS-only, so anything added to the Rust run-loop
> handler needs a `#[cfg]` guard. A local `cargo check` only ever targets the
> host, so CI is what catches this.

To build the macOS bundle locally: `npm run tauri build`.

### These builds are unsigned

There is no Apple Developer ID or Windows certificate behind them, so:

- **macOS** — "cannot be opened because the developer cannot be verified".
  Right-click → Open, or System Settings → Privacy & Security → Open Anyway.
  The bundle *is* ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), which is
  what stops Apple Silicon from rejecting it outright as damaged.
- **Windows** — SmartScreen warns about an unknown publisher: More info → Run
  anyway.
- **Linux** — nothing special. AppImages need `chmod +x` first.

Turning signing on is additive: add the Apple certificate and notarization
secrets (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_TEAM_ID`, …) and a Windows
certificate to the repository, and replace the ad-hoc identity with a
Developer ID.

> If `tauri build` fails on macOS with `failed to run xattr`, a python.org
> install is shadowing Apple's `/usr/bin/xattr` on your `PATH` with one that
> has no `-r` flag. Put `/usr/bin` first for the build.

## How it works

**Tabs own their state.** Each tab holds a complete, independent copy of the
per-document state — its own pdf.js worker and page cache, page plan,
annotations, undo history, zoom and scroll offset (`state/workspace.svelte.ts`).
Only the tool/style selection and the signature library are app-wide, because
picking the highlighter should survive a tab switch. Inactive tabs are
unmounted and their scroll position restored on return, so memory stays bounded
by what you are actually looking at.

**Reordering is pointer-based, not HTML5 drag-and-drop.** The window sets
`dragDropEnabled: true` so that dropping a PDF onto it opens the file. That makes
wry install an `NSDraggingDestination` override on the webview, and Tauri's
handler returns `true` for every drag event — wry only forwards to `super`, and
so lets WebKit see the drag, when it returns false. The upshot is that `dragover`
and `drop` never fire inside the page, and any `draggable="true"` reorder looks
like it works while doing nothing. `lib/reorder.svelte.ts` drives both the
thumbnail strip and the tab strip from pointer events instead, which never open
a native dragging session — and unlike HTML5 drags can be synthesised in
`verify:ui`, so both reorders are now covered by tests.

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
src/lib/annotations/   model, hit-testing, appearance streams, blank pages,
                       import/write/save
src/lib/state/         workspace (tabs), doc, edits (undoable), viewer,
                       images, recents, search, session
src/lib/menu/          the native menu bar and its state sync
src/lib/reorder.svelte.ts  pointer-based drag-to-reorder
src/lib/stamps.ts      the built-in stamps, drawn to PNG at startup
src/lib/components/    toolbar, sidebar, viewer, page, overlay, inspector
src-tauri/src/         filesystem, recents and signature-store commands,
                       licensing (license.rs), macOS glass backdrop (glass.rs)
keygen/                issues license keys locally (shares license_key.rs)
scripts/               asset copy + the two verification suites
```

`src/lib/annotations/` deliberately has no Svelte or `$lib` imports, which is
what lets `verify:roundtrip` load it under plain Node.
