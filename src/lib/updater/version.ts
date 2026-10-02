/**
 * Pure version comparison and release asset resolution helpers for VrushPDF auto-updates.
 */

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

/**
 * Compare two semver strings (e.g. "0.5.3" vs "0.5.2", or "v1.0.0" vs "v0.9.8").
 * Returns:
 *   1 if a > b (a is newer)
 *  -1 if a < b (b is newer)
 *   0 if a == b
 */
export function compareSemver(a: string, b: string): number {
  const clean = (v: string) => v.replace(/^v/i, "").trim();
  const pa = clean(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = clean(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Select the appropriate installer binary asset from a release given the target OS and architecture.
 */
export function pickAssetForSystem(
  assets: ReleaseAsset[],
  target: { os: string; arch: string },
): ReleaseAsset | null {
  const os = target.os.toLowerCase();
  const arch = target.arch.toLowerCase();

  if (os === "macos" || os === "mac" || os === "darwin") {
    if (arch.includes("arm") || arch.includes("aarch64")) {
      const armDmg = assets.find(
        (a) => a.name.endsWith(".dmg") && (a.name.includes("aarch64") || a.name.includes("arm64")),
      );
      if (armDmg) return armDmg;
    }
    const intelDmg = assets.find((a) => a.name.endsWith(".dmg") && a.name.includes("x64"));
    if (intelDmg) return intelDmg;
    return assets.find((a) => a.name.endsWith(".dmg")) ?? null;
  }

  if (os === "windows" || os === "win") {
    const exe = assets.find((a) => a.name.endsWith(".exe"));
    if (exe) return exe;
    return assets.find((a) => a.name.endsWith(".msi")) ?? null;
  }

  // Linux
  const appImage = assets.find((a) => a.name.endsWith(".AppImage"));
  if (appImage) return appImage;
  const deb = assets.find((a) => a.name.endsWith(".deb"));
  if (deb) return deb;
  return assets.find((a) => a.name.endsWith(".rpm")) ?? null;
}
