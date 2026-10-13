import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const FRONTEND = "http://localhost:1420";
const CDP_PORT = 9227;
const OUT_DIR = "/tmp/vrushpdf-test";
const SCREENSHOTS_DIR = "docs/screenshots";
const PDF_PATH = `${OUT_DIR}/report.pdf`;
const FORM_PATH = `${OUT_DIR}/form.pdf`;
const STAMP_PNG_PATH = `${OUT_DIR}/stamp.png`;
const SCAN_PATH = `${OUT_DIR}/scan.pdf`;
const PHOTO_PATH = `${OUT_DIR}/showcase-photo.pdf`;
const SHOWCASE_FORM_PATH = `${OUT_DIR}/showcase-form.pdf`;

const BROWSERS = [
  "/Applications/Brave Origin.app/Contents/MacOS/Brave Origin",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  label: string,
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 25000,
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

  close() {
    this.#socket.close();
  }

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

function stubSource(seeds: Record<string, string>, cliPath: string): string {
  return `
(() => {
  try { window.localStorage.clear(); } catch {}

  const seeds = ${JSON.stringify(seeds)};
  const path = ${JSON.stringify(cliPath)};

  const files = new Map(
    Object.entries(seeds).map(([p, b64]) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]),
  );
  const metaFor = (p) => ({ path: p, name: p.split("/").pop(), size: files.get(p)?.length ?? 0, modified: null });

  window.__nextOpen = null;
  window.__nextSave = null;
  window.__ipcCalls = [];
  window.__saved = null;
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push("unhandled: " + e.reason));

  let callbackId = 1;
  const callbacks = new Map();
  let menuRid = 1000;
  window.__menu = { created: [], ids: [], setAs: null, setEnabled: 0, setChecked: 0, setText: 0 };

  window.__license = {
    state: "licensed", daysLeft: null, email: "developer@vrushpdf.app", keyId: "2b2558be",
    buyUrl: "https://vrushpdf.app/buy",
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
        case "get_desktop_environment": return "mac";
        case "read_file": {
          const stored = files.get(args.path);
          if (!stored) throw new Error("no such file: " + args.path);
          return stored.slice().buffer;
        }
        case "file_meta": return metaFor(args.path);
        case "recents_get": return [];
        case "settings_get": return { singleInstance: true, warnUnflattenedSignatures: true, autoUpdate: true };
        case "settings_set": return null;
        case "get_system_target": return { os: "macos", arch: "aarch64" };
        case "check_latest_release": return JSON.stringify({ tag_name: "v1.0.2", assets: [] });
        case "download_and_install_update": return null;
        case "install_update_payload": return null;
        case "relaunch_app": return null;
        case "exit_app": return null;
        case "license_status": return window.__license;
        case "recents_add": return [];
        case "signatures_list": return [];
        case "write_file": return metaFor(path);
        case "plugin:app|version": return "1.0.2";
        case "plugin:menu|new": return [menuRid++, (args.options && args.options.id) || "menu-" + menuRid];
        case "plugin:menu|append":
        case "plugin:menu|remove_at": return null;
        case "plugin:menu|items": return [];
        case "plugin:menu|set_as_app_menu": window.__menu.setAs = "app"; return null;
        case "plugin:menu|set_as_window_menu": window.__menu.setAs = "window"; return null;
        case "plugin:menu|set_enabled":
        case "plugin:menu|set_checked":
        case "plugin:menu|set_text": return null;
        case "plugin:event|listen": return 0;
        case "plugin:event|unlisten": return null;
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
        case "plugin:dialog|ask": return true;
        case "plugin:opener|open_url": return null;
        case "downsample_image_jpeg": return { data: [], original_bytes: 100000, new_bytes: 25000, new_width: 800, new_height: 600 };
        case "print_pdf": return null;
        default:
          return null;
      }
    },
  };
})();
  `;
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
    30000,
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
      `--user-data-dir=${OUT_DIR}/browser-screenshots-profile-${Date.now()}`,
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
    30000,
  );

  return { child, wsUrl: target!.webSocketDebuggerUrl };
}

