/**
 * End-to-end UI verification.
 *
 * Runs the real frontend in a headless Chromium over CDP with Tauri's IPC
 * stubbed, so the whole pipeline is exercised for real — pdf.js worker, canvas
 * render, text layer, the annotation overlay's coordinate maths, and the save
 * path — and the PDF the app writes is pulled back out and checked with pdf-lib.
 *
 * This exists because the Tauri window itself can't be screenshotted or driven
 * in a sandbox without Screen Recording and Accessibility permissions.
 *
 *   npm run verify:ui
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PDFArray, PDFDocument, PDFName } from "pdf-lib";

const FRONTEND = "http://localhost:1420";
const CDP_PORT = 9223;
const OUT_DIR = "/tmp/pdfeditor-test";
const PDF_PATH = `${OUT_DIR}/report.pdf`;

const BROWSERS = [
  "/Applications/Brave Origin.app/Contents/MacOS/Brave Origin",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

let failures = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------- CDP

class Cdp {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners = new Map<string, ((params: any) => void)[]>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const slot = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (!slot) return;
        if (message.error) slot.reject(new Error(message.error.message));
        else slot.resolve(message.result);
        return;
      }
      for (const fn of this.#listeners.get(message.method) ?? []) fn(message.params);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: any) => void) {
    const list = this.#listeners.get(method) ?? [];
    list.push(fn);
    this.#listeners.set(method, list);
  }

  close() {
    this.#socket.close();
  }

  /** Evaluate an expression in the page and return its value. */
  async eval<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text);
    }
    return result.result.value as T;
  }
}

// -------------------------------------------------------------- the IPC stub

