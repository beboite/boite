import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
}

interface RawDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const raw = await invoke<RawDirEntry[]>("read_dir", { path });
  return raw.map((e) => ({
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
    isHidden: e.is_hidden,
  }));
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

interface RawSearchHit {
  path: string;
  is_dir: boolean;
}

export async function explorerSearch(
  path: string,
  query: string,
  limit = 500,
): Promise<SearchHit[]> {
  const raw = await invoke<RawSearchHit[]>("explorer_search", {
    path,
    query,
    limit,
  });
  return raw.map((h) => ({ path: h.path, isDir: h.is_dir }));
}
