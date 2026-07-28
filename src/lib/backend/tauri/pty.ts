import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyApi, PtyEvent, PtyOpenArgs, PtySpawnArgs } from "../types";

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
  // Keyed by thread id: pty_open reattaches to a PTY that a workspace switch
  // detached (replaying its scrollback ring) instead of always spawning, so
  // local processes survive switching to a remote workspace and back.
  open(args: PtyOpenArgs, onEvent: (event: PtyEvent) => void): Promise<string> {
    const channel = new Channel<WirePtyEvent>();
    channel.onmessage = (event) => {
      if (event.type === "output") {
        onEvent({ type: "output", bytes: decodeBase64(event.data) });
      } else {
        onEvent(event);
      }
    };
    return invoke<string>("pty_open", {
      threadId: args.threadId,
      onEvent: channel,
      spec: args.spec,
    });
  },

  spawn(
    spec: PtySpawnArgs,
    chatId: string,
    onEvent: (event: PtyEvent) => void,
  ): Promise<string> {
    const channel = new Channel<WirePtyEvent>();
    channel.onmessage = (event) => {
      if (event.type === "output") {
        onEvent({ type: "output", bytes: decodeBase64(event.data) });
      } else {
        onEvent(event);
      }
    };
    return invoke<string>("pty_spawn", { onEvent: channel, spec, chatId });
  },

  async write(key: string, data: Uint8Array): Promise<void> {
    await invoke("pty_write", data, { headers: { "x-pty-id": key } });
  },

  async resize(key: string, cols: number, rows: number): Promise<void> {
    await invoke("pty_resize", { id: key, cols, rows });
  },

  async kill(key: string, wait = true): Promise<void> {
    await invoke("pty_kill", { id: key, wait });
  },

  // Releasing on unmount detaches (keeps the process + a scrollback ring
  // alive); a later pty_open reattaches. Explicit close still calls kill().
  async release(key: string): Promise<void> {
    await invoke("pty_detach", { id: key });
  },
};
