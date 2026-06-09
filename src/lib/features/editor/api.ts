import { invoke } from "@tauri-apps/api/core";

export interface TextFile {
  content: string;
  size: number;
  isReadonly: boolean;
  // Decoded lossily from non-UTF-8 bytes; saving would corrupt the file.
  lossy: boolean;
}

export function readTextFile(path: string): Promise<TextFile> {
  return invoke<TextFile>("read_text_file", { path });
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
