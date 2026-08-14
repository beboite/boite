import { backendForPath } from "$lib/backend";

export interface TextFile {
  content: string;
  size: number;
  isReadonly: boolean;
  // Decoded lossily from non-UTF-8 bytes; saving would corrupt the file.
  lossy: boolean;
}

export function readTextFile(path: string): Promise<TextFile> {
  return backendForPath(path).editor.readTextFile(path);
}

export function writeTextFile(path: string, content: string): Promise<number> {
  return backendForPath(path).editor.writeTextFile(path, content);
}

/** A whole file as base64, for PDFs and images. See `EditorApi.readBase64`. */
export function readBase64(path: string): Promise<string> {
  return backendForPath(path).editor.readBase64(path);
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
  return backendForPath(repoPath).editor.fileVersions(repoPath, file, headFile ?? null);
}

/**
 * One file at both ends of an agent's turn.
 *
 * The same shape as `gitFileVersions` and a different question: those three
 * versions are all relative to HEAD, and a turn is bracketed by two checkpoints
 * that have nothing to do with HEAD.
 */
export function turnFileVersions(
  repoPath: string,
  from: string,
  to: string,
  file: string,
): Promise<{ before: string | null; after: string | null; binary: boolean }> {
  return backendForPath(repoPath).checkpoints.fileVersions(repoPath, from, to, file);
}
