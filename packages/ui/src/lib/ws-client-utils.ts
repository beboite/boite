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
 * How long a probe waits for any frame at all. The idle probe only goes out
 * while no call waits for its answer: frames arrive in order, so behind a large
 * answer still downloading on a slow link, the probe's answer would come too
 * late and a healthy socket would read as dead. A call's own 120 s timeout
 * decides for a socket that carries one.
 */
export const PROBE_DEADLINE_MS = 15_000;
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
