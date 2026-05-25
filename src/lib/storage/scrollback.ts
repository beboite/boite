import { invoke } from "@tauri-apps/api/core";

export async function loadScrollback(threadId: string): Promise<Uint8Array> {
  const arr = await invoke<number[]>("load_scrollback", { threadId });
  return new Uint8Array(arr);
}

export async function deleteScrollback(threadId: string): Promise<void> {
  await invoke("delete_scrollback", { threadId });
}

export async function pruneOrphanScrollbacks(
  keepThreadIds: string[],
): Promise<number> {
  return await invoke<number>("prune_orphan_scrollbacks", {
    keepThreadIds,
  });
}
