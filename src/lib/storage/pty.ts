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
  env?: Record<string, string>;
}

export interface PtyInfo {
  id: string;
  cwd: string;
  cmd: string;
  args: string[];
  title: string | null;
  exited: boolean;
  exitCode: number | null;
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
  await invoke("pty_write", { id, data: Array.from(data) });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  await invoke("pty_kill", { id });
}

export async function ptyList(): Promise<PtyInfo[]> {
  return invoke<PtyInfo[]>("pty_list");
}
