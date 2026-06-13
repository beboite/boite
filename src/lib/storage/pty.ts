import { backend } from "$lib/backend";
import type { PtyEvent, PtyOpenArgs } from "$lib/backend/types";

export type { PtyEvent, PtySpawnArgs } from "$lib/backend/types";

export function ptyOpen(
  args: PtyOpenArgs,
  onEvent: (event: PtyEvent) => void,
): Promise<string> {
  return backend().pty.open(args, onEvent);
}

export function ptyWrite(key: string, data: Uint8Array): Promise<void> {
  return backend().pty.write(key, data);
}

export function ptyResize(key: string, cols: number, rows: number): Promise<void> {
  return backend().pty.resize(key, cols, rows);
}

export function ptyKill(key: string, wait = true): Promise<void> {
  return backend().pty.kill(key, wait);
}

export function ptyRelease(key: string): Promise<void> {
  return backend().pty.release(key);
}
