/**
 * Which desktop we are running on.
 *
 * The answer is decided by the inline script in `app.html` so the stylesheet
 * has it before the first paint; this reads that back rather than sniffing the
 * user agent a second time and risking the two disagreeing.
 */
export type Platform = "mac" | "win" | "linux";

function detect(): Platform {
  const tagged = globalThis.document?.documentElement.dataset.platform;
  if (tagged === "mac" || tagged === "win" || tagged === "linux") return tagged;

  // SSR, tests, or any context without that script having run.
  const ua = globalThis.navigator?.userAgent ?? "";
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Win")) return "win";
  return "linux";
}

export const platform: Platform = detect();
export const isMac = platform === "mac";
