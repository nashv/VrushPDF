import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FRONTEND = "http://localhost:1420";
const CDP_PORT = 9227;
const OUT_DIR = "/tmp/vrushpdf-test";
const SCREENSHOTS_DIR = "docs/screenshots";
const PDF_PATH = `${OUT_DIR}/report.pdf`;
const FORM_PATH = `${OUT_DIR}/form.pdf`;
const STAMP_PNG_PATH = `${OUT_DIR}/stamp.png`;

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
        case "check_latest_release": return JSON.stringify({ tag_name: "v0.5.6", assets: [] });
        case "download_and_install_update": return null;
        case "install_update_payload": return null;
        case "relaunch_app": return null;
        case "license_status": return window.__license;
        case "recents_add": return [];
        case "signatures_list": return [];
        case "write_file": return metaFor(path);
        case "plugin:app|version": return "0.5.6";
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

async function main() {
  console.log("Preparing screenshots directory...");
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const seeds: Record<string, string> = {
    [PDF_PATH]: readFileSync(PDF_PATH).toString("base64"),
    [FORM_PATH]: readFileSync(FORM_PATH).toString("base64"),
    [STAMP_PNG_PATH]: readFileSync(STAMP_PNG_PATH).toString("base64"),
  };

  const vite = await startVite();
  const browser = await startBrowser();
  const cdp = await Cdp.connect(browser.wsUrl);

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: stubSource(seeds, PDF_PATH),
    });

    console.log("Navigating to app...");
    await cdp.send("Page.navigate", { url: FRONTEND });

    // Wait until document opens
    await waitFor(
      "document to open",
      () => cdp.eval<number>("document.querySelectorAll('canvas').length"),
      (n) => n > 0,
      30000,
    );
    await sleep(1500);

    // 1. Overview Screenshot
    console.log("📸 Capturing 01-editor-overview.png...");
    const shot1 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SCREENSHOTS_DIR}/01-editor-overview.png`, Buffer.from(shot1.data, "base64"));

    // 2. Annotation & Markup Studio
    console.log("📸 Annotating and capturing 02-markup-studio.png...");
    await cdp.eval(`(() => {
      const btn = document.querySelector('.tools button[title^="Rectangle"]');
      if (btn) btn.click();
    })()`);
    await sleep(200);

    // Draw rectangle
    await cdp.eval(`(() => {
      const canvas = document.querySelector('.page[data-page-index="0"] canvas');
      const el = document.querySelector('.overlay');
      if (canvas && el) {
        const r = canvas.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.x + 80, clientY: r.y + 120, bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointermove', { clientX: r.x + 360, clientY: r.y + 220, bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { clientX: r.x + 360, clientY: r.y + 220, bubbles: true }));
      }
    })()`);
    await sleep(500);

    // Select annotation
    await cdp.eval(`(() => {
      const annot = document.querySelector('.annot-shape');
      if (annot) annot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(400);

    const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SCREENSHOTS_DIR}/02-markup-studio.png`, Buffer.from(shot2.data, "base64"));

    // 3. Form Filling & Signature / Stamp Picker
    console.log("📸 Opening form and capturing 03-forms-and-signatures.png...");
    await cdp.eval(`window.__nextOpen = [${JSON.stringify(FORM_PATH)}]`);
    await cdp.eval("document.querySelector('.tabbar .add').click()");
    await waitFor(
      "form fields",
      () => cdp.eval<number>("document.querySelectorAll('.forms .field-control').length"),
      (n) => n >= 2,
      25000,
    );
    await sleep(500);

    // Type into form field
    await cdp.eval(`(() => {
      const input = document.querySelector('.forms input[aria-label="applicant"]');
      if (input) {
        input.focus();
        input.value = "Grace Hopper, Ph.D.";
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
      }
    })()`);
    await sleep(200);

    // Open Stamp Picker menu
    await cdp.eval(`document.querySelector('.tools button[title="Signatures"]')?.click()`);
    await sleep(400);

    const shot3 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SCREENSHOTS_DIR}/03-forms-and-signatures.png`, Buffer.from(shot3.data, "base64"));
    await cdp.eval("document.body.click()");
    await sleep(300);

    // 4. PDF Optimizer Dialog
    console.log("📸 Opening PDF Optimizer and capturing 04-pdf-optimizer.png...");
    await cdp.eval(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', altKey: true, metaKey: true, bubbles: true }));
    })()`);
    await sleep(800);

    const shot4 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SCREENSHOTS_DIR}/04-pdf-optimizer.png`, Buffer.from(shot4.data, "base64"));

    // Close optimizer dialog
    await cdp.eval(`document.querySelector('.dialog footer button')?.click()`);
    await sleep(400);

    // 5. Dark Mode (macOS LiquidGlass)
    console.log("📸 Capturing 05-dark-mode-liquidglass.png...");
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    // Switch back to report tab
    await cdp.eval(`(() => {
      const tab = document.querySelectorAll('.tabbar .tab')[0];
      if (tab) tab.click();
    })()`);
    await sleep(800);

    const shot5 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SCREENSHOTS_DIR}/05-dark-mode-liquidglass.png`, Buffer.from(shot5.data, "base64"));

    console.log("✅ All 5 high-resolution screenshots generated successfully in docs/screenshots/!");
  } finally {
    cdp.close();
    browser.child.kill("SIGKILL");
    vite.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error("Screenshot generation failed:", err);
  process.exit(1);
});