/**
 * A phone photo of a printed page lying at an angle on a dark desk, for the
 * scan-correction card: the sheet, slightly turned, with lines of text on it.
 */
async function buildPhotoPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.24, 0.2, 0.17) });
  // Sheet corners, top-down: an A4-ish page photographed off-square.
  page.drawSvgPath("M118 92 L506 128 L520 700 L86 676 Z", { x: 0, y: 792, color: rgb(0.97, 0.96, 0.93) });
  const tilt = 4;
  const t = (tilt * Math.PI) / 180;
  const at = (x: number, yDown: number) => ({ x: x + (yDown - 120) * Math.sin(t) * 0.15, y: 792 - yDown - (x - 120) * Math.sin(t) });
  const lines = [
    "Purchase agreement",
    "",
    "This agreement is made between the parties named below and",
    "covers the delivery of the goods listed in the attached schedule.",
    "Payment is due within thirty days of the invoice date. Goods",
    "remain the property of the seller until paid for in full.",
    "",
    "Either party may end this agreement with written notice of",
    "sixty days. Disputes are settled under the laws of the place",
    "where the seller has its registered office.",
    "",
    "Signed on behalf of the buyer:",
  ];
  lines.forEach((line, n) => {
    if (!line) return;
    const p = at(150, 170 + n * 30);
    page.drawText(line, { x: p.x, y: p.y, size: n === 0 ? 20 : 12, font: n === 0 ? bold : font, rotate: degrees(-tilt), color: rgb(0.15, 0.15, 0.17) });
  });
  return doc.save();
}

/**
 * An application form of the everyday kind: two fillable fields and a
 * checkbox, plus printed boxes and lines that only the tick, cross and text
 * box tools can fill in.
 */
async function buildFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Membership application");
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  const ink = rgb(0.15, 0.15, 0.18);
  const rule = rgb(0.55, 0.57, 0.6);
  page.drawText("Membership application", { x: 64, y: 712, size: 24, font: bold, color: ink });
  page.drawText("Please complete every section and sign at the bottom.", { x: 64, y: 688, size: 11, font, color: rule });

  page.drawText("Full name", { x: 64, y: 640, size: 11, font, color: ink });
  page.drawText("Email", { x: 64, y: 590, size: 11, font, color: ink });
  const form = doc.getForm();
  form.createTextField("name").addToPage(page, { x: 64, y: 608, width: 300, height: 26 });
  form.createTextField("email").addToPage(page, { x: 64, y: 558, width: 300, height: 26 });

  page.drawText("Membership type", { x: 64, y: 510, size: 13, font: bold, color: ink });
  ["Individual", "Family", "Student"].forEach((label, i) => {
    page.drawRectangle({ x: 64 + i * 150, y: 478, width: 16, height: 16, borderColor: ink, borderWidth: 1 });
    page.drawText(label, { x: 88 + i * 150, y: 482, size: 11, font, color: ink });
  });
  page.drawText("Send me the monthly newsletter", { x: 64, y: 440, size: 13, font: bold, color: ink });
  ["Yes", "No"].forEach((label, i) => {
    page.drawRectangle({ x: 64 + i * 150, y: 408, width: 16, height: 16, borderColor: ink, borderWidth: 1 });
    page.drawText(label, { x: 88 + i * 150, y: 412, size: 11, font, color: ink });
  });
  form.createCheckBox("terms").addToPage(page, { x: 64, y: 360, width: 16, height: 16 });
  page.drawText("I have read and accept the membership terms.", { x: 88, y: 364, size: 11, font, color: ink });

  page.drawLine({ start: { x: 64, y: 270 }, end: { x: 300, y: 270 }, thickness: 0.8, color: rule });
  page.drawLine({ start: { x: 340, y: 270 }, end: { x: 548, y: 270 }, thickness: 0.8, color: rule });
  page.drawText("Signature", { x: 64, y: 254, size: 10, font, color: rule });
  page.drawText("Date", { x: 340, y: 254, size: 10, font, color: rule });
  return doc.save();
}