/** Injected before any app code runs, so `invoke` is answered locally. */
function stubSource(pdfBase64: string, path: string): string {
  return `
(() => {
  const b64 = "${pdfBase64}";
  const seed = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const path = ${JSON.stringify(path)};

  // A one-file in-memory filesystem: writes are readable back, so save/reopen
  // behaves the way it does against a real disk.
  const files = new Map([[path, seed]]);
  const metaFor = (p) => ({ path: p, name: p.split("/").pop(), size: files.get(p)?.length ?? 0, modified: null });

  window.__ipcCalls = [];
  window.__saved = null;
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push("unhandled: " + e.reason));

  let callbackId = 1;
  const callbacks = new Map();

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(cb, once) {
      const id = callbackId++;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, arg) { callbacks.get(id)?.cb(arg); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args, options) {
      window.__ipcCalls.push(cmd);
      switch (cmd) {
        case "resolve_cli_file": return path;
        case "read_file": {
          const stored = files.get(args.path);
          if (!stored) throw new Error("no such file: " + args.path);
          return stored.slice().buffer;
        }
        case "file_meta": return metaFor(args.path);
        case "recents_get": return [];
        case "recents_add": return [];
        case "signatures_list": return [];
        case "write_file": {
          const out = args instanceof Uint8Array ? args : new Uint8Array(args);
          const to = decodeURIComponent(
            (options && options.headers && options.headers["x-file-path"]) || path
          );
          files.set(to, out);
          let binary = "";
          for (const byte of out) binary += String.fromCharCode(byte);
          window.__saved = btoa(binary);
          window.__savedTo = to;
          window.__saveCount = (window.__saveCount || 0) + 1;
          return metaFor(to);
        }
        // The event plugin backs listen()/onDragDropEvent(); nothing to deliver.
        case "plugin:event|listen": return 0;
        case "plugin:event|unlisten": return null;
        default: return null;
      }
    },
  };
})();
`;
}

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  label: string,
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined as T);
    if (last !== undefined && predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

async function startVite(): Promise<ChildProcess> {
  const child = spawn("npm", ["run", "dev", "--", "--port", "1420", "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(
    "vite dev server",
    async () => {
      const response = await fetch(FRONTEND).catch(() => null);
      return response?.ok ?? false;
    },
    (ok) => ok,
    60000,
  );
  return child;
}

async function startBrowser(): Promise<{ child: ChildProcess; wsUrl: string }> {
  const binary = BROWSERS.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!binary) throw new Error("no Chromium-based browser found to drive");

  const child = spawn(
    binary,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${OUT_DIR}/browser-profile`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1440,960",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const target = await waitFor(
    "browser debug endpoint",
    async () => {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
      if (!response?.ok) return null;
      const targets = (await response.json()) as { type: string; webSocketDebuggerUrl: string }[];
      return targets.find((t) => t.type === "page") ?? null;
    },
    (t) => t !== null,
    40000,
  );

  return { child, wsUrl: target!.webSocketDebuggerUrl };
}

/** Synthesise a real pointer drag, so the app's own handlers do the work. */
async function drag(
  cdp: Cdp,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
) {
  const common = { button: "left" as const, buttons: 1, pointerType: "mouse" as const };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, ...common, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
      ...common,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, ...common, clickCount: 1 });
}

// --------------------------------------------------------------------- main

async function main() {
  console.log("UI verification (headless Chromium + stubbed Tauri IPC)\n");
  mkdirSync(OUT_DIR, { recursive: true });

  const pdfBase64 = readFileSync(PDF_PATH).toString("base64");

  console.log("starting vite…");
  const vite = await startVite();
  console.log("starting browser…");
  const browser = await startBrowser();
  const cdp = await Cdp.connect(browser.wsUrl);

  const consoleErrors: string[] = [];
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    consoleErrors.push(params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
  });

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    // `--window-size` is unreliable under headless=new, and the app's layout is
    // built for a desktop window (Tauri enforces a 900px minimum). Without this
    // the viewer gets squeezed to nothing between the two side panels.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: stubSource(pdfBase64, PDF_PATH),
    });

    console.log("loading app…\n");
    await cdp.send("Page.navigate", { url: FRONTEND });

    // --- open + render
    await waitFor(
      "document to open",
      () => cdp.eval<number>("document.querySelectorAll('canvas').length"),
      (n) => n > 0,
    );

    const ipcCalls = await cdp.eval<string[]>("window.__ipcCalls");
    check("opened the PDF handed to it on argv, over IPC", () => {
      assert.ok(ipcCalls.includes("resolve_cli_file"), "never asked for the CLI file");
      assert.ok(ipcCalls.includes("read_file"), "never read the file");
    });

    const pageCount = await cdp.eval<number>("document.querySelectorAll('[data-page-index]').length");
    check("rendered all 4 pages of the plan", () => assert.equal(pageCount, 4));

    // Sample the canvas: a blank page means rendering silently failed.
    const inkRatio = await waitFor(
      "page pixels",
      () =>
        cdp.eval<number>(`(() => {
          const c = document.querySelector('canvas');
          if (!c || !c.width) return 0;
          const ctx = c.getContext('2d');
          const { data } = ctx.getImageData(0, 0, c.width, Math.min(c.height, 400));
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) dark++;
          }
          return dark / (data.length / 4);
        })()`),
      (ratio) => ratio > 0.001,
    );
    check("page canvas has actual content drawn on it", () =>
      assert.ok(inkRatio > 0.001, `only ${(inkRatio * 100).toFixed(3)}% non-white pixels`),
    );

    const spans = await cdp.eval<number>(
      "document.querySelectorAll('.textLayer span').length",
    );
    check("text layer was built (selection + search depend on it)", () =>
      assert.ok(spans > 10, `only ${spans} text spans`),
    );

    const thumbs = await waitFor(
      "thumbnails",
      () => cdp.eval<number>("document.querySelectorAll('.shot img').length"),
      (n) => n > 0,
    );
    check("sidebar rendered page thumbnails", () => assert.ok(thumbs > 0));

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((r: any) =>
      writeFileSync(`${OUT_DIR}/ui-opened.png`, Buffer.from(r.data, "base64")),
    );

    // --- highlight from a real text selection
    await cdp.eval("document.querySelector('[title^=\"Highlight\"]').click()");
    const selected = await cdp.eval<boolean>(`(() => {
      const spans = [...document.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim().length > 8);
      if (spans.length < 2) return false;
      const range = document.createRange();
      range.setStart(spans[1].firstChild, 0);
      range.setEnd(spans[2].firstChild, spans[2].firstChild.length);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // The markup tools commit on pointerup, wherever it happens.
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`);
    assert.ok(selected, "could not build a text selection");

    const highlightCount = await waitFor(
      "highlight annotation",
      () => cdp.eval<number>("document.querySelectorAll('.highlight-layer path').length"),
      (n) => n > 0,
    );
    check("selecting text with the highlight tool creates a highlight", () =>
      assert.ok(highlightCount > 0),
    );

    // --- freehand ink by dragging on the page
    await cdp.eval("document.querySelector('[title^=\"Freehand pen\"]').click()");
    /*
     * Only the part of the page inside the viewport can be clicked — synthesised
     * mouse events are dispatched in viewport coordinates, so a point below the
     * fold simply hits nothing. At fit-width a letter page is taller than the
     * window, so all drags are placed within the visible band.
     */
    const box = await cdp.eval<{ x: number; y: number; w: number; top: number; bottom: number }>(`(() => {
      const r = document.querySelector('[data-page-index="0"]').getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        top: Math.max(r.top, 0) + 20,
        bottom: Math.min(r.bottom, window.innerHeight) - 20,
      };
    })()`);
    const band = box.bottom - box.top;
    assert.ok(band > 120, `visible page band too short: ${band}px`);
    const atY = (fraction: number) => box.top + band * fraction;

    await drag(
      cdp,
      { x: box.x + box.w * 0.25, y: atY(0.55) },
      { x: box.x + box.w * 0.62, y: atY(0.68) },
      12,
    );

    const inkPaths = await waitFor(
      "ink annotation",
      () => cdp.eval<number>("document.querySelectorAll('.annot-layer path[stroke-linecap=\"round\"]').length"),
      (n) => n > 0,
    );
    check("dragging with the pen creates an ink annotation", () => assert.ok(inkPaths > 0));

    // --- rectangle, to cover the drag-out shape path
    await cdp.eval("document.querySelector('[title^=\"Rectangle\"]').click()");
    await drag(
      cdp,
      { x: box.x + box.w * 0.15, y: atY(0.78) },
      { x: box.x + box.w * 0.45, y: atY(0.92) },
    );
    const rects = await waitFor(
      "rectangle annotation",
      () => cdp.eval<number>("document.querySelectorAll('.annot-layer rect[stroke]').length"),
      (n) => n > 0,
    );
    check("dragging with the rectangle tool creates a shape", () => assert.ok(rects > 0));

    const listed = await cdp.eval<number>(`(() => {
      document.querySelector('[title="Annotations"]').click();
      return 0;
    })()`);
    void listed;
    await sleep(300);
    const listRows = await cdp.eval<number>("document.querySelectorAll('.group .row').length");
    check("annotations appear in the sidebar list", () => assert.ok(listRows >= 3, `${listRows} rows`));

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((r: any) =>
      writeFileSync(`${OUT_DIR}/ui-annotated.png`, Buffer.from(r.data, "base64")),
    );

    // --- rotate a page, to exercise the rebuild save path
    await cdp.eval(`(() => {
      document.querySelector('[title="Pages"]').click();
      return true;
    })()`);
    await sleep(300);
    await cdp.eval("document.querySelector('[title=\"Rotate right\"]').click()");
    await sleep(800);

    /*
     * Fit-width has to account for rotation — both the user's and the page's own
     * `/Rotate`. Getting that wrong leaves a rotated page wider than the viewer,
     * which is invisible to every other assertion here.
     */
    const fit = await cdp.eval<{ page: number; viewer: number; zoom: string }>(`(() => {
      const page = document.querySelector('[data-page-index="0"]').getBoundingClientRect().width;
      const viewer = document.querySelector('.viewer').clientWidth;
      return { page, viewer, zoom: document.querySelector('.zoom').textContent.trim() };
    })()`);
    check("a rotated page still fits the viewer width", () =>
      assert.ok(
        fit.page <= fit.viewer,
        `page is ${Math.round(fit.page)}px wide in a ${fit.viewer}px viewer at ${fit.zoom}`,
      ),
    );

    // --- save
    await cdp.eval("document.querySelector('[title^=\"Save (\"]').click()");
    const savedBase64 = await waitFor(
      "saved bytes",
      () => cdp.eval<string | null>("window.__saved"),
      (value) => typeof value === "string" && value.length > 0,
      30000,
    );

    const savedBytes = Buffer.from(savedBase64!, "base64");
    writeFileSync(`${OUT_DIR}/saved.pdf`, savedBytes);

    const saved = await PDFDocument.load(new Uint8Array(savedBytes), { ignoreEncryption: true });
    const subtypes: string[] = [];
    for (const page of saved.getPages()) {
      const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!array) continue;
      for (let i = 0; i < array.size(); i++) {
        const dict: any = array.lookup(i);
        const name = dict?.lookupMaybe?.(PDFName.of("Subtype"), PDFName);
        if (name) subtypes.push(name.decodeText());
      }
    }

    check("saved file is a valid PDF with the right page count", () =>
      assert.equal(saved.getPageCount(), 4),
    );
    check("page rotation reached the saved file", () =>
      assert.ok(
        saved.getPages().some((p) => p.getRotation().angle === 90),
        `rotations: ${saved.getPages().map((p) => p.getRotation().angle).join(",")}`,
      ),
    );
    check("highlight was written as a real /Highlight annotation", () =>
      assert.ok(subtypes.includes("Highlight"), `got: ${subtypes.join(", ")}`),
    );
    check("ink was written as a real /Ink annotation", () =>
      assert.ok(subtypes.includes("Ink"), `got: ${subtypes.join(", ")}`),
    );
    check("rectangle was written as a real /Square annotation", () =>
      assert.ok(subtypes.includes("Square"), `got: ${subtypes.join(", ")}`),
    );

    // --- the app reopens what it wrote, so the marks come back editable
    const reopened = await waitFor(
      "annotations after reopen",
      () =>
        cdp.eval<{ highlights: number; rows: number }>(`(() => ({
          highlights: document.querySelectorAll('.highlight-layer path').length,
          rows: document.querySelectorAll('.group .row').length,
        }))()`),
      (state) => state.highlights > 0,
      25000,
    ).catch(() => ({ highlights: 0, rows: 0 }));

    check("reopening after save brings the annotations back as editable", () =>
      assert.ok(reopened.highlights > 0, "highlight did not survive the save/reopen cycle"),
    );

    // Click, then read on a later turn — Svelte renders asynchronously.
    await cdp.eval('document.querySelector(\'[title="Annotations"]\').click()');
    const editableKinds = await waitFor(
      "annotation list rows",
      () =>
        cdp.eval<string[]>(
          "[...document.querySelectorAll('.group .row .kind')].map((n) => n.textContent.trim())",
        ),
      (kinds) => kinds.length >= 3,
    ).catch(() => [] as string[]);
    check("every written kind came back in the annotation list", () => {
      for (const kind of ["Highlight", "Drawing", "Rectangle"]) {
        assert.ok(editableKinds.includes(kind), `${kind} missing; got: ${editableKinds.join(", ")}`);
      }
    });

    check("no uncaught errors in the page", () => {
      assert.deepEqual(consoleErrors, []);
    });
    const pageErrors = await cdp.eval<string[]>("window.__errors");
    check("no unhandled rejections", () => assert.deepEqual(pageErrors, []));

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((r: any) =>
      writeFileSync(`${OUT_DIR}/ui-saved.png`, Buffer.from(r.data, "base64")),
    );

    console.log(`\nscreenshots in ${OUT_DIR}/ui-*.png`);
  } finally {
    cdp.close();
    browser.child.kill("SIGKILL");
    vite.kill("SIGTERM");
  }

  console.log(failures === 0 ? "\nAll UI checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
