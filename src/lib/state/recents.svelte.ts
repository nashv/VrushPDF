/**
 * Recently opened files.
 *
 * The list lives on disk (see `recents_*` in `src-tauri/src/commands.rs`); this
 * store is the reactive mirror of it, so the File ▸ Open Recent submenu and the
 * welcome screen both update the moment a document is opened.
 */
import { recentsAdd, recentsClear, recentsGet, type FileMeta } from "$lib/tauri/files";

class Recents {
  /**
   * Replaced wholesale on every change rather than mutated, so a consumer can
   * treat identity as "the list changed" — the menu rebuilds its items on that.
   */
  list = $state.raw<FileMeta[]>([]);

  async refresh() {
    this.list = await recentsGet().catch(() => []);
  }

  /** Record a freshly opened path. The Rust side dedupes and truncates. */
  async add(path: string) {
    this.list = await recentsAdd(path).catch(() => this.list);
  }

  async clear() {
    await recentsClear().catch(() => {});
    this.list = [];
  }
}

export const recents = new Recents();