async function main() {
  console.log("Preparing screenshots directory...");
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  writeFileSync(PHOTO_PATH, await buildPhotoPdf());
  writeFileSync(SHOWCASE_FORM_PATH, await buildFormPdf());

  const seeds: Record<string, string> = {};
  for (const path of [PDF_PATH, FORM_PATH, STAMP_PNG_PATH, SCAN_PATH, PHOTO_PATH, SHOWCASE_FORM_PATH]) {
    seeds[path] = readFileSync(path).toString("base64");
  }

  const vite = await startVite();
  const browser = await startBrowser();
  const cdp = await Cdp.connect(browser.wsUrl);

  const shot = async (name: string) => {
    await sleep(400);
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SCREENSHOTS_DIR}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log(`📸 ${name}.png`);
  };
  const mouse = { button: "left" as const, buttons: 1, pointerType: "mouse" as const, clickCount: 1 };
  const click = async (p: { x: number; y: number }) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...p, ...mouse });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, ...mouse });
    await sleep(150);
  };
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, ...mouse });
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
        ...mouse,
      });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, ...mouse });
    await sleep(250);
  };
  /** A hand-drawn signature: a pen stroke starting at `origin`. */
  const scribble = async (origin: { x: number; y: number }, scale: number) => {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      points.push({
        x: origin.x + scale * (t * 2.6 + 0.12 * Math.sin(t * 19)),
        y: origin.y + scale * (-0.28 * Math.sin(t * 11) * (1 - t * 0.6) - 0.1 * Math.sin(t * 31)),
      });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...points[0], ...mouse });
    for (const p of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p, ...mouse });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...points.at(-1)!, ...mouse });
    await sleep(250);
  };
  /** Click the centre of the first element matching `selector`, with the real mouse. */
  const clickOn = async (selector: string) => {
    const box = await cdp.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (box) await click(box);
  };
  /** Type into a text box that is open for editing, then commit it as finishing typing would. */
  const typeIntoTextBox = async (text: string) => {
    await cdp.eval(`(() => {
      const ta = document.querySelector('.widgets .freetext textarea');
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(250);
    await cdp.eval("document.querySelector('.widgets .freetext textarea')?.blur()");
    await sleep(200);
  };
  const tool = (titlePrefix: string) =>
    cdp.eval(`document.querySelector('.toolbar button[title^=${JSON.stringify(titlePrefix)}]').click()`).then(() => sleep(150));
  /** Viewport box of a page, scrolled into view first. */
  const pageBox = async (index: number, block: "start" | "center" = "start") =>
    cdp.eval<{ x: number; y: number; w: number; h: number }>(`(async () => {
      const page = document.querySelector('.page[data-page-index="${index}"]');
      page.scrollIntoView({ block: ${JSON.stringify(block)} });
      await new Promise((r) => setTimeout(r, 500));
      const r = page.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
  /** Viewport box of the text span on a page containing `text`. */
  const spanBox = (index: number, text: string) =>
    cdp.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
      const span = [...document.querySelectorAll('.page[data-page-index="${index}"] .textLayer span')]
        .find((s) => s.textContent.includes(${JSON.stringify(text)}));
      const r = span.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
  const openInNewTab = async (path: string) => {
    await cdp.eval(`window.__nextOpen = [${JSON.stringify(path)}]`);
    await cdp.eval("document.querySelector('.tabbar .add').click()");
    await sleep(1500);
  };
  const theme = (value: "light" | "dark") =>
    cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
    await theme("light");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: stubSource(seeds, PDF_PATH) });

    console.log("Navigating to app...");
    await cdp.send("Page.navigate", { url: FRONTEND });
    await waitFor(
      "the report's text",
      () => cdp.eval<number>("document.querySelectorAll('.page[data-page-index=\"0\"] .textLayer span').length"),
      (n) => n > 5,
      30000,
    );
    await sleep(1200);

    // ------------------------------------------------ markup on the report
    let page = await pageBox(0);
    await tool("Highlight");
    await cdp.eval(`(() => {
      const span = [...document.querySelectorAll('.page[data-page-index="0"] .textLayer span')].find((s) => s.textContent.startsWith('The quick brown'));
      const range = document.createRange();
      range.selectNodeContents(span);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    })()`);
    await sleep(300);
    await tool("Underline");
    await cdp.eval(`(() => {
      const span = [...document.querySelectorAll('.page[data-page-index="0"] .textLayer span')].find((s) => s.textContent.startsWith('Annotation round-trips'));
      const range = document.createRange();
      range.selectNodeContents(span);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    })()`);
    await sleep(300);
    await cdp.eval("getSelection().removeAllRanges()");

    page = await pageBox(0);
    const px = (fx: number, fy: number) => ({ x: page.x + page.w * fx, y: page.y + page.h * fy });
    await tool("Rectangle");
    await drag(px(0.09, 0.455), px(0.91, 0.625));
    await tool("Arrow");
    await drag(px(0.86, 0.12), px(0.66, 0.2));
    await tool("Text box");
    await drag(px(0.62, 0.075), px(0.93, 0.115));
    await typeIntoTextBox("Checked against Q3 figures");
    await tool("Tick mark");
    await click(px(0.07, 0.205));
    await click(px(0.07, 0.23));
    await tool("Freehand pen");
    await scribble(px(0.25, 0.575), page.w * 0.09);
    await tool("Select (");

    // Select the rectangle so the properties panel shows its style.
    await click(px(0.09, 0.54));
    await cdp.eval("document.querySelector('.tabs [title=\"Annotations\"]')?.click()");
    await shot("02-markup-studio");

    // ------------------------------------------------------------ overview
    await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await cdp.eval("document.querySelector('.tabs [title=\"Pages\"]')?.click()");
    await tool("Toggle properties");
    await pageBox(0);
    await shot("01-editor-overview");
    await tool("Toggle properties");

    // ----------------------------------------------------------- redaction
    page = await pageBox(1);
    await tool("Redact");
    // A whole line with a comfortable box, and only part of another: the words
    // outside the second box must survive, and the neighbouring lines too.
    const line = await spanBox(1, "liquor jugs");
    await drag({ x: line.x - 3, y: line.y - 3 }, { x: line.x + line.w + 3, y: line.y + line.h + 3 });
    const line2 = await spanBox(1, "survive as real");
    await drag({ x: line2.x + line2.w * 0.27, y: line2.y - 2 }, { x: line2.x + line2.w * 0.62, y: line2.y + line2.h + 2 });
    await tool("Select (");
    await cdp.eval("document.querySelector('.redact-apply-btn').click()");
    await waitFor("redactions to apply", () => cdp.eval<string>("document.querySelector('.toast')?.textContent ?? ''"), (t) => /redaction/i.test(t), 30000);
    await pageBox(1);
    await shot("06-redaction");

    // ----------------------------------------------------------- optimizer
    await tool("Optimize PDF");
    await waitFor("the optimizer", () => cdp.eval<boolean>("!!document.querySelector('.dialog')"), (v) => v);
    await sleep(800);
    await shot("07-pdf-optimizer");
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await cdp.eval("[...document.querySelectorAll('.dialog button')].find((b) => /Cancel|Close/.test(b.textContent))?.click()");
    await sleep(400);

    // ----------------------------------------- forms, ticks and a stamp
    await openInNewTab(SHOWCASE_FORM_PATH);
    await waitFor("form fields", () => cdp.eval<number>("document.querySelectorAll('.forms .field-control').length"), (n) => n >= 3);
    await sleep(500);
    for (const [field, value] of [["name", "Grace Hopper"], ["email", "grace@example.org"]]) {
      await cdp.eval(`(() => {
        const input = document.querySelector('.forms input[aria-label="${field}"]');
        input.focus();
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
      })()`);
    }
    await clickOn('.forms [aria-label="terms"]');
    page = await pageBox(0);
    /** Screen point for PDF coordinates on this 612 x 792 page. */
    const pt = (x: number, y: number) => ({ x: page.x + (x / 612) * page.w, y: page.y + ((792 - y) / 792) * page.h });
    await tool("Tick mark");
    await click(pt(72, 486)); // Individual
    await click(pt(72, 416)); // newsletter: yes
    await tool("Cross mark");
    await click(pt(222, 486)); // Family: no
    await tool("Text box");
    await click(pt(344, 292));
    await typeIntoTextBox("11 October 2026");
    await tool("Freehand pen");
    await cdp.eval("document.querySelector('.toolbar .colour-well')?.click()");
    await sleep(150);
    await cdp.eval("document.querySelector('.toolbar .palette .swatch[title=\"#2563eb\"]')?.click()");
    await scribble(pt(80, 282), page.w * 0.05);
    await tool("Stamps");
    await cdp.eval("document.querySelector('[title=\"Place APPROVED\"]')?.click()");
    await sleep(200);
    await click(pt(420, 705));
    await tool("Select (");
    await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await pageBox(0);
    await shot("03-forms-and-stamps");

    // ---------------------------------------------------------------- OCR
    await openInNewTab(SCAN_PATH);
    page = await pageBox(0);
    await tool("Copy text from a scan");
    await drag(px2(page, 0.06, 0.1), px2(page, 0.98, 0.27), 12);
    await waitFor(
      "region OCR",
      () => cdp.eval<string>("document.querySelector('.ocr-result textarea')?.value ?? ''"),
      (t) => t.length > 20,
      60000,
    );
    await shot("04-ocr");
    await tool("Select (");

    // ------------------------------------------------------ scan correction
    await openInNewTab(PHOTO_PATH);
    await tool("Fit page");
    await sleep(600);
    page = await pageBox(0);
    await cdp.eval(`(() => {
      const page = document.querySelector('.page[data-page-index="0"]');
      const r = page.getBoundingClientRect();
      page.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
    })()`);
    await sleep(300);
    await cdp.eval("[...document.querySelectorAll('.context-menu .menu-item')].find((b) => b.textContent.includes('Correct Perspective'))?.click()");
    await waitFor(
      "corner detection",
      () => cdp.eval<string>("document.querySelector('.perspective .hint')?.textContent ?? ''"),
      (t) => t !== "" && !t.includes("Looking"),
      20000,
    );
    await shot("05-scan-correction");
    await cdp.eval("[...document.querySelectorAll('.perspective button')].find((b) => b.textContent.trim() === 'Cancel')?.click()");

    // ------------------------------------------------------------ dark mode
    await theme("dark");
    await clickOn(".tabbar .tab");
    await sleep(1000);
    await cdp.eval("document.querySelector('.tabs [title=\"Annotations\"]')?.click()");
    await pageBox(0);
    await shot("08-dark-mode");

    const errors = await cdp.eval<string[]>("window.__errors");
    if (errors.length) console.warn("Page errors:", errors);
    console.log(`✅ Screenshots written to ${SCREENSHOTS_DIR}/`);
  } finally {
    cdp.close();
    browser.child.kill("SIGKILL");
    vite.kill("SIGTERM");
  }
}

/** A point at fractions of a page box. */
function px2(page: { x: number; y: number; w: number; h: number }, fx: number, fy: number) {
  return { x: page.x + page.w * fx, y: page.y + page.h * fy };
}

main().catch((err) => {
  console.error("Screenshot generation failed:", err);
  process.exit(1);
});
