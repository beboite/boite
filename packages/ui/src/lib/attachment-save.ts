/**
 * A file the chat carries, taken out of it. The shell writes it into the
 * system's Downloads folder through `save_attachment`, which only opens inert
 * documents and media and shows anything else selected in its folder. A
 * browser gets the file as a normal download.
 */

export type SavedAttachment = { path: string; opened: boolean };

export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}

/** Null outside the shell, where the caller downloads through the browser instead. */
export async function saveAttachment(name: string, bytes: Uint8Array<ArrayBuffer>, open: boolean): Promise<SavedAttachment | null> {
  if (window.__TAURI_INTERNALS__ === undefined) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SavedAttachment>('save_attachment', bytes, {
    headers: { 'x-boite-name': encodeURIComponent(name), 'x-boite-open': open ? '1' : '0' }
  });
}

/** The browser's own download, from a click the user made. */
export function browserDownload(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
