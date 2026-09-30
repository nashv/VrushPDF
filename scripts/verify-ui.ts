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
const OUT_DIR = "/tmp/vrushpdf-test";
const PDF_PATH = `${OUT_DIR}/report.pdf`;
const PDF_PATH_2 = `${OUT_DIR}/appendix.pdf`;
const FORM_PATH = `${OUT_DIR}/form.pdf`;
const STAMP_PNG_PATH = `${OUT_DIR}/stamp.png`;

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
function stubSource(seeds: Record<string, string>, cliPath: string): string {
  return `
(() => {
  /*
   * The browser profile is reused between runs, so persisted settings would
   * carry over — the panel widths in particular, which several checks assume
   * start at their defaults. Wipe them before any app code runs.
   */
  try { window.localStorage.clear(); } catch {}

  const seeds = ${JSON.stringify(seeds)};
  const path = ${JSON.stringify(cliPath)};

  // An in-memory filesystem: writes are readable back, so save/reopen behaves
  // the way it does against a real disk.
  const files = new Map(
    Object.entries(seeds).map(([p, b64]) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]),
  );
  const metaFor = (p) => ({ path: p, name: p.split("/").pop(), size: files.get(p)?.length ?? 0, modified: null });

  // The open/save dialogs are native, so the test pre-loads what they return.
  window.__nextOpen = null;
  window.__nextSave = null;

  window.__ipcCalls = [];
  window.__saved = null;
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push("unhandled: " + e.reason));

  let callbackId = 1;
  const callbacks = new Map();

  // The native menu is built over IPC too. Answering these keeps the real
  // install path running here instead of dropping into its catch, so the menu
  // definition is exercised on every run.
  let menuRid = 1000;
  window.__menu = { created: [], ids: [], setAs: null, setEnabled: 0, setChecked: 0, setText: 0 };

  window.__license = {
    state: "trial", daysLeft: 14, email: null, keyId: null,
    buyUrl: "https://example.com/buy",
  };

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
        case "opened_files_take": return [];
        case "read_file": {
          const stored = files.get(args.path);
          if (!stored) throw new Error("no such file: " + args.path);
          return stored.slice().buffer;
        }
        case "file_meta": return metaFor(args.path);
        case "recents_get": return [];
        case "settings_get": return { singleInstance: true };
        case "settings_set": return null;
        // A trial by default, so every earlier section runs with editing on
        // and the trial capsule is on screen. The license section changes it.
        case "license_status": return window.__license;
        case "license_activate":
          window.__activatedWith = args.key;
          window.__license = {
            state: "licensed", daysLeft: null, email: "buyer@example.com",
            keyId: "80232a87", buyUrl: "https://example.com/buy",
          };
          return window.__license;
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
        case "plugin:app|version": return "0.0.0-test";
        case "plugin:menu|new": {
          window.__menu.created.push(args.kind);
          if (args.options && args.options.id) window.__menu.ids.push(args.options.id);
          return [menuRid++, (args.options && args.options.id) || "menu-" + menuRid];
        }
        case "plugin:menu|append":
        case "plugin:menu|remove_at": return null;
        case "plugin:menu|items": return [];
        case "plugin:menu|set_as_app_menu": window.__menu.setAs = "app"; return null;
        case "plugin:menu|set_as_window_menu": window.__menu.setAs = "window"; return null;
        case "plugin:menu|set_enabled": window.__menu.setEnabled++; return null;
        case "plugin:menu|set_checked": window.__menu.setChecked++; return null;
        case "plugin:menu|set_text": window.__menu.setText++; return null;
        // The event plugin backs listen()/onDragDropEvent(); nothing to deliver.
        case "plugin:event|listen": return 0;
        case "plugin:event|unlisten": return null;
        // Native dialogs, answered from window.__nextOpen / __nextSave.
        case "plugin:dialog|open": {
          const next = window.__nextOpen;
          window.__nextOpen = null;
          return next;
        }
        case "plugin:dialog|save": {
          const next = window.__nextSave;
          window.__nextSave = null;
          return next;
        }
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

/**
 * Wait until a document is mounted and interactive.
 *
 * Saving reopens the file from disk, and in that gap `isOpen` is false: the
 * sidebar, viewer, inspector and their resize handles are all unmounted and the
 * toolbar is disabled. Any section that follows a save has to wait this out, or
 * it silently operates on a half-torn-down UI.
 */
async function waitForDocument(cdp: Cdp) {
  await waitFor(
    "the document to be mounted and interactive",
    () =>
      cdp.eval<boolean>(`(() => {
        const btn = document.querySelector('[title^="Save ("]');
        return !!document.querySelector('.viewer') && !!btn && !btn.disabled;
      })()`),
    (ready) => ready === true,
    25000,
  );
}

/** Centre of a reorderable item, in viewport coordinates. */
async function itemCentre(cdp: Cdp, selector: string, index: number) {
  return cdp.eval<{ x: number; y: number; visible: boolean } | null>(`(() => {
    const el = document.querySelector('${selector}[data-reorder-index="${index}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      visible: r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
    };
  })()`);
}

// --------------------------------------------------------------------- main

async function main() {
  console.log("UI verification (headless Chromium + stubbed Tauri IPC)\n");
  mkdirSync(OUT_DIR, { recursive: true });

  const seeds = {
    [PDF_PATH]: readFileSync(PDF_PATH).toString("base64"),
    [PDF_PATH_2]: readFileSync(PDF_PATH_2).toString("base64"),
    [FORM_PATH]: readFileSync(FORM_PATH).toString("base64"),
    [STAMP_PNG_PATH]: readFileSync(STAMP_PNG_PATH).toString("base64"),
  };

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
      source: stubSource(seeds, PDF_PATH),
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

    // --- layout: each panel toggle belongs on the edge it controls
    const toggles = await cdp.eval<{ sidebar: number; inspector: number; mid: number }>(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      return {
        sidebar: box('[title^="Toggle sidebar"]'),
        inspector: box('[title^="Toggle properties"]'),
        mid: window.innerWidth / 2,
      };
    })()`);
    check("sidebar toggle sits on the left, inspector toggle on the right", () => {
      assert.ok(
        toggles.sidebar < toggles.mid,
        `sidebar toggle at ${Math.round(toggles.sidebar)} is not left of ${toggles.mid}`,
      );
      assert.ok(
        toggles.inspector > toggles.mid,
        `inspector toggle at ${Math.round(toggles.inspector)} is not right of ${toggles.mid}`,
      );
    });

    const labelOverflow = await cdp.eval<{ text: string; over: number }[]>(`
      [...document.querySelectorAll('.tab-label')].map((n) => ({
        text: n.textContent.trim(),
        over: n.scrollWidth - n.clientWidth,
      }))
    `);
    check("sidebar tab labels are not clipped", () => {
      const clipped = labelOverflow.filter((l) => l.over > 1);
      assert.deepEqual(clipped, [], `clipped: ${clipped.map((c) => c.text).join(", ")}`);
    });

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

    // --- the style controls must stay reachable on a narrow window
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(400);
    const narrow = await cdp.eval<{ right: number; width: number; visible: boolean }>(`(() => {
      const slider = document.querySelector('.style input[type="range"]');
      if (!slider) return { right: 0, width: window.innerWidth, visible: false };
      const r = slider.getBoundingClientRect();
      return { right: r.right, width: window.innerWidth, visible: r.width > 0 };
    })()`);
    check("style controls stay on screen at 1100px", () => {
      assert.ok(narrow.visible, "no style slider rendered");
      assert.ok(
        narrow.right <= narrow.width,
        `slider extends to ${Math.round(narrow.right)} in a ${narrow.width}px window`,
      );
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(400);

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

    // ------------------------------------------------------------------ menu
    console.log("\nnative menu");

    const menu = await cdp.eval<{
      created: string[];
      setAs: string | null;
      setEnabled: number;
      setChecked: number;
    }>("window.__menu");

    check("the native menu was built and handed to the OS", () => {
      assert.ok(menu.setAs !== null, "neither setAsAppMenu nor setAsWindowMenu was called");
      const submenus = menu.created.filter((kind) => kind === "Submenu").length;
      // File, Edit, View, Go, Tools, Pages, Window + Open Recent, Sidebar, and
      // the app menu on macOS / Help elsewhere.
      assert.ok(submenus >= 9, `only ${submenus} submenus built`);
    });

    check("menu items track app state", () => {
      assert.ok(
        menu.setEnabled > 0,
        "nothing was ever enabled or disabled — the state sync never ran",
      );
      assert.ok(menu.setChecked > 0, "no check mark was ever updated");
    });

    /*
     * The accelerators now belong to the OS. `shortcuts.ts` must therefore let
     * ⌘S through untouched — handling it in both places would save twice, which
     * for a save that reopens the file from disk is not a harmless double.
     */
    const savesBefore = await cdp.eval<number>("window.__saveCount");
    for (const type of ["keyDown", "keyUp"] as const) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        modifiers: 4, // Meta
        key: "s",
        code: "KeyS",
        windowsVirtualKeyCode: 83,
        nativeVirtualKeyCode: 83,
      });
    }
    await sleep(600);
    const savesAfter = await cdp.eval<number>("window.__saveCount");
    check("⌘S is left to the menu once the native menu is installed", () =>
      assert.equal(savesAfter, savesBefore, "the webview handled an accelerator the OS owns"),
    );

    // ------------------------------------------------------------------ tabs
    console.log("\ntabs");

    const tabsBefore = await cdp.eval<number>("document.querySelectorAll('.tabbar .tab').length");
    check("the open document has a tab", () => assert.equal(tabsBefore, 1));

    // Open the second fixture by priming the stubbed dialog and clicking "+".
    await cdp.eval(`window.__nextOpen = [${JSON.stringify(PDF_PATH_2)}]`);
    await cdp.eval("document.querySelector('.tabbar .add').click()");

    const twoTabs = await waitFor(
      "a second tab",
      () => cdp.eval<number>("document.querySelectorAll('.tabbar .tab').length"),
      (n) => n === 2,
      25000,
    );
    check("opening another file adds a tab", () => assert.equal(twoTabs, 2));

    /*
     * Exact-case comparison on purpose: `.label` is a global utility class in
     * app.css that uppercases and dims its text, and using it for the tab name
     * silently restyled every tab. A case-insensitive check would have passed.
     */
    const tabNames = await waitFor(
      "both tab names to settle",
      () =>
        cdp.eval<{ text: string; transform: string }[]>(`
          [...document.querySelectorAll('.tabbar .tab .name')].map((n) => ({
            text: n.textContent.trim(),
            transform: getComputedStyle(n).textTransform,
          }))
        `),
      // A tab shows "Untitled" until its document has loaded.
      (names) => names.length === 2 && names.every((n) => n.text !== "Untitled"),
    );
    check("tab names render as the filename, unstyled", () => {
      assert.deepEqual(
        tabNames.map((t) => t.text),
        ["report.pdf", "appendix.pdf"],
      );
      for (const name of tabNames) {
        assert.equal(name.transform, "none", `"${name.text}" has text-transform: ${name.transform}`);
      }
    });

    /*
     * Reordering is pointer-based rather than HTML5 drag-and-drop, because the
     * window enables Tauri's file-drop handler and that stops WebKit from ever
     * dispatching dragover/drop inside the page. This drags for real, and
     * swaps the tabs back so the checks below still see the original order.
     */
    const tabNamesNow = () =>
      cdp.eval<string[]>(
        "[...document.querySelectorAll('.tabbar .tab .name')].map((n) => n.textContent.trim())",
      );

    const tabA = await itemCentre(cdp, ".tabbar .tab", 0);
    const tabB = await itemCentre(cdp, ".tabbar .tab", 1);
    assert.ok(tabA && tabB, "could not locate both tabs");
    await drag(cdp, { x: tabB!.x, y: tabB!.y }, { x: tabA!.x, y: tabA!.y });
    const swapped = await waitFor(
      "the tabs to swap",
      tabNamesNow,
      (names) => names[0] === "appendix.pdf",
      8000,
    ).catch(() => [] as string[]);
    check("dragging a tab reorders the tab strip", () =>
      assert.deepEqual(swapped, ["appendix.pdf", "report.pdf"]),
    );

    await drag(cdp, { x: tabA!.x, y: tabA!.y }, { x: tabB!.x, y: tabB!.y });
    await waitFor(
      "the tabs to swap back",
      tabNamesNow,
      (names) => names[0] === "report.pdf",
      8000,
    ).catch(() => []);

    const second = await waitFor(
      "the second document to render",
      () =>
        cdp.eval<{ active: string; pages: number; annots: number }>(`(() => ({
          active: document.querySelector('.tabbar .tab.active .name')?.textContent?.trim() ?? '',
          pages: document.querySelectorAll('[data-page-index]').length,
          annots: document.querySelectorAll('.group .row').length,
        }))()`),
      (state) => state.pages > 0 && state.active === "appendix.pdf",
      25000,
    );
    check("the new tab is active and shows its own document", () => {
      assert.equal(second.active, "appendix.pdf");
      // The appendix fixture has 2 pages; report.pdf has 4.
      assert.equal(second.pages, 2, "wrong page count — tabs are sharing a document");
    });
    check("the new tab has no annotations of its own", () =>
      assert.equal(second.annots, 0, "the second tab inherited the first tab's annotations"),
    );

    // Switch back: the first tab must still have everything it had.
    await cdp.eval("document.querySelectorAll('.tabbar .tab .tab-name')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))");
    const first = await waitFor(
      "the first document again",
      () =>
        cdp.eval<{ active: string; pages: number; annots: number }>(`(() => ({
          active: document.querySelector('.tabbar .tab.active .name')?.textContent?.trim() ?? '',
          pages: document.querySelectorAll('[data-page-index]').length,
          annots: document.querySelectorAll('.group .row').length,
        }))()`),
      (state) => state.active === "report.pdf" && state.pages > 0,
      25000,
    );
    check("switching back restores the first tab intact", () => {
      assert.equal(first.pages, 4);
      assert.ok(first.annots >= 3, `expected the annotations back, got ${first.annots} rows`);
    });

    /*
     * Undo history is per tab. Make a fresh edit in this tab first: saving
     * earlier reset its history (by design — the model is rebased on the bytes
     * on disk), so without a new edit there would be nothing to compare.
     */
    await cdp.eval("document.querySelector('[title^=\"Rectangle\"]').click()");
    const undoBand = await cdp.eval<{ x: number; w: number; top: number; bottom: number }>(`(() => {
      const r = document.querySelector('[data-page-index="0"]').getBoundingClientRect();
      return {
        x: r.x,
        w: r.width,
        top: Math.max(r.top, 0) + 20,
        bottom: Math.min(r.bottom, window.innerHeight) - 20,
      };
    })()`);
    const undoY = (undoBand.top + undoBand.bottom) / 2;
    await drag(
      cdp,
      { x: undoBand.x + undoBand.w * 0.55, y: undoY - 30 },
      { x: undoBand.x + undoBand.w * 0.8, y: undoY + 10 },
    );
    await sleep(300);

    const undoState = await cdp.eval<{ first: boolean; second: boolean }>(`(async () => {
      const tabs = document.querySelectorAll('.tabbar .tab .tab-name');
      const canUndo = () => !document.querySelector('[title^="Undo"]').disabled;
      const firstCan = canUndo();
      tabs[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 300));
      const secondCan = canUndo();
      tabs[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 300));
      return { first: firstCan, second: secondCan };
    })()`);
    check("undo history is per tab", () => {
      assert.ok(undoState.first, "the edited tab should have something to undo");
      assert.ok(!undoState.second, "the untouched tab should have nothing to undo");
    });

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((r: any) =>
      writeFileSync(`${OUT_DIR}/ui-tabs.png`, Buffer.from(r.data, "base64")),
    );

    // Closing a clean tab needs no prompt.
    await cdp.eval("document.querySelectorAll('.tabbar .tab')[1].querySelector('.close').click()");
    const afterClose = await waitFor(
      "one tab left",
      () => cdp.eval<number>("document.querySelectorAll('.tabbar .tab').length"),
      (n) => n === 1,
    );
    check("closing a clean tab closes it without prompting", () => assert.equal(afterClose, 1));

    // --- closing a tab with unsaved work must ask first
    await cdp.eval("document.querySelector('[title^=\"Rectangle\"]').click()");
    const band2 = await cdp.eval<{ x: number; w: number; top: number; bottom: number }>(`(() => {
      const r = document.querySelector('[data-page-index="0"]').getBoundingClientRect();
      return {
        x: r.x,
        w: r.width,
        top: Math.max(r.top, 0) + 20,
        bottom: Math.min(r.bottom, window.innerHeight) - 20,
      };
    })()`);
    const midY = (band2.top + band2.bottom) / 2;
    await drag(
      cdp,
      { x: band2.x + band2.w * 0.2, y: midY },
      { x: band2.x + band2.w * 0.5, y: midY + 40 },
    );

    const isDirty = await waitFor(
      "the tab to go dirty",
      () => cdp.eval<boolean>("!!document.querySelector('.tabbar .tab .dot')"),
      (dirty) => dirty,
    );
    check("an edited tab shows an unsaved marker", () => assert.ok(isDirty));

    await cdp.eval("document.querySelector('.tabbar .tab .close').click()");
    const prompted = await waitFor(
      "the unsaved-changes dialog",
      () => cdp.eval<boolean>("!!document.querySelector('[role=\"alertdialog\"]')"),
      (shown) => shown,
    );
    check("closing a dirty tab prompts instead of discarding", () => assert.ok(prompted));

    await cdp.eval("[...document.querySelectorAll('[role=\"alertdialog\"] button')].find((b) => b.textContent.trim() === 'Cancel').click()");
    const survived = await waitFor(
      "the tab to survive Cancel",
      () =>
        cdp.eval<{ tabs: number; dialog: boolean }>(`(() => ({
          tabs: document.querySelectorAll('.tabbar .tab').length,
          dialog: !!document.querySelector('[role="alertdialog"]'),
        }))()`),
      (state) => !state.dialog,
    );
    check("Cancel keeps the tab and its work", () => {
      assert.equal(survived.tabs, 1);
      assert.equal(survived.dialog, false);
    });

    // ---------------------------------------------------- page organisation
    console.log("\npage organisation");

    // Back to the Pages section for the thumbnail strip's buttons.
    await cdp.eval("document.querySelector('[title=\"Pages\"]').click()");
    await sleep(300);

    const planLength = () =>
      cdp.eval<number>("document.querySelectorAll('[data-page-index]').length");

    /*
     * Which page is the blank one, by index, or -1.
     *
     * Pages are virtualised and the fixture's pages are all the same size, so
     * neither the text layer nor the geometry identifies a page reliably. An
     * all-white canvas does: every fixture page has printed text on it.
     */
    const blankIndex = () =>
      cdp.eval<number>(`(() => {
        for (const el of document.querySelectorAll('[data-page-index]')) {
          const canvas = el.querySelector('canvas');
          if (!canvas || !canvas.width) continue;
          const { data } = canvas.getContext('2d').getImageData(
            0, 0, canvas.width, Math.min(canvas.height, 600),
          );
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) dark++;
          }
          if (dark === 0) return Number(el.dataset.pageIndex);
        }
        return -1;
      })()`);

    const pagesBefore = await planLength();

    await cdp.eval("document.querySelector('[title^=\"Insert a blank page\"]').click()");
    const pagesAfter = await waitFor(
      "the inserted page",
      planLength,
      (n) => n === pagesBefore + 1,
      15000,
    );
    check("inserting a blank page adds exactly one page", () =>
      assert.equal(pagesAfter, pagesBefore + 1),
    );

    const inserted = await waitFor("the blank page to render", blankIndex, (i) => i >= 0, 15000)
      .catch(() => -1);
    check("the inserted page is actually blank", () =>
      assert.ok(inserted >= 0, "no all-white page found after inserting one"),
    );

    // It should have taken its size from the page it follows, not a default.
    const sizes = await cdp.eval<{ blank: number; neighbour: number }>(`(() => {
      const ratio = (i) => {
        const el = document.querySelector('[data-page-index="' + i + '"]');
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        return r.height / r.width;
      };
      return { blank: ratio(${inserted}), neighbour: ratio(${Math.max(inserted - 1, 0)}) };
    })()`);
    check("the blank page matches its neighbour's page size", () => {
      assert.ok(sizes.blank > 0 && sizes.neighbour > 0, "could not measure the pages");
      assert.ok(
        Math.abs(sizes.blank - sizes.neighbour) < 0.01,
        `blank is ${sizes.blank.toFixed(3)}, neighbour ${sizes.neighbour.toFixed(3)}`,
      );
    });

    /*
     * Move the blank page with the buttons rather than by dragging. It is
     * cmd-clicked into the strip's selection first so the move acts on a known
     * page instead of on wherever the viewer thinks the cursor is.
     */
    await cdp.eval(`(() => {
      const shots = document.querySelectorAll('.tile .shot');
      shots[${inserted}].dispatchEvent(
        new MouseEvent('click', { bubbles: true, metaKey: true }),
      );
    })()`);
    await sleep(300);

    await cdp.eval("document.querySelector('[title=\"Move down\"]').click()");
    const movedDown = await waitFor(
      "the page to move down",
      blankIndex,
      (i) => i === inserted + 1,
      10000,
    ).catch(() => -1);
    check("Move down moves the selected page one slot later", () =>
      assert.equal(movedDown, inserted + 1),
    );

    await cdp.eval("document.querySelector('[title=\"Move up\"]').click()");
    const movedBack = await waitFor(
      "the page to move back",
      blankIndex,
      (i) => i === inserted,
      10000,
    ).catch(() => -1);
    check("Move up puts it back where it started", () => assert.equal(movedBack, inserted));

    // Same again, but by dragging the thumbnail. The grid is two columns wide,
    // so index + 2 is the tile directly below.
    const dragFromTile = await itemCentre(cdp, ".tile", inserted);
    const dragToTile = await itemCentre(cdp, ".tile", inserted + 2);
    check("both thumbnails are on screen to drag between", () => {
      assert.ok(dragFromTile?.visible, `tile ${inserted} is not visible`);
      assert.ok(dragToTile?.visible, `tile ${inserted + 2} is not visible`);
    });

    if (dragFromTile?.visible && dragToTile?.visible) {
      await drag(cdp, dragFromTile, dragToTile, 12);
      const dragged = await waitFor(
        "the dragged page to land",
        blankIndex,
        (i) => i === inserted + 2,
        10000,
      ).catch(() => -1);
      check("dragging a thumbnail reorders the pages", () =>
        assert.equal(dragged, inserted + 2),
      );

      // Put it back, so the save check below counts from a known layout.
      await drag(cdp, dragToTile, dragFromTile, 12);
      await waitFor("the page to come back", blankIndex, (i) => i === inserted, 10000).catch(
        () => -1,
      );
    }

    /*
     * Sideways, onto the tile in the next column. The grid is two columns, so
     * this is nearly pure horizontal movement — the case a drag threshold
     * measured only along the vertical axis silently refuses to start, and the
     * one the vertical drag above cannot see.
     */
    const sideways = await cdp.eval<{ a: number; b: number } | null>(`(() => {
      const tiles = [...document.querySelectorAll('.tile[data-reorder-index]')];
      for (const el of tiles) {
        const i = Number(el.dataset.reorderIndex);
        const next = tiles.find((o) => Number(o.dataset.reorderIndex) === i + 1);
        if (!next) continue;
        // Same row: the grid is responsive now, so the column count is not fixed.
        if (Math.abs(el.getBoundingClientRect().y - next.getBoundingClientRect().y) < 2) {
          return { a: i, b: i + 1 };
        }
      }
      return null;
    })()`);
    assert.ok(sideways, "no two tiles share a row");
    const acrossA = await itemCentre(cdp, ".tile", sideways!.a);
    const acrossB = await itemCentre(cdp, ".tile", sideways!.b);
    if (acrossA?.visible && acrossB?.visible) {
      const before = await blankIndex();
      await drag(cdp, acrossA, acrossB, 10);
      const after = await waitFor(
        "the sideways drag to land",
        blankIndex,
        (i) => i !== before,
        10000,
      ).catch(() => before);
      check("dragging a thumbnail sideways reorders too", () =>
        assert.notEqual(after, before, "a horizontal drag did nothing"),
      );
      // Restore for the save check.
      await drag(cdp, acrossB, acrossA, 10);
      await waitFor("the sideways drag to undo", blankIndex, (i) => i === before, 10000).catch(
        () => -1,
      );
    }

    // The real test: a generated page has to survive the rebuild save path.
    const savesBeforeBlank = await cdp.eval<number>("window.__saveCount");
    await cdp.eval("document.querySelector('[title^=\"Save (\"]').click()");
    await waitFor(
      "the second save",
      () => cdp.eval<number>("window.__saveCount"),
      (n) => n > savesBeforeBlank,
      30000,
    );
    const withBlank = await PDFDocument.load(
      Buffer.from((await cdp.eval<string>("window.__saved"))!, "base64"),
      { ignoreEncryption: true },
    );
    check("the blank page survives a save", () =>
      assert.equal(withBlank.getPageCount(), pagesBefore + 1),
    );

    // ------------------------------------------------------- resizable panels
    console.log("\nresizable panels");

    await waitForDocument(cdp);

    const panelWidths = () =>
      cdp.eval<{ sidebar: number; viewer: number; inspector: number }>(`(() => {
        const w = (sel) => {
          const el = document.querySelector(sel);
          return el ? Math.round(el.getBoundingClientRect().width) : 0;
        };
        return { sidebar: w('.sidebar'), viewer: w('.viewer'), inspector: w('.inspector') };
      })()`);

    const beforeResize = await panelWidths();
    const handle = await cdp.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector('[aria-label^="Resize sidebar"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    check("the sidebar has a resize handle", () => assert.ok(handle, "no resize handle found"));

    if (handle) {
      await drag(cdp, handle, { x: handle.x + 140, y: handle.y }, 12);
      const afterResize = await waitFor(
        "the sidebar to widen",
        panelWidths,
        (w) => Math.abs(w.sidebar - (beforeResize.sidebar + 140)) < 6,
        8000,
      ).catch(() => beforeResize);

      check("dragging the handle widens the sidebar", () =>
        assert.ok(
          Math.abs(afterResize.sidebar - (beforeResize.sidebar + 140)) < 6,
          `sidebar went ${beforeResize.sidebar} -> ${afterResize.sidebar}, wanted +140`,
        ),
      );
      check("the viewer gives up exactly the space the sidebar takes", () =>
        assert.ok(
          Math.abs(afterResize.viewer - (beforeResize.viewer - 140)) < 6,
          `viewer went ${beforeResize.viewer} -> ${afterResize.viewer}, wanted -140`,
        ),
      );

      // The write is debounced, so give it a moment before reading it back.
      await sleep(400);
      const stored = await cdp.eval<string | null>(
        "window.localStorage.getItem('vrushpdf.layout.v2')",
      );
      check("the new width is persisted for next launch", () => {
        assert.ok(stored, "nothing written to localStorage");
        const saved = JSON.parse(stored!) as { widths?: { sidebar?: number } };
        assert.ok(
          Math.abs((saved.widths?.sidebar ?? 0) - afterResize.sidebar) < 6,
          `stored ${saved.widths?.sidebar}, on screen ${afterResize.sidebar}`,
        );
      });

      // A wider sidebar should fit more thumbnail columns, not just wider ones.
      const columns = await cdp.eval<number>(`(() => {
        const tiles = [...document.querySelectorAll('.tile')];
        if (tiles.length === 0) return 0;
        const top = tiles[0].getBoundingClientRect().y;
        return tiles.filter((el) => Math.abs(el.getBoundingClientRect().y - top) < 2).length;
      })()`);
      check("the thumbnail grid gains a column as the sidebar widens", () =>
        assert.ok(columns >= 3, `still only ${columns} column(s) at ${afterResize.sidebar}px`),
      );
    }

    /*
     * The right-hand handle inverts the delta (dragging left widens the panel).
     * Worth its own check: a sign error there is invisible from the sidebar.
     */
    const inspectorHandle = await cdp.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector('[aria-label^="Resize properties"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);

    if (inspectorHandle) {
      const before = await panelWidths();
      await drag(cdp, inspectorHandle, { x: inspectorHandle.x - 60, y: inspectorHandle.y }, 10);
      const after = await waitFor(
        "the properties panel to widen",
        panelWidths,
        (w) => Math.abs(w.inspector - (before.inspector + 60)) < 6,
        8000,
      ).catch(() => before);
      check("dragging the right-hand handle leftwards widens the properties panel", () =>
        assert.ok(
          Math.abs(after.inspector - (before.inspector + 60)) < 6,
          `inspector went ${before.inspector} -> ${after.inspector}, wanted +60`,
        ),
      );
    }

    // ---------------------------------------------------------------- stamps
    console.log("\nstamps");

    await waitForDocument(cdp);

    await cdp.eval("document.querySelector('[title=\"Stamps\"]').click()");
    await sleep(300);

    /*
     * Existence is not the test. Throughout the bug this reported, the menu was
     * in the DOM on every click — it was clipped to nothing by an ancestor's
     * overflow. Hit-testing its own centre is what catches that.
     */
    const menuVisible = await cdp.eval<{
      exists: boolean;
      hit: boolean;
      rect: { x: number; y: number; w: number; h: number } | null;
    }>(`(() => {
      const menu = document.querySelector('.menu');
      if (!menu) return { exists: false, hit: false, rect: null };
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 12);
      return {
        exists: true,
        hit: !!hit && menu.contains(hit),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    })()`);

    check("the stamp menu opens and is actually on screen", () => {
      assert.ok(menuVisible.exists, "no .menu in the DOM after clicking Stamp");
      assert.ok(
        menuVisible.hit,
        `the menu is in the DOM but nothing hit-tests to it — clipped? rect=${JSON.stringify(menuVisible.rect)}`,
      );
    });

    const stampNames = await cdp.eval<string[]>(
      "[...document.querySelectorAll('.menu .entry-name')].map((n) => n.textContent.trim())",
    );
    check("the built-in stamps are offered", () => {
      for (const label of ["APPROVED", "REVIEWED", "DRAFT", "CONFIDENTIAL", "FINAL"]) {
        assert.ok(stampNames.includes(label), `${label} missing; got: ${stampNames.join(", ")}`);
      }
    });

    // Arm APPROVED and drag it out on the page.
    await cdp.eval(`(() => {
      const entry = [...document.querySelectorAll('.menu .entry')].find(
        (el) => el.textContent.trim() === 'APPROVED',
      );
      entry.click();
    })()`);
    await sleep(300);

    const isStampSelected = await cdp.eval<boolean>(
      "document.querySelector('[title=\"Stamps\"]').classList.contains('selected')",
    );
    check("choosing a stamp arms the tool", () =>
      assert.ok(isStampSelected, "stamp toolbar button is selected"),
    );

    const stampBand = await cdp.eval<{ x: number; w: number; top: number; bottom: number }>(`(() => {
      const r = document.querySelector('[data-page-index="0"]').getBoundingClientRect();
      return {
        x: r.x,
        w: r.width,
        top: Math.max(r.top, 0) + 20,
        bottom: Math.min(r.bottom, window.innerHeight) - 20,
      };
    })()`);
    const stampY = (stampBand.top + stampBand.bottom) / 2;
    await drag(
      cdp,
      { x: stampBand.x + stampBand.w * 0.2, y: stampY - 40 },
      { x: stampBand.x + stampBand.w * 0.62, y: stampY + 10 },
    );

    const placed = await waitFor(
      "the stamp on the page",
      () => cdp.eval<number>("document.querySelectorAll('.annot-layer image').length"),
      (n) => n > 0,
      10000,
    ).catch(() => 0);
    check("dragging places the stamp on the page", () => assert.ok(placed > 0));

    const savesBeforeStamp = await cdp.eval<number>("window.__saveCount");
    await cdp.eval("document.querySelector('[title^=\"Save (\"]').click()");
    await waitFor(
      "the save with a stamp",
      () => cdp.eval<number>("window.__saveCount"),
      (n) => n > savesBeforeStamp,
      30000,
    );
    const stamped = await PDFDocument.load(
      Buffer.from((await cdp.eval<string>("window.__saved"))!, "base64"),
      { ignoreEncryption: true },
    );
    const stampSubtypes: string[] = [];
    for (const page of stamped.getPages()) {
      const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!array) continue;
      for (let i = 0; i < array.size(); i++) {
        const name = (array.lookup(i) as any)?.lookupMaybe?.(PDFName.of("Subtype"), PDFName);
        if (name) stampSubtypes.push(name.decodeText());
      }
    }
    check("the stamp is written as a real /Stamp annotation", () =>
      assert.ok(stampSubtypes.includes("Stamp"), `got: ${stampSubtypes.join(", ")}`),
    );

    // The other half of "no items": bringing in an image from disk.
    await cdp.eval(`window.__nextOpen = ${JSON.stringify(STAMP_PNG_PATH)}`);

    await waitForDocument(cdp);

    await cdp.eval("document.querySelector('[title=\"Stamps\"]').click()");
    await sleep(250);
    await cdp.eval(`(() => {
      const add = [...document.querySelectorAll('.menu .action')].find((el) =>
        el.textContent.includes('Add an image'),
      );
      add.click();
    })()`);
    await sleep(800);
    await cdp.eval("document.querySelector('[title=\"Stamps\"]').click()");
    const withImage = await waitFor(
      "the added image to appear in the menu",
      () =>
        cdp.eval<string[]>(
          "[...document.querySelectorAll('.menu .entry-name')].map((n) => n.textContent.trim())",
        ),
      (names) => names.includes("stamp.png"),
      8000,
    ).catch(() => [] as string[]);
    check("an image added from disk shows up in the picker", () =>
      assert.ok(withImage.includes("stamp.png"), `got: ${withImage.join(", ")}`),
    );

    // Close it again, so later sections start from a known state.
    await cdp.eval("document.querySelector('[title=\"Stamps\"]').click()");
    await sleep(200);

    // ------------------------------------------------------------- chrome
    console.log("\ntoolbar and tabs");

    const chrome = await cdp.eval<{
      toolbarBottom: number;
      tabbarTop: number;
      labelled: number;
      toolbarHeight: number;
    }>(`(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const toolbar = box('.toolbar');
      const tabbar = box('.tabbar');
      const visible = [...document.querySelectorAll('.tools .btn-label')].filter(
        (el) => getComputedStyle(el).display !== 'none',
      );
      return {
        toolbarBottom: Math.round(toolbar?.bottom ?? 0),
        tabbarTop: Math.round(tabbar?.top ?? -1),
        labelled: visible.length,
        toolbarHeight: Math.round(toolbar?.height ?? 0),
      };
    })()`);

    // Geometry rather than DOM order: where it lands is what matters.
    check("the tab bar sits below the toolbar, as on macOS", () => {
      assert.ok(chrome.tabbarTop >= 0, "no tab bar found");
      assert.ok(
        chrome.tabbarTop >= chrome.toolbarBottom - 1,
        `tab bar top is ${chrome.tabbarTop}, toolbar bottom is ${chrome.toolbarBottom}`,
      );
    });

    check("tool buttons are icon-only by default", () =>
      assert.equal(chrome.labelled, 0, `${chrome.labelled} labels visible with the option off`),
    );

    const withLabels = await cdp.eval<{ labelled: number; tools: number; height: number }>(`(() => {
      document.querySelector('.toolbar').classList.add('labels');
      const visible = [...document.querySelectorAll('.tool-group .btn-label')].filter(
        (el) => getComputedStyle(el).display !== 'none',
      );
      return {
        labelled: visible.length,
        // Derived, so adding a tool does not silently weaken this check.
        tools: document.querySelectorAll('.tool-group .btn').length,
        height: Math.round(document.querySelector('.toolbar').getBoundingClientRect().height),
      };
    })()`);
    check("turning labels on labels every tool button", () => {
      assert.ok(withLabels.tools > 10, `only ${withLabels.tools} tool buttons found`);
      assert.equal(
        withLabels.labelled,
        withLabels.tools,
        `${withLabels.labelled} labels for ${withLabels.tools} tools`,
      );
    });
    check("the toolbar grows to fit the labels", () =>
      assert.ok(
        withLabels.height > chrome.toolbarHeight,
        `height stayed at ${withLabels.height}`,
      ),
    );
    await cdp.eval("document.querySelector('.toolbar').classList.remove('labels')");

    // The menu item that drives it cannot be clicked here — the menu is native —
    // so assert it was at least built.
    const menuIds = await cdp.eval<string[]>("window.__menu.ids");
    check("View ▸ Show Button Labels exists in the menu", () =>
      assert.ok(menuIds.includes("view.labels"), "no view.labels item was created"),
    );

    // ------------------------------------------------- platform + narrow window
    console.log("\nplatform styling and narrow windows");

    /*
     * Forcing `data-platform` is the only way to exercise the Windows and Linux
     * token sets from here — there is no hardware to run them on.
     */
    const tokens = await cdp.eval<Record<string, { font: string; radius: string; control: string }>>(`(() => {
      const root = document.documentElement;
      const was = root.dataset.platform;
      const read = (p) => {
        root.dataset.platform = p;
        const s = getComputedStyle(root);
        return {
          font: s.getPropertyValue('--font-ui').trim().slice(0, 28),
          radius: s.getPropertyValue('--radius').trim(),
          control: s.getPropertyValue('--control-h').trim(),
        };
      };
      const out = { mac: read('mac'), win: read('win'), linux: read('linux') };
      root.dataset.platform = was;
      return out;
    })()`);

    check("each platform gets its own metrics", () => {
      assert.notEqual(tokens.mac.font, tokens.win.font, "same font stack on macOS and Windows");
      assert.notEqual(tokens.mac.font, tokens.linux.font, "same font stack on macOS and Linux");
      assert.equal(tokens.mac.radius, "6px");
      assert.equal(tokens.win.radius, "4px", "Windows should use tighter Fluent corners");
      assert.equal(tokens.mac.control, "28px");
      assert.equal(tokens.win.control, "30px", "Windows controls should be taller");
    });

    // --- narrow window: panels overlay instead of squeezing the viewer
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 800, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);

    const narrowLayout = await cdp.eval<{
      viewer: number;
      body: number;
      sidebarOverlaid: boolean;
      resizers: number;
    }>(`(() => {
      const w = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? 0);
      const sidebar = document.querySelector('.sidebar');
      return {
        viewer: w('.viewer'),
        body: w('.body'),
        sidebarOverlaid: sidebar ? getComputedStyle(sidebar).position === 'absolute' : false,
        resizers: [...document.querySelectorAll('.resizer')].filter(
          (el) => getComputedStyle(el).display !== 'none',
        ).length,
      };
    })()`);

    check("below 900px the panels overlay rather than shrink the viewer", () => {
      assert.ok(narrowLayout.sidebarOverlaid, "the sidebar is still taking width");
      assert.ok(
        Math.abs(narrowLayout.viewer - narrowLayout.body) < 4,
        `viewer is ${narrowLayout.viewer} in a ${narrowLayout.body} body`,
      );
      assert.equal(narrowLayout.resizers, 0, "resize handles should be hidden");
    });

    /*
     * The narrow layout gives the first toolbar row an overflow. If that ever
     * reaches `.row.tools`, the stamp dropdown is clipped invisible again —
     * the original bug. This is the guard.
     */
    // Open from a known state rather than toggling whatever it happens to be.
    await cdp.eval(`(() => {
      const btn = document.querySelector('[title="Stamps"]');
      if (document.querySelector('.menu')) btn.click();
    })()`);
    await sleep(200);
    await cdp.eval("document.querySelector('[title=\"Stamps\"]').click()");
    await sleep(300);
    const narrowMenu = await cdp.eval<boolean>(`(() => {
      const menu = document.querySelector('.menu');
      if (!menu) return false;
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 12);
      return !!hit && menu.contains(hit);
    })()`);
    check("the stamp menu is still visible in a narrow window", () =>
      assert.ok(narrowMenu, "the menu is clipped again at 800px"),
    );
    await cdp.eval("document.body.click()");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(400);

    const branding = await cdp.eval<{ title: string; heading: string | null }>(`({
      title: document.title,
      heading: document.querySelector('.hero h1')?.textContent?.trim() ?? null,
    })`);
    check("the window title carries the product name", () =>
      assert.ok(branding.title.includes("VrushPDF"), `title is "${branding.title}"`),
    );

    // ------------------------------------------------------------- merging
    console.log("\nmerge dialog");

    const menuIdsForMerge = await cdp.eval<string[]>("window.__menu.ids");
    check("File ▸ Merge PDFs… exists in the menu", () =>
      assert.ok(menuIdsForMerge.includes("file.merge"), "no file.merge item was created"),
    );

    /*
     * Settings opens from a native menu item, which cannot be clicked from
     * here, so check the two halves that are observable: the item exists, and
     * the app reads the stored preferences at startup.
     */
    check("Settings… exists in the menu", () =>
      assert.ok(menuIdsForMerge.includes("app.settings"), "no app.settings item was created"),
    );
    const ipc = await cdp.eval<string[]>("window.__ipcCalls");
    check("stored settings are loaded at startup", () =>
      assert.ok(ipc.includes("settings_get"), "settings_get was never called"),
    );

    /*
     * The welcome screen only shows with no document open, so close what is
     * open first. It may be dirty from the earlier sections, in which case the
     * unsaved-changes prompt has to be dismissed.
     */
    await cdp.eval(`(() => {
      const close = document.querySelector('.tabbar .tab .close');
      if (close) close.click();
    })()`);
    await sleep(500);
    await cdp.eval(`(() => {
      const discard = [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (b) => b.textContent.trim() === "Don't Save",
      );
      if (discard) discard.click();
    })()`);

    const welcome = await waitFor(
      "the welcome screen",
      () => cdp.eval<boolean>("!!document.querySelector('[title=\"Merge PDFs…\"], .welcome')"),
      (shown) => shown,
      15000,
    ).catch(() => false);
    check("closing the last document shows the welcome screen", () => assert.ok(welcome));

    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.welcome button')].find((b) =>
        b.textContent.includes('Merge PDFs'),
      );
      btn.click();
    })()`);
    await sleep(300);
    check("the welcome screen opens the merge dialog", async () =>
      assert.ok(await cdp.eval<boolean>("!!document.querySelector('[aria-labelledby=\"merge-title\"]')")),
    );

    // Add both fixtures through the stubbed picker, then check the counts.
    await cdp.eval(
      `window.__nextOpen = ${JSON.stringify([PDF_PATH, PDF_PATH_2])}`,
    );
    await cdp.eval(`(() => {
      const add = [...document.querySelectorAll('.dialog button')].find((b) =>
        b.textContent.includes('Add files'),
      );
      add.click();
    })()`);

    const rows = await waitFor(
      "both files listed with page counts",
      () =>
        cdp.eval<string[]>(
          "[...document.querySelectorAll('.dialog .row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())",
        ),
      (list) => list.length === 2 && list.every((t) => /page/.test(t)),
      15000,
    ).catch(() => [] as string[]);

    /*
     * Counts are read from the dialog rather than hard-coded: earlier sections
     * add a blank page to report.pdf and save it, and the stubbed filesystem
     * keeps that, so the fixture is not the size it started at.
     */
    const counts = rows.map((text) => Number(/(\d+) pages?/.exec(text)?.[1] ?? 0));
    const expectedTotal = counts.reduce((a, b) => a + b, 0);

    check("added files are listed with their real page counts", () => {
      assert.equal(rows.length, 2, `got ${rows.length} rows`);
      assert.ok(rows[0].includes("report.pdf"), rows[0]);
      assert.ok(rows[1].includes("appendix.pdf"), rows[1]);
      assert.ok(
        counts.every((n) => n > 0),
        `page counts did not resolve: ${rows.join(" | ")}`,
      );
    });

    // Reorder, so the merge is provably order-sensitive.
    await cdp.eval(`(() => {
      const rows = document.querySelectorAll('.dialog .row');
      [...rows[1].querySelectorAll('button')].find((b) =>
        (b.getAttribute('title') || '') === 'Move up',
      ).click();
    })()`);
    await sleep(250);
    const reordered = await cdp.eval<string[]>(
      "[...document.querySelectorAll('.dialog .row .file-name')].map((n) => n.textContent.trim())",
    );
    check("the list can be reordered before merging", () =>
      assert.deepEqual(reordered, ["appendix.pdf", "report.pdf"]),
    );

    await cdp.eval(`(() => {
      const merge = [...document.querySelectorAll('.dialog button')].find(
        (b) => b.textContent.trim() === 'Merge',
      );
      merge.click();
    })()`);

    const merged = await waitFor(
      "the merged document",
      () =>
        cdp.eval<{ pages: number; title: string; dirty: boolean }>(`(() => ({
          pages: document.querySelectorAll('[data-page-index]').length,
          title: document.querySelector('.tabbar .tab.active .name')?.textContent?.trim() ?? '',
          dirty: !!document.querySelector('.tabbar .tab.active .dot'),
        }))()`),
      (state) => state.pages > 0,
      30000,
    ).catch(() => ({ pages: 0, title: "", dirty: false }));

    check("merging produces one document with every page", () =>
      assert.equal(
        merged.pages,
        expectedTotal,
        `dialog promised ${expectedTotal} pages, merged document has ${merged.pages}`,
      ),
    );
    check("the merged document is not bound to any input file", () => {
      assert.ok(
        !merged.title.includes("report.pdf") && !merged.title.includes("appendix.pdf"),
        `merged tab is titled "${merged.title}" — Save would overwrite an input`,
      );
    });
    check("the merged document is marked unsaved", () =>
      assert.ok(merged.dirty, "closing it would discard the merge without asking"),
    );

    // --------------------------------------------------------------- forms
    console.log("\nforms");

    await cdp.eval(`window.__nextOpen = [${JSON.stringify(FORM_PATH)}]`);
    await cdp.eval("document.querySelector('.tabbar .add').click()");
    const formControls = await waitFor(
      "the form's fields",
      () => cdp.eval<number>("document.querySelectorAll('.forms .field-control').length"),
      (n) => n >= 2,
      25000,
    ).catch(() => 0);
    check("a form's fields become fillable controls", () => assert.equal(formControls, 2));
    await sleep(600);
    const freshForm = await cdp.eval<{ dirty: boolean; scrollTop: number; undo: boolean }>(`({
      dirty: !!document.querySelector('.tabbar .tab.active .dot'),
      scrollTop: document.querySelector('.viewer').scrollTop,
      undo: !document.querySelector('.toolbar button[title^="Undo"]').disabled,
    })`);
    check("a freshly opened form is not marked unsaved", () => {
      assert.ok(!freshForm.dirty, "the tab shows unsaved changes before any");
      assert.ok(!freshForm.undo, "there is something to undo already");
    });
    check("a freshly opened form starts at the top", () => assert.equal(freshForm.scrollTop, 0));

    // Filling needs the Select tool; an earlier section may have left another.
    await cdp.eval(`document.querySelector('.tools button[title^="Select ("]').click()`);
    await sleep(100);

    // WebKit's contact AutoFill writes into fields no one is editing and fires
    // `input`; that must not count as filling the form in.
    await cdp.eval(`(() => {
      const input = document.querySelector('.forms input[aria-label="applicant"]');
      input.value = "Autofilled Name";
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    const autofilled = await cdp.eval<{ value: string; dirty: boolean }>(`({
      value: document.querySelector('.forms input[aria-label="applicant"]').value,
      dirty: !!document.querySelector('.tabbar .tab.active .dot'),
    })`);
    check("AutoFill into a field nobody is editing is ignored", () => {
      assert.equal(autofilled.value, "");
      assert.ok(!autofilled.dirty, "the document was marked unsaved");
    });

    const formCanvas = `document.querySelector('.page[data-page-index="0"] canvas').toDataURL()`;
    const blankPixels = await cdp.eval<string>(formCanvas);

    await cdp.eval(`(() => {
      const input = document.querySelector('.forms input[aria-label="applicant"]');
      input.focus();
      input.value = "Grace Hopper";
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    })()`);
    await sleep(200);
    const afterTyping = await cdp.eval<{ value: string; dirty: boolean }>(`({
      value: document.querySelector('.forms input[aria-label="applicant"]').value,
      dirty: !!document.querySelector('.tabbar .tab.active .dot'),
    })`);
    check("typing into a field fills it and marks the document unsaved", () => {
      assert.equal(afterTyping.value, "Grace Hopper");
      assert.ok(afterTyping.dirty);
    });
    // The value is drawn by pdf.js on the canvas, not by the input, which is
    // see-through once it loses focus. So the page's pixels have to change.
    const filledPixels = await waitFor(
      "the page to repaint with the value",
      () => cdp.eval<string>(formCanvas),
      (pixels) => pixels !== blankPixels,
      5000,
    ).catch(() => blankPixels);
    check("the page repaints to show the filled-in value", () =>
      assert.notEqual(filledPixels, blankPixels, "canvas unchanged after filling"),
    );

    const checkbox = `document.querySelector('.forms [role="checkbox"]')`;
    await cdp.eval(`${checkbox}.click()`);
    await sleep(100);
    const ticked = await cdp.eval<string>(`${checkbox}.getAttribute('aria-checked')`);
    check("clicking a checkbox ticks it", () => assert.equal(ticked, "true"));

    await cdp.eval(`document.querySelector('.toolbar button[title^="Undo"]').click()`);
    await sleep(100);
    const undone = await cdp.eval<{ box: string; text: string }>(`({
      box: ${checkbox}.getAttribute('aria-checked'),
      text: document.querySelector('.forms input[aria-label="applicant"]').value,
    })`);
    check("undo takes back the tick, and only the tick", () => {
      assert.equal(undone.box, "false");
      assert.equal(undone.text, "Grace Hopper");
    });
    await cdp.eval(`document.querySelector('.toolbar button[title^="Redo"]').click()`);
    await sleep(100);

    const savesBeforeForm = await cdp.eval<number>("window.__saveCount || 0");
    await cdp.eval(`document.querySelector('.toolbar button[title^="Save (⌘S)"]').click()`);
    await waitFor(
      "the form to save",
      () => cdp.eval<number>("window.__saveCount || 0"),
      (n) => n > savesBeforeForm,
      15000,
    ).catch(() => 0);
    const formPdf = await PDFDocument.load(
      Buffer.from(await cdp.eval<string>("window.__saved"), "base64"),
    );
    const savedForm = formPdf.getForm();
    check("saving writes the values into the real form fields", () => {
      assert.equal(savedForm.getTextField("applicant").getText(), "Grace Hopper");
      assert.equal(savedForm.getCheckBox("agree").isChecked(), true);
    });

    const reloadedForm = await waitFor(
      "the saved form to reload",
      () => cdp.eval<string>(
        `document.querySelector('.forms input[aria-label="applicant"]')?.value ?? ''`,
      ),
      (v) => v === "Grace Hopper",
      15000,
    ).catch(() => "");
    check("after saving, the field shows what the file now holds", () =>
      assert.equal(reloadedForm, "Grace Hopper"),
    );

    // ------------------------------------------------------------- license
    console.log("\nlicense");

    const licenseIpc = await cdp.eval<string[]>("window.__ipcCalls");
    check("the license state is read at startup", () =>
      assert.ok(licenseIpc.includes("license_status"), "license_status was never called"),
    );
    check("Enter License… exists in the menu", () =>
      assert.ok(menuIdsForMerge.includes("app.license"), "no app.license item was created"),
    );
    const capsule = await cdp.eval<string | null>(
      "document.querySelector('.toolbar .trial')?.textContent?.trim() ?? null",
    );
    check("the toolbar shows the days left in the trial", () =>
      assert.equal(capsule, "Trial: 14 days left"),
    );

    // The trial ends while the app is in the background; coming back to the
    // front rereads the status.
    await cdp.eval(`(() => {
      window.__license = {
        state: "expired", daysLeft: null, email: null, keyId: null,
        buyUrl: "https://example.com/buy",
      };
      window.dispatchEvent(new Event("focus"));
    })()`);
    await sleep(300);

    const locked = await cdp.eval<{ highlight: boolean; select: boolean; capsule: string | null }>(`({
      highlight: document.querySelector('.tools button[title^="Highlight"]')?.disabled ?? false,
      select: document.querySelector('.tools button[title^="Select ("]')?.disabled ?? true,
      capsule: document.querySelector('.toolbar .trial')?.textContent?.trim() ?? null,
    })`);
    check("an ended trial disables the annotation tools", () => assert.ok(locked.highlight));
    check("an ended trial leaves the read-only tools", () => assert.ok(!locked.select));
    check("the toolbar says the trial ended", () => assert.equal(locked.capsule, "Trial ended · Buy"));

    const savesBeforeLock = await cdp.eval<number>("window.__saveCount || 0");
    await cdp.eval(`document.querySelector('.toolbar button[title^="Save (⌘S)"]').click()`);
    await sleep(300);
    const blocked = await cdp.eval<{ dialog: boolean; reason: string; saves: number }>(`({
      dialog: !!document.getElementById('license-title'),
      reason: document.querySelector('.dialog .reason')?.textContent ?? '',
      saves: window.__saveCount || 0,
    })`);
    check("saving after the trial opens the license dialog instead", () => {
      assert.ok(blocked.dialog, "no license dialog");
      assert.match(blocked.reason, /Saving/);
    });
    check("nothing reaches write_file", () => assert.equal(blocked.saves, savesBeforeLock));

    /** Pastes into the key field the way a person would, through input events. */
    const typeKey = (text: string) =>
      cdp.eval(`(() => {
        const input = document.getElementById('license-key');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    const keyState = () =>
      cdp.eval<{ hint: string; bad: boolean; activate: boolean }>(`(() => {
        const hint = document.querySelector('.dialog .hint');
        const activate = [...document.querySelectorAll('.dialog footer button')].find(
          (b) => b.textContent.trim() === 'Activate',
        );
        return { hint: hint?.textContent ?? '', bad: !!hint?.classList.contains('bad'), activate: !!activate && !activate.disabled };
      })()`);

    // Shaped like a keygen key; the mock does not check the signature, and
    // neither does the dialog.
    const payload = Buffer.from(
      JSON.stringify({ v: 1, id: "80232a87", email: "buyer@example.com", iat: 1790000000 }),
    ).toString("base64url");
    const licenseKey = `VRSH.${payload}.${"Q".repeat(86)}`;

    await typeKey(licenseKey.slice(0, 60));
    await sleep(100);
    const partial = await keyState();
    check("a key cut short is caught before activating", () => assert.ok(partial.bad && !partial.activate));

    // Wrapped across lines, the way an email client might.
    await typeKey(`  ${licenseKey.slice(0, 70)}\n${licenseKey.slice(70)}\n`);
    await sleep(100);
    const good = await keyState();
    check("a whole key enables Activate and names its buyer", () => {
      assert.ok(!good.bad && good.activate);
      assert.equal(good.hint, "Key for buyer@example.com.");
    });

    await cdp.eval(`[...document.querySelectorAll('.dialog footer button')].find(
      (b) => b.textContent.trim() === 'Activate').click()`);
    await sleep(400);
    const activated = await cdp.eval<{ with: string; heading: string; highlight: boolean; capsule: boolean }>(`({
      with: window.__activatedWith ?? '',
      heading: document.getElementById('license-title')?.textContent?.trim() ?? '',
      highlight: document.querySelector('.tools button[title^="Highlight"]')?.disabled ?? true,
      capsule: !!document.querySelector('.toolbar .trial'),
    })`);
    check("activation sends the key without the wrapping", () => assert.equal(activated.with, licenseKey));
    check("activating unlocks editing and says who it is licensed to", () => {
      assert.match(activated.heading, /Licensed to buyer@example.com/);
      assert.ok(!activated.highlight, "tools still disabled");
      assert.ok(!activated.capsule, "trial capsule still shown");
    });
    await cdp.eval(`[...document.querySelectorAll('.dialog footer button')].find(
      (b) => b.textContent.trim() === 'Done').click()`);

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
