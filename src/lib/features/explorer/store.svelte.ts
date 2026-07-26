import {
  readDir,
  gitChangedPaths,
  explorerSearch,
  type DirEntry,
  type SearchHit,
} from "./api";
import { logger } from "$lib/shared/services/logger.svelte";

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPath(cwd: string, rel: string): string {
  const c = normalizePath(cwd);
  const r = rel.replace(/^\/+/, "");
  return `${c}/${r}`;
}

export const SEARCH_LIMIT = 500;

// Every directory ever visited stayed cached for the whole session, across
// every project. Bound it, and evict what is not under the tree currently on
// screen first — that is the only part the user can still see.
const MAX_CACHED_DIRS = 400;

function sameStringMap(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// Same directory listing arriving again on the 10s poll must not look like a
// change: assigning a fresh array invalidates every consumer of that path.
function sameEntries(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.path !== y.path ||
      x.name !== y.name ||
      x.isDir !== y.isDir ||
      x.isHidden !== y.isHidden
    ) {
      return false;
    }
  }
  return true;
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

// All record keys in this store are normalized (forward-slash) paths; the
// api layer guarantees entry paths arrive in the same form.
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
  searchTruncated = $state<boolean>(false);
  hitPathSet = $state<Record<string, true>>({});
  ancestorPathSet = $state<Record<string, true>>({});
  dirHitPrefixes = $state<string[]>([]);
  private searchToken = 0;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  // These records are $state proxies, so writing and deleting a single key is
  // already reactive. The old spread-clone per write replaced the whole record
  // — every open directory re-read on any one directory's refresh, and the
  // 10s poll did that three times per expanded folder.
  async load(path: string, force = false): Promise<void> {
    const key = normalizePath(path);
    if (!force && this.entriesByPath[key]) return;
    if (this.loading[key]) return;
    this.loading[key] = true;
    try {
      const entries = (await readDir(key)).filter((e) => e.name !== ".git");
      if (!sameEntries(this.entriesByPath[key], entries)) {
        this.entriesByPath[key] = entries;
      }
      if (this.errorByPath[key]) delete this.errorByPath[key];
    } catch (err) {
      const msg = String(err);
      logger.warn("explorer", `read_dir failed for ${key}`, msg);
      this.errorByPath[key] = msg;
    } finally {
      delete this.loading[key];
    }
  }

  async toggle(path: string): Promise<void> {
    const key = normalizePath(path);
    if (this.expanded[key]) {
      delete this.expanded[key];
      return;
    }
    this.expanded[key] = true;
    await this.load(key);
  }

  async refresh(path: string): Promise<void> {
    const root = normalizePath(path);
    const expandedKeys = Object.keys(this.expanded).filter(
      (k) => k === root || k.startsWith(root + "/"),
    );
    this.evictOutside(root);
    await Promise.all([
      this.load(root, true),
      ...expandedKeys.map((k) => this.load(k, true)),
      this.loadGitStatus(root),
    ]);
  }

  // Only runs once the cache is actually large; until then listings from other
  // projects are worth keeping so switching back is instant.
  private evictOutside(root: string): void {
    const keys = Object.keys(this.entriesByPath);
    if (keys.length <= MAX_CACHED_DIRS) return;
    const prefix = root + "/";
    for (const k of keys) {
      if (k === root || k.startsWith(prefix)) continue;
      delete this.entriesByPath[k];
      delete this.errorByPath[k];
      delete this.expanded[k];
      delete this.statusByPath[k];
      delete this.folderStatusByPath[k];
    }
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
      this.searchTruncated = false;
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
      void this.runSearch(token, normalizePath(cwd), trimmed);
    }, 180);
  }

  private async runSearch(token: number, cwd: string, query: string): Promise<void> {
    try {
      const hits = await explorerSearch(cwd, query, SEARCH_LIMIT);
      if (token !== this.searchToken) return;
      this.applyHits(hits, cwd);
    } catch (err) {
      if (token !== this.searchToken) return;
      logger.warn("explorer", `explorer_search failed for ${cwd}`, String(err));
      this.searchHits = [];
      this.searchTruncated = false;
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
    this.searchTruncated = hits.length >= SEARCH_LIMIT;
    this.hitPathSet = hitSet;
    this.ancestorPathSet = ancestorSet;
    this.dirHitPrefixes = dirPrefixes;
    const next = { ...this.expanded };
    for (const key of Object.keys(ancestorSet)) next[key] = true;
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
    await Promise.all(
      [...toLoad]
        .filter((folder) => !this.entriesByPath[folder])
        .map((folder) => this.load(folder)),
    );
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

  async loadGitStatus(cwd: string): Promise<void> {
    try {
      const rows = await gitChangedPaths(normalizePath(cwd));
      const byPath: Record<string, string> = {};
      const folderStatus: Record<string, string> = {};
      const cwdNorm = normalizePath(cwd);
      for (const row of rows) {
        const abs = joinPath(cwdNorm, row.path);
        byPath[abs] = row.status;
        let parent = abs;
        while (parent.length > cwdNorm.length) {
          const slash = parent.lastIndexOf("/");
          if (slash < 0 || slash < cwdNorm.length) break;
          parent = parent.slice(0, slash);
          folderStatus[parent] = worse(folderStatus[parent], row.status);
        }
      }
      // Assigning identical maps every 10s repainted a badge on every node in
      // the tree for nothing.
      if (!sameStringMap(this.statusByPath, byPath)) this.statusByPath = byPath;
      if (!sameStringMap(this.folderStatusByPath, folderStatus)) {
        this.folderStatusByPath = folderStatus;
      }
    } catch (err) {
      // Keep the previous badges: a transient failure (index.lock during a
      // commit) should not blank the whole tree.
      logger.warn("explorer", `git_changed_paths failed for ${cwd}`, String(err));
    }
  }

  statusFor(path: string, isDir: boolean): string | null {
    const key = normalizePath(path);
    if (isDir) return this.folderStatusByPath[key] ?? null;
    return this.statusByPath[key] ?? null;
  }
}

export const explorerStore = new ExplorerStore();
