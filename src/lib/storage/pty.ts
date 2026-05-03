import { Channel, invoke } from "@tauri-apps/api/core";

export type PtyEvent =
  | { type: "output"; data: number[] }
  | { type: "title"; value: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface PtySpawnArgs {
  cwd: string;
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
}

export async function ptySpawn(
  spec: PtySpawnArgs,
  onEvent: (event: PtyEvent) => void,
): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("pty_spawn", { onEvent: channel, spec });
}

export async function ptyWrite(id: string, data: Uint8Array): Promise<void> {
  await invoke("pty_write", data, { headers: { "x-pty-id": id } });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string, wait = true): Promise<void> {
  await invoke("pty_kill", { id, wait });
}
