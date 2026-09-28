import type { Store } from './store.svelte';

/** Paths belong to the thread's machine, which may differ from the desktop. */
export function localFileDirectory(store: Store | undefined, threadId: string | undefined): string | null {
  if (!window.__TAURI_INTERNALS__ || !store?.owner || !store.localCore || !threadId) return null;
  return store.threads.find(thread => thread.id === threadId)?.cwd ?? null;
}

export function executableLink(path: string): boolean {
  return /\.(exe|com|bat|cmd|msi|appimage)$/i.test(path);
}

/** Called only by a user click. The shell validates the path inside this directory. */
export async function openLocalFile(directory: string, path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_local_file', { directory, path });
}
