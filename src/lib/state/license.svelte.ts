/**
 * The license state as the UI sees it, and the license dialog's open flag.
 *
 * The dialog flag lives here rather than on `session` so the edit, viewer and
 * session stores can all send the user to it without importing each other.
 */
import { licenseActivate, licenseRemove, licenseStatus, type LicenseStatus } from "$lib/tauri/license";

import { viewer } from "./viewer.svelte";

/** Tools that only look at the document, so they stay usable after a trial. */
const READ_ONLY_TOOLS = new Set(["select", "pan", "text"]);

/**
 * A trial can end while the app is open; this is how soon it notices. It also
 * checks whenever the window comes back to the front, which is cheap: the
 * status is a local file read.
 */
const POLL_MS = 60 * 60 * 1000;

class LicenseStore {
  /**
   * Null until the first answer. Treated as editable meanwhile: the UI must not
   * flash locked at startup, and Rust refuses the write anyway if it should.
   */
  status = $state<LicenseStatus | null>(null);
  dialogOpen = $state(false);
  /** Why the dialog was opened, when it was opened by a blocked action. */
  reason = $state<string | null>(null);

  readonly canEdit = $derived(this.status === null || this.status.state === "licensed" || this.status.state === "trial");
  readonly licensed = $derived(this.status?.state === "licensed");

  constructor() {
    viewer.toolGuard = (tool) => {
      if (this.allowsTool(tool)) return true;
      this.openDialog("Annotating needs a license now that the trial has ended.");
      return false;
    };
  }

  async load() {
    await this.#set(licenseStatus());
    setInterval(() => void this.#set(licenseStatus()), POLL_MS);
    window.addEventListener("focus", () => void this.#set(licenseStatus()));
  }

  /**
   * Gate for anything that edits: true if allowed, otherwise opens the dialog
   * saying why. Callers just `if (!license.allow("…")) return;`.
   */
  allow(what = "Editing") {
    if (this.canEdit) return true;
    this.openDialog(`${what} needs a license now that the trial has ended.`);
    return false;
  }

  /** Whether `tool` can be picked right now; see `viewer.setTool`. */
  allowsTool(tool: string) {
    return this.canEdit || READ_ONLY_TOOLS.has(tool);
  }

  openDialog(reason: string | null = null) {
    this.reason = reason;
    this.dialogOpen = true;
  }

  closeDialog() {
    this.dialogOpen = false;
    this.reason = null;
  }

  /** Rejects with a message meant for the user. */
  async activate(key: string) {
    this.#apply(await licenseActivate(key));
  }

  async remove() {
    this.#apply(await licenseRemove());
  }

  async #set(pending: Promise<LicenseStatus>) {
    try {
      this.#apply(await pending);
    } catch {
      // Outside Tauri, or the command failed: keep what we had.
    }
  }

  #apply(status: LicenseStatus) {
    this.status = status;
    // A drawing tool left armed when the trial ran out would still draw.
    if (!this.canEdit && !READ_ONLY_TOOLS.has(viewer.tool)) viewer.setTool("select");
  }
}

export const license = new LicenseStore();
