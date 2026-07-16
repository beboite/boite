import { backend, backendFor } from "$lib/backend";
import type { PtyEvent, PtyOpenArgs } from "$lib/backend/types";
import type { WorkspaceOrigin } from "$lib/types";

export type { PtyEvent, PtySpawnArgs } from "$lib/backend/types";

// In dynamic mode two transports hold live PTYs at once; remember which one
// issued each key so write/resize/kill route back to it without every caller
// having to carry the origin around.
const keyOrigin = new Map<string, WorkspaceOrigin | undefined>();

function backendForKey(key: string) {
  return keyOrigin.has(key) ? backendFor(keyOrigin.get(key)) : backend();
}

export async function ptyOpen(
  args: PtyOpenArgs,
  onEvent: (event: PtyEvent) => void,
  origin?: WorkspaceOrigin,
): Promise<string> {
  const key = await backendFor(origin).pty.open(args, onEvent);
  keyOrigin.set(key, origin);
  return key;
}

export function ptyWrite(key: string, data: Uint8Array): Promise<void> {
  return backendForKey(key).pty.write(key, data);
}

export function ptyResize(key: string, cols: number, rows: number): Promise<void> {
  return backendForKey(key).pty.resize(key, cols, rows);
}

export async function ptyKill(key: string, wait = true): Promise<void> {
  try {
    await backendForKey(key).pty.kill(key, wait);
  } finally {
    keyOrigin.delete(key);
  }
}

export async function ptyRelease(key: string): Promise<void> {
  try {
    await backendForKey(key).pty.release(key);
  } finally {
    keyOrigin.delete(key);
  }
}
