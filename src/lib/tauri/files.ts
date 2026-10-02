/**
 * Bridge to the Rust filesystem commands and the native dialogs.
 *
 * PDF bytes travel as raw IPC bodies (see `src-tauri/src/commands.rs`); paths
 * ride along in percent-encoded headers because HTTP headers cannot hold
 * arbitrary UTF-8.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

export interface FileMeta {
  path: string;
  name: string;
  size: number;
  modified: number | null;
}

export interface SignatureMeta {
  id: string;
  name: string;
}

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];
const IMAGE_FILTER = [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }];

export async function readFile(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("read_file", { path });
  return new Uint8Array(buf);
}

export async function writeFile(
  path: string,
  bytes: Uint8Array,
  password?: string,
): Promise<FileMeta> {
  const headers: Record<string, string> = { "x-file-path": encodeURIComponent(path) };
  if (password) {
    headers["x-password"] = encodeURIComponent(password);
  }
  return invoke<FileMeta>("write_file", bytes, {
    headers,
  });
}

export async function printPdf(bytes: Uint8Array, docTitle = "Document"): Promise<void> {
  const headers: Record<string, string> = { "x-doc-title": encodeURIComponent(docTitle) };
  return invoke<void>("print_pdf", bytes, {
    headers,
  });
}

export interface OptimizeImageRequest {
  bytes: number[] | Uint8Array;
  target_width?: number;
  target_height?: number;
  quality?: number;
  format?: string;
  color_space?: string;
  original_width?: number;
  original_height?: number;
}

export interface OptimizeImageResponse {
  bytes: number[];
  width: number;
  height: number;
  format: string;
  original_size: number;
  optimized_size: number;
}

export async function optimizeImage(req: OptimizeImageRequest): Promise<Uint8Array | null> {
  try {
    const bytesArr = req.bytes instanceof Uint8Array ? Array.from(req.bytes) : req.bytes;
    const res = await invoke<OptimizeImageResponse>("optimize_image", {
      req: {
        ...req,
        bytes: bytesArr,
      },
    });
    return new Uint8Array(res.bytes);
  } catch (err) {
    return null;
  }
}

export const fileMeta = (path: string) => invoke<FileMeta>("file_meta", { path });

// ------------------------------------------------------------------ recents

export const recentsGet = () => invoke<FileMeta[]>("recents_get");
export const recentsAdd = (path: string) => invoke<FileMeta[]>("recents_add", { path });
export const recentsClear = () => invoke<void>("recents_clear");

// ----------------------------------------------------------------- settings

/** Preferences Rust needs at startup; see `src-tauri/src/settings.rs`. */
export interface AppSettings {
  singleInstance: boolean;
  warnUnflattenedSignatures?: boolean;
  autoUpdate?: boolean;
}

export const settingsGet = () => invoke<AppSettings>("settings_get");
export const settingsSet = (settings: AppSettings) => invoke<void>("settings_set", { settings });

// ------------------------------------------------------------------ auto-update

export interface SystemTarget {
  os: string;
  arch: string;
}

export const getSystemTarget = () => invoke<SystemTarget>("get_system_target");

export async function installUpdatePayload(assetName: string, bytes: Uint8Array): Promise<void> {
  const headers: Record<string, string> = { "x-asset-name": encodeURIComponent(assetName) };
  return invoke<void>("install_update_payload", bytes, {
    headers,
  });
}

export const relaunchApp = () => invoke<void>("relaunch_app");

// ------------------------------------------------------------------ dialogs

/** Native open dialog. Returns `null` if the user cancels. */
export async function pickPdfToOpen(multiple = false): Promise<string[] | null> {
  const picked = await openDialog({ multiple, filters: PDF_FILTER, title: "Open PDF" });
  if (picked === null) return null;
  return Array.isArray(picked) ? picked : [picked];
}

export async function pickImage(): Promise<string | null> {
  const picked = await openDialog({ multiple: false, filters: IMAGE_FILTER, title: "Choose image" });
  return typeof picked === "string" ? picked : null;
}

/** Native save dialog, pre-filled with `suggestedName`. */
export async function pickSaveTarget(suggestedName: string): Promise<string | null> {
  const picked = await saveDialog({
    filters: PDF_FILTER,
    defaultPath: suggestedName,
    title: "Save PDF",
  });
  return picked ?? null;
}

// ---------------------------------------------------------------- signatures

export const signaturesList = () => invoke<SignatureMeta[]>("signatures_list");

export async function signatureRead(id: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("signature_read", { id });
  return new Uint8Array(buf);
}

export async function signatureSave(id: string, name: string, png: Uint8Array) {
  return invoke<SignatureMeta>("signature_save", png, {
    headers: {
      "x-signature-id": encodeURIComponent(id),
      "x-signature-name": encodeURIComponent(name),
    },
  });
}

export const signatureDelete = (id: string) => invoke<void>("signature_delete", { id });

// ----------------------------------------------------------- open-with / drop

/** A PDF path passed on argv (file association, `open -a`). */
export const cliFile = () => invoke<string | null>("resolve_cli_file");

const isPdf = (p: string) => p.toLowerCase().endsWith(".pdf");

/**
 * Subscribe to every way the OS can hand us a file: Finder "Open With" (emitted
 * by the Rust `RunEvent::Opened` handler) and drag-and-drop onto the window.
 * Returns a combined unsubscribe.
 */
export async function onExternalOpen(handler: (paths: string[]) => void): Promise<() => void> {
  const unlistenOpened = await listen<string[]>("pdf://open-paths", (event) => {
    const paths = event.payload.filter(isPdf);
    if (paths.length) handler(paths);
  });
  // A cold launch from Finder delivers its files before the listener above
  // exists, so Rust holds them until now. Asking only after listening means
  // none are lost in between, and Rust hands each one over only once.
  const early = (await invoke<string[]>("opened_files_take")).filter(isPdf);
  if (early.length) handler(early);

  const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    const paths = event.payload.paths.filter(isPdf);
    if (paths.length) handler(paths);
  });

  return () => {
    unlistenOpened();
    unlistenDrop();
  };
}
