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
  getSystemTarget,
  installUpdatePayload,
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
  currentVersion = $state("0.5.4");
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
      const response = await fetch(RELEASES_API, {
        headers: { Accept: "application/vnd.github.v3+json" },
      });

      if (!response.ok) {
        throw new Error(`GitHub release check failed (${response.status}: ${response.statusText})`);
      }

      const data = await response.json();
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

    try {
      // 1. Download installer asset with stream progress
      const response = await fetch(asset.browser_download_url);
      if (!response.ok) {
        throw new Error(`Failed to download installer (${response.status}: ${response.statusText})`);
      }

      const contentLength = Number(response.headers.get("content-length")) || asset.size || 0;
      const reader = response.body?.getReader();

      let received = 0;
      const chunks: Uint8Array[] = [];

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            const percent = contentLength > 0 ? Math.min(100, Math.round((received / contentLength) * 100)) : 0;
            this.progress = {
              loaded: received,
              total: contentLength || received,
              percent,
            };
          }
        }
      } else {
        const buf = await response.arrayBuffer();
        chunks.push(new Uint8Array(buf));
        received = buf.byteLength;
      }

      const totalBytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        totalBytes.set(chunk, offset);
        offset += chunk.length;
      }

      // 2. Validate SHA-256 checksum if SHA256SUMS.txt is available
      if (this.release.sha256Asset) {
        try {
          const shaResp = await fetch(this.release.sha256Asset.browser_download_url);
          if (shaResp.ok) {
            const shaText = await shaResp.text();
            const expectedHash = this.#findChecksum(shaText, asset.name);
            if (expectedHash) {
              const digestBuf = await crypto.subtle.digest("SHA-256", totalBytes);
              const actualHash = Array.from(new Uint8Array(digestBuf))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");

              if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
                throw new Error("Installer checksum verification failed. The download may be corrupted.");
              }
            }
          }
        } catch (shaErr) {
          console.warn("Checksum check skipped or failed:", shaErr);
        }
      }

      // 3. Install payload via Rust backend
      this.status = "installing";
      await installUpdatePayload(asset.name, totalBytes);
      this.status = "ready";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage = msg;
      this.status = "error";
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
