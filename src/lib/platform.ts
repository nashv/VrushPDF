import { invoke } from "@tauri-apps/api/core";

/**
 * Which desktop we are running on.
 *
 * The answer is decided by the inline script in `app.html` so the stylesheet
 * has it before the first paint; this reads that back rather than sniffing the
 * user agent a second time and risking the two disagreeing.
 * On Linux, `initPlatform()` refines this to specific desktop environments
 * ("gnome" or "kde") when running inside the desktop app.
 */
export type Platform = "mac" | "win" | "linux" | "gnome" | "kde";

function detect(): Platform {
  const tagged = globalThis.document?.documentElement.dataset.platform;
  if (
    tagged === "mac" ||
    tagged === "win" ||
    tagged === "linux" ||
    tagged === "gnome" ||
    tagged === "kde"
  ) {
    return tagged as Platform;
  }

  // SSR, tests, or any context without that script having run.
  const ua = globalThis.navigator?.userAgent ?? "";
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Win")) return "win";
  return "linux";
}

export let platform: Platform = detect();
export const isMac = platform === "mac";

/**
 * True in the macOS window, where the page sits over native Liquid Glass and
 * the chrome is translucent. Also decided in `app.html`.
 */
export const hasGlass = globalThis.document?.documentElement.dataset.glass !== undefined;

/**
 * Refines the platform tag on desktop platforms via native desktop environment detection.
 */
export async function initPlatform(): Promise<Platform> {
  if (typeof window === "undefined") return platform;
  try {
    const de = await invoke<string>("get_desktop_environment");
    if (
      de &&
      (de === "mac" || de === "win" || de === "linux" || de === "gnome" || de === "kde")
    ) {
      platform = de as Platform;
      if (globalThis.document?.documentElement) {
        globalThis.document.documentElement.dataset.platform = de;
      }
      return platform;
    }
  } catch {
    // In browser / test mode without backend IPC
  }
  return platform;
}
