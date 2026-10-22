// Owns WebSocket timing, addresses and browser transport helpers.
import { RPC_MAX_FRAME_BYTES, RPC_PATH, withoutTrailingSlashes } from '@boite/contracts';
import type { SocketLike } from './client';

/**
 * 1 s, 2 s, 4 s, 8 s, then 10 s forever, each 20 % either way at random, so
 * the phones of a core that restarts do not all knock at the same instant.
 */
export function defaultBackoff(attempt: number, random: () => number = Math.random): number {
  return Math.round(Math.min(1000 * 2 ** attempt, 10_000) * (0.8 + random() * 0.4));
}

/**
 * How long one attempt gets for TCP, TLS, the upgrade and the hello together:
 * 10 s, then 20 s, then 30 s. A lossy link that needs longer than 10 s would
 * otherwise be cut off on every attempt and never connect.
 */
export function openDeadline(attempt: number): number {
  return 10_000 * (1 + Math.min(attempt, 2));
}

export function rpcUrl(coreUrl: string): string {
  const url = new URL(coreUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${withoutTrailingSlashes(url.pathname)}${RPC_PATH}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Silence on a remote socket before the client asks whether the core is still
 * there. A phone whose NAT mapping expired, or a core host that went to sleep,
 * leaves a socket that never fires close.
 */
export const IDLE_PROBE_MS = 25_000;
/**
 * How long a probe waits for any frame at all, the same 10 s a new socket gets
 * to say hello. Frames arrive in order, so a probe's answer queues behind a long
 * answer still downloading; a remote client asks the core to slice every answer
 * (`progress`), and each 64 KiB slice counts as a frame, so a slow link keeps
 * answering while a dead one stays silent. Until 2026-10-22 a call waiting kept
 * the probe away and a link that dropped under an open conversation read as
 * connected for the two minutes of that call's timeout.
 */
export const PROBE_DEADLINE_MS = 10_000;
/**
 * A call on a remote socket to a core that slices its answers
 * (`chunkedAnswers`) that hears no frame at all for this long sends a probe:
 * the click on a conversation of a machine whose link died shows the machine
 * offline within this and the probe's deadline. A socket that answers, or
 * carries any event meanwhile, is not asked. Older cores keep the call's own
 * 120 s timeout.
 */
export const QUIET_CALL_MS = 3_000;
/**
 * The slowest upload a probe still waits for: its `hello` queues behind the
 * bytes this client sent since the last frame came back, past the first 64 KiB,
 * so 2 MiB of pictures give it 62 s more. Answers need no such allowance: they come in 64 KiB
 * slices, so a download faster than about 6.4 KiB/s lands one within the 10 s
 * deadline.
 */
export const UPLOAD_FLOOR_BYTES_PER_S = 32 * 1024;
/** How long `resume()` gives the socket it already has before replacing it. */
export const RESUME_PROBE_MS = 4_000;

/** The shell and a browser on the core's machine: that socket cannot go half-open. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const name = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return name === '127.0.0.1' || name === 'localhost' || name === '::1';
  } catch {
    return false;
  }
}

export function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** WebSocket close code 1009: the peer refused a frame over its size limit. */
export const MESSAGE_TOO_BIG = 1009;

/** UTF-8 bytes of a frame, encoded only when its length leaves any doubt. */
export function frameBytes(frame: string): number {
  return frame.length * 3 <= RPC_MAX_FRAME_BYTES ? frame.length : new TextEncoder().encode(frame).byteLength;
}

export function megabytes(bytes: number): string {
  return (bytes / 1048576).toFixed(1).replace(/\.0$/, '');
}

export function browserSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}
