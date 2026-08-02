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
  // A respawned PTY comes back under a new key, and every route below is keyed
  // by it. Registered here rather than by the caller: this map is the only thing
  // that knows which transport issued a key, and a key it has never seen falls
  // back to the default backend, which in dynamic mode is the wrong one.
  const track = (event: PtyEvent) => {
    if (event.type === "key") keyOrigin.set(event.key, origin);
    onEvent(event);
  };
  const key = await backendFor(origin).pty.open(args, track);
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
