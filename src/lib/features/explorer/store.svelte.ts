import {
  readDir,
  gitChangedPaths,
  explorerSearch,
  type DirEntry,
  type SearchHit,
} from "./api";
import { logger } from "$lib/shared/services/logger.svelte";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPath(cwd: string, rel: string): string {
  const c = normalizePath(cwd);
  const r = rel.replace(/^\/+/, "");
  return `${c}/${r}`;
}

const STATUS_RANK: Record<string, number> = {
  U: 6,
  D: 5,
  A: 4,
  M: 3,
  R: 2,
  C: 2,
  "?": 1,
};

function worse(a: string | undefined, b: string): string {
  if (!a) return b;
  return (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a;
}

class ExplorerStore {
  entriesByPath = $state<Record<string, DirEntry[]>>({});
  expanded = $state<Record<string, true>>({});
  loading = $state<Record<string, true>>({});
  errorByPath = $state<Record<string, string>>({});
  statusByPath = $state<Record<string, string>>({});
  folderStatusByPath = $state<Record<string, string>>({});
  filterText = $state<string>("");
  searchHits = $state<SearchHit[]>([]);
  searching = $state<boolean>(false);
  hitPathSet = $state<Record<string, true>>({});
  ancestorPathSet = $state<Record<string, true>>({});
  dirHitPrefixes = $state<string[]>([]);
  private searchToken = 0;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

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
    await this.loadGitStatus(path);
  }

  collapseAll(): void {
    this.expanded = {};
  }

  setFilter(text: string, cwd: string | null): void {
    this.filterText = text;
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    const trimmed = text.trim();
    if (!trimmed || !cwd) {
      this.searching = false;
      this.searchHits = [];
      this.hitPathSet = {};
      this.ancestorPathSet = {};
      this.dirHitPrefixes = [];
      this.searchToken++;
      return;
    }
    const token = ++this.searchToken;
    this.searching = true;
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      void this.runSearch(token, cwd, trimmed);
    }, 180);
  }

  private async runSearch(token: number, cwd: string, query: string): Promise<void> {
    try {
      const hits = await explorerSearch(cwd, query, 500);
      if (token !== this.searchToken) return;
      this.applyHits(hits, cwd);
    } catch (err) {
      if (token !== this.searchToken) return;
      logger.warn("explorer", `explorer_search failed for ${cwd}`, String(err));
      this.searchHits = [];
      this.hitPathSet = {};
      this.ancestorPathSet = {};
      this.dirHitPrefixes = [];
    } finally {
      if (token === this.searchToken) this.searching = false;
    }
  }

  private applyHits(hits: SearchHit[], cwd: string): void {
    const cwdNorm = normalizePath(cwd);
    const hitSet: Record<string, true> = {};
    const ancestorSet: Record<string, true> = {};
    const dirPrefixes: string[] = [];
    for (const hit of hits) {
      const norm = normalizePath(hit.path);
      hitSet[norm] = true;
      if (hit.isDir) dirPrefixes.push(`${norm}/`);
      let cursor = norm;
      while (cursor.length > cwdNorm.length) {
        const slash = cursor.lastIndexOf("/");
        if (slash < 0 || slash < cwdNorm.length) break;
        cursor = cursor.slice(0, slash);
        ancestorSet[cursor] = true;
      }
    }
    this.searchHits = hits;
    this.hitPathSet = hitSet;
    this.ancestorPathSet = ancestorSet;
    this.dirHitPrefixes = dirPrefixes;
    const next = { ...this.expanded };
    for (const key of Object.keys(ancestorSet)) next[normalizePath(key)] = true;
    for (const hit of hits) {
      if (hit.isDir) next[normalizePath(hit.path)] = true;
    }
    this.expanded = next;
    void this.ensureAncestorsLoaded(hits);
  }

  private async ensureAncestorsLoaded(hits: SearchHit[]): Promise<void> {
    const toLoad = new Set<string>();
    for (const hit of hits) {
      const norm = normalizePath(hit.path);
      const slash = norm.lastIndexOf("/");
      if (slash > 0) toLoad.add(norm.slice(0, slash));
      if (hit.isDir) toLoad.add(norm);
    }
    for (const folder of toLoad) {
      const platform = folder.replace(/\//g, this.pathSeparator());
      if (!this.entriesByPath[platform] && !this.entriesByPath[folder]) {
        await this.load(platform);
      }
    }
  }

  private pathSeparator(): string {
    for (const key of Object.keys(this.entriesByPath)) {
      if (key.includes("\\")) return "\\";
      if (key.includes("/")) return "/";
    }
    return "/";
  }

  isVisible(path: string, isDir: boolean): boolean {
    if (!this.filterText.trim()) return true;
    const norm = normalizePath(path);
    if (this.hitPathSet[norm]) return true;
    if (isDir && this.ancestorPathSet[norm]) return true;
    for (const prefix of this.dirHitPrefixes) {
      if (norm.startsWith(prefix)) return true;
    }
    return false;
  }

  clearFilter(): void {
    this.setFilter("", null);
  }

  expandPath(path: string): void {
    const norm = normalizePath(path);
    const segments = norm.split("/");
    const next = { ...this.expanded };
    let acc = "";
    for (let i = 0; i < segments.length - 1; i++) {
      acc = i === 0 ? segments[0] : `${acc}/${segments[i]}`;
      next[acc] = true;
    }
    this.expanded = next;
  }

  async loadGitStatus(cwd: string): Promise<void> {
    try {
      const rows = await gitChangedPaths(cwd);
      const byPath: Record<string, string> = {};
      const folderStatus: Record<string, string> = {};
      const cwdNorm = normalizePath(cwd);
      for (const row of rows) {
        const abs = normalizePath(joinPath(cwd, row.path));
        byPath[abs] = row.status;
        let parent = abs;
        while (parent.length > cwdNorm.length) {
          const slash = parent.lastIndexOf("/");
          if (slash < 0 || slash < cwdNorm.length) break;
          parent = parent.slice(0, slash);
          folderStatus[parent] = worse(folderStatus[parent], row.status);
        }
      }
      this.statusByPath = byPath;
      this.folderStatusByPath = folderStatus;
    } catch (err) {
      logger.warn("explorer", `git_changed_paths failed for ${cwd}`, String(err));
      this.statusByPath = {};
      this.folderStatusByPath = {};
    }
  }

  statusFor(path: string, isDir: boolean): string | null {
    const key = normalizePath(path);
    if (isDir) return this.folderStatusByPath[key] ?? null;
    return this.statusByPath[key] ?? null;
  }
}

export const explorerStore = new ExplorerStore();
