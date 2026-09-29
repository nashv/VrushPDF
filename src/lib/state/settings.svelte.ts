/**
 * Preferences stored on disk rather than in `localStorage`.
 *
 * Only one thing lives here, and for a specific reason: whether to run as a
 * single instance is read by Rust while the app is still being assembled, long
 * before a webview exists to ask. Everything the frontend can own by itself —
 * panel widths, toolbar labels, annotation styles — stays in `localStorage`.
 */
import { settingsGet, settingsSet, type AppSettings } from "$lib/tauri/files";

class SettingsStore {
  /** Mirrors `settings.json`; the default matches the Rust side. */
  singleInstance = $state(true);
  warnUnflattenedSignatures = $state(true);
  loaded = $state(false);

  async load() {
    try {
      const stored = await settingsGet();
      this.singleInstance = stored.singleInstance ?? true;
      if (typeof stored.warnUnflattenedSignatures === "boolean") {
        this.warnUnflattenedSignatures = stored.warnUnflattenedSignatures;
      }
    } catch {
      // No file yet, or running outside Tauri: the defaults above stand.
    } finally {
      this.loaded = true;
    }
  }

  async setSingleInstance(on: boolean) {
    this.singleInstance = on;
    await this.#save();
  }

  async setWarnUnflattenedSignatures(on: boolean) {
    this.warnUnflattenedSignatures = on;
    await this.#save();
  }

  async #save() {
    const settings: AppSettings = {
      singleInstance: this.singleInstance,
      warnUnflattenedSignatures: this.warnUnflattenedSignatures,
    };
    try {
      await settingsSet(settings);
    } catch {
      // Non-fatal: the setting simply won't survive a restart.
    }
  }
}

export const settings = new SettingsStore();
