import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyApi, PtyEvent, PtySpawnArgs } from "../types";

// The Rust side base64-encodes output: a byte array would arrive as a JSON
// number array, ~4x the payload and an expensive parse for every chunk. We
// decode it here so the rest of the app only ever sees raw bytes.
type WirePtyEvent =
  | { type: "output"; data: string }
  | { type: "title"; value: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const tauriPty: PtyApi = {
  spawn(spec: PtySpawnArgs, onEvent: (event: PtyEvent) => void): Promise<string> {
    const channel = new Channel<WirePtyEvent>();
    channel.onmessage = (event) => {
      if (event.type === "output") {
        onEvent({ type: "output", bytes: decodeBase64(event.data) });
      } else {
        onEvent(event);
      }
    };
    return invoke<string>("pty_spawn", { onEvent: channel, spec });
  },

  async write(id: string, data: Uint8Array): Promise<void> {
    await invoke("pty_write", data, { headers: { "x-pty-id": id } });
  },

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await invoke("pty_resize", { id, cols, rows });
  },

  async kill(id: string, wait = true): Promise<void> {
    await invoke("pty_kill", { id, wait });
  },
};
