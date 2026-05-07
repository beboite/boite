import { readDir, type DirEntry } from "./api";
import { logger } from "$lib/shared/services/logger.svelte";

class ExplorerStore {
  entriesByPath = $state<Record<string, DirEntry[]>>({});
  expanded = $state<Record<string, true>>({});
  loading = $state<Record<string, true>>({});
  errorByPath = $state<Record<string, string>>({});

  async load(path: string, force = false): Promise<void> {
    if (!force && this.entriesByPath[path]) return;
    if (this.loading[path]) return;
    this.loading = { ...this.loading, [path]: true };
    try {
      const entries = await readDir(path);
      this.entriesByPath = { ...this.entriesByPath, [path]: entries };
      if (this.errorByPath[path]) {
        const next = { ...this.errorByPath };
        delete next[path];
        this.errorByPath = next;
      }
    } catch (err) {
      const msg = String(err);
      logger.warn("explorer", `read_dir failed for ${path}`, msg);
      this.errorByPath = { ...this.errorByPath, [path]: msg };
    } finally {
      const next = { ...this.loading };
      delete next[path];
      this.loading = next;
    }
  }

  async toggle(path: string): Promise<void> {
    if (this.expanded[path]) {
      const next = { ...this.expanded };
      delete next[path];
      this.expanded = next;
      return;
    }
    this.expanded = { ...this.expanded, [path]: true };
    await this.load(path);
  }

  async refresh(path: string): Promise<void> {
    await this.load(path, true);
    for (const key of Object.keys(this.expanded)) {
      if (key.startsWith(path)) await this.load(key, true);
    }
  }

  collapseAll(): void {
    this.expanded = {};
  }
}

export const explorerStore = new ExplorerStore();
