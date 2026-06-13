import { backend } from "$lib/backend";

export interface TextFile {
  content: string;
  size: number;
  isReadonly: boolean;
  // Decoded lossily from non-UTF-8 bytes; saving would corrupt the file.
  lossy: boolean;
}

export function readTextFile(path: string): Promise<TextFile> {
  return backend().editor.readTextFile(path);
}

export function writeTextFile(path: string, content: string): Promise<number> {
  return backend().editor.writeTextFile(path, content);
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
  return backend().editor.fileVersions(repoPath, file, headFile ?? null);
}
