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
