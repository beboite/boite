/*
 * The natural size of a picture or a video once it has loaded, kept by
 * attachment. The timeline unmounts rows it scrolls past and mounts them
 * again: a video drawn at the browser's default 300 x 150 until its metadata
 * arrives changed the row's height on every mount, the window moved and
 * dropped it, and the cycle repeated every few frames. A file mounted again
 * reserves the size it settled at the first time.
 */

export type MediaSize = { width: number; height: number };

/** Enough for the media of the conversations a user goes back and forth between. */
const LIMIT = 256;
const sizes = new Map<string, MediaSize>();

/** The attachment a file part draws: its message and part, an artifact's id, or a project path. */
export function mediaKey(source: { threadId?: string; messageId?: string; partIndex?: number; artifactId?: string; path?: string }): string | null {
  const { threadId, messageId, partIndex, artifactId, path } = source;
  if (threadId && messageId && artifactId) return `${threadId}/${messageId}/artifact/${artifactId}`;
  if (threadId && messageId && partIndex !== undefined) return `${threadId}/${messageId}/${partIndex}`;
  if (threadId && path) return `${threadId}/path/${path}`;
  return null;
}

export function rememberedSize(key: string | null): MediaSize | null {
  return key === null ? null : sizes.get(key) ?? null;
}

export function rememberSize(key: string | null, width: number, height: number): MediaSize | null {
  if (!(width > 0 && height > 0)) return null;
  const size = { width, height };
  if (key === null) return size;
  sizes.delete(key);
  sizes.set(key, size);
  while (sizes.size > LIMIT) sizes.delete(sizes.keys().next().value!);
  return size;
}
