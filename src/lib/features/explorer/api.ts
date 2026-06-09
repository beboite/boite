import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
}

// Every path that leaves this module uses forward slashes, regardless of
// platform. Windows APIs accept them, and a single separator convention is
// what lets the store index paths (expanded/status/search sets) reliably.
function toUnix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const raw = await invoke<DirEntry[]>("read_dir", { path });
  return raw.map((e) => ({ ...e, path: toUnix(e.path) }));
}

export interface ChangedPath {
  path: string;
  status: string;
}

export function gitChangedPaths(path: string): Promise<ChangedPath[]> {
  return invoke<ChangedPath[]>("git_changed_paths", { path });
}

export interface SearchHit {
  path: string;
  isDir: boolean;
}

export async function explorerSearch(
  path: string,
  query: string,
  limit = 500,
): Promise<SearchHit[]> {
  const raw = await invoke<SearchHit[]>("explorer_search", {
    path,
    query,
    limit,
  });
  return raw.map((h) => ({ ...h, path: toUnix(h.path) }));
}
