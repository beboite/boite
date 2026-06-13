import { backend } from "$lib/backend";
import type { PtyEvent, PtySpawnArgs } from "$lib/backend/types";

export type { PtyEvent, PtySpawnArgs } from "$lib/backend/types";

export function ptySpawn(
  spec: PtySpawnArgs,
  onEvent: (event: PtyEvent) => void,
): Promise<string> {
  return backend().pty.spawn(spec, onEvent);
}

export function ptyWrite(id: string, data: Uint8Array): Promise<void> {
  return backend().pty.write(id, data);
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return backend().pty.resize(id, cols, rows);
}

export function ptyKill(id: string, wait = true): Promise<void> {
  return backend().pty.kill(id, wait);
}
