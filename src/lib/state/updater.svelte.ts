/**
 * Auto-update manager and GitHub release checker for VrushPDF.
 *
 * Checks https://api.github.com/repos/nashv/VrushPDF/releases/latest
 * against the current application version, downloads matching installer assets
 * with checksum verification, and invokes the platform installer.
 */
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform as detectedPlatform } from "$lib/platform";
import { session } from "$lib/state/session.svelte";
import { settings } from "$lib/state/settings.svelte";
import {
  checkLatestRelease,
  downloadAndInstallUpdate,
  getSystemTarget,
  onUpdateProgress,
  relaunchApp,
  type SystemTarget,
} from "$lib/tauri/files";
import {
  compareSemver,
  pickAssetForSystem,
  type ReleaseAsset,
} from "$lib/updater/version";

export type { ReleaseAsset };
export { compareSemver, pickAssetForSystem };

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export interface ReleaseInfo {
  tagName: string;
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
  asset: ReleaseAsset | null;
  sha256Asset: ReleaseAsset | null;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  percent: number;
}

const GITHUB_REPO = "nashv/VrushPDF";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

class UpdaterStore {
  status = $state<UpdateStatus>("idle");
  dialogOpen = $state(false);
  currentVersion = $state("0.5.5");
  release = $state<ReleaseInfo | null>(null);
  progress = $state<DownloadProgress>({ loaded: 0, total: 0, percent: 0 });
  errorMessage = $state<string | null>(null);
  isManual = $state(false);

  #systemTarget: SystemTarget = {
    os: detectedPlatform === "mac" ? "macos" : detectedPlatform === "win" ? "windows" : "linux",
    arch: "aarch64",
  };

  async init() {
    try {
      const v = await getVersion();
      if (v) this.currentVersion = v;
    } catch {
      // Running in browser or test harness
    }

    try {
      const target = await getSystemTarget();
      if (target && target.os) this.#systemTarget = target;
    } catch {
      // Fallback target
    }
  }

  openDialog() {
    this.dialogOpen = true;
  }

  closeDialog() {
    this.dialogOpen = false;
    if (this.status === "up-to-date" || this.status === "error") {
      this.status = "idle";
    }
  }

  /**
   * Check for updates on GitHub.
   * If `manual` is true, opens the update dialog immediately to show progress/feedback.
   */
  async checkForUpdates(options: { manual?: boolean } = {}) {
    const manual = options.manual ?? false;
    this.isManual = manual;

    if (!manual && !settings.autoUpdate) {
      return;
    }

    await this.init();

    if (this.currentVersion.includes("test")) {
      this.status = manual ? "up-to-date" : "idle";
      return;
    }

    this.status = "checking";
    this.errorMessage = null;

    if (manual) {
      this.dialogOpen = true;
    }

    try {
      let data: any = null;
      try {
        const rawJson = await checkLatestRelease();
        data = JSON.parse(rawJson);
      } catch {
        const response = await fetch(RELEASES_API, {
          headers: { Accept: "application/vnd.github.v3+json" },
        });

        if (!response.ok) {
          throw new Error(`GitHub release check failed (${response.status}: ${response.statusText})`);
        }

        data = await response.json();
      }

      const tagName: string = data.tag_name || "";
      const remoteVersion = tagName.replace(/^v/i, "");
      const isNewer = compareSemver(remoteVersion, this.currentVersion) > 0;

      const rawAssets: Array<{ name: string; size: number; browser_download_url: string }> =
        data.assets || [];
      const assets: ReleaseAsset[] = rawAssets.map((a) => ({
        name: a.name,
        size: a.size,
        browser_download_url: a.browser_download_url,
      }));

      const matchedAsset = pickAssetForSystem(assets, this.#systemTarget);
      const sha256Asset = assets.find((a) => a.name === "SHA256SUMS.txt") ?? null;

      this.release = {
        tagName,
        version: remoteVersion,
        name: data.name || `VrushPDF ${tagName}`,
        body: data.body || "",
        publishedAt: data.published_at || "",
        htmlUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases`,
        asset: matchedAsset,
        sha256Asset,
      };

      if (isNewer) {
        this.status = "available";
        if (manual) {
          this.dialogOpen = true;
        } else {
          session.notify(`VrushPDF ${tagName} is available. Choose Help ▸ Check for Updates to install.`, "info");
        }
      } else {
        this.status = manual ? "up-to-date" : "idle";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage = msg;
      if (manual) {
        this.status = "error";
      } else {
        this.status = "idle";
      }
    }
  }

  /**
   * Download the release asset and pass the payload to the Rust platform installer.
   */
  async downloadAndInstall() {
    if (!this.release || !this.release.asset) {
      this.errorMessage = "No matching download asset found for your platform.";
      this.status = "error";
      return;
    }

    const asset = this.release.asset;
    this.status = "downloading";
    this.progress = { loaded: 0, total: asset.size || 0, percent: 0 };
    this.errorMessage = null;

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onUpdateProgress((p) => {
        this.progress = {
          loaded: p.loaded,
          total: p.total || asset.size || p.loaded,
          percent: p.percent,
        };
        if (p.percent === 100) {
          this.status = "installing";
        }
      });

      await downloadAndInstallUpdate({
        downloadUrl: asset.browser_download_url,
        assetName: asset.name,
        sha256Url: this.release.sha256Asset?.browser_download_url ?? null,
      });

      this.status = "ready";
      if (!this.isManual) {
        session.notify(`VrushPDF ${this.release.tagName} is ready to install on restart.`, "info");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage = msg;
      this.status = "error";
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  }

  #findChecksum(shaText: string, assetName: string): string | null {
    for (const line of shaText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[1].replace(/^\*/, "") === assetName) {
        return parts[0];
      }
    }
    return null;
  }

  async applyAndRestart() {
    try {
      await relaunchApp();
    } catch {
      window.location.reload();
    }
  }

  async openReleasePage() {
    const url = this.release?.htmlUrl || `https://github.com/${GITHUB_REPO}/releases`;
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  }
}

export const updater = new UpdaterStore();
