import type { ThreadId, Timestamp } from './ids';

export interface FileEntry {
  name: string;
  /** Relative to the thread's working directory, forward slashes. */
  path: string;
  kind: 'file' | 'dir';
  bytes: number | null;
  modifiedAt: Timestamp;
}

/**
 * What `files.read` answers. Text comes inline; a picture, a video, a sound or
 * anything else binary comes as a `url` that is a path on the core's HTTP
 * server (`/file/<ticket>`), for the client to resolve against the origin it
 * reached the core by. It is valid for `FILE_TICKET_TTL_MS` and answers range
 * requests so a video seeks.
 */
export type FileContent =
  | { kind: 'text'; path: string; bytes: number; modifiedAt: Timestamp; text: string; truncated: boolean; language: string | null }
  | { kind: 'image' | 'video' | 'audio' | 'binary'; path: string; bytes: number; modifiedAt: Timestamp; mime: string; url: string };

/** Path prefix of the ticketed file route: `GET <core>/file/<ticket>`. */
export const FILE_ROUTE = '/file';
export const FILE_TICKET_TTL_MS = 10 * 60 * 1000;
/** A text file is read whole up to this size, then cut and marked truncated. */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_MAX_BYTES = 1024 * 1024;
export const FILES_LIST_MAX = 2000;

export interface FilesRpcMethods {

  /** One directory of the working directory, `path` relative to it or empty for the root. Directories first. */
  'files.list': { params: { threadId: ThreadId; path?: string }; result: FileEntry[] };
  'files.read': { params: { threadId: ThreadId; path: string }; result: FileContent };
  /**
   * The files a chat link names in the working directory. A path there as
   * written answers itself. Otherwise an agent named a file by the tail of its
   * path (`core.md` for `.local/core.md`): the answer is the shallowest files
   * whose relative path ends with it, `/` separators, `.git`, `.boite` and
   * `node_modules` left out. Empty when none does. Owner only.
   */
  'files.locate': { params: { threadId: ThreadId; path: string }; result: string[] };
  /** The editor's save. Owner only: the agent has its own hands on the disk. */
  'files.write': { params: { threadId: ThreadId; path: string; text: string }; result: { bytes: number; modifiedAt: Timestamp } };
}
