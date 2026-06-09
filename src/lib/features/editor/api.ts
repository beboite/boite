import { invoke } from "@tauri-apps/api/core";

export interface TextFile {
  content: string;
  size: number;
  isReadonly: boolean;
}

interface RawTextFile {
  content: string;
  size: number;
  is_readonly: boolean;
}

export async function readTextFile(path: string): Promise<TextFile> {
  const r = await invoke<RawTextFile>("read_text_file", { path });
  return { content: r.content, size: r.size, isReadonly: r.is_readonly };
}

export function writeTextFile(path: string, content: string): Promise<number> {
  return invoke<number>("write_text_file", { path, content });
}

export interface FileVersions {
  head: string | null;
  index: string | null;
  work: string | null;
  binary: boolean;
}

export function gitFileVersions(
  repoPath: string,
  file: string,
  headFile?: string,
): Promise<FileVersions> {
  return invoke<FileVersions>("git_file_versions", {
    path: repoPath,
    file,
    headFile: headFile ?? null,
  });
}
