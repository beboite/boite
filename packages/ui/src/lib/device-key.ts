import { deviceAdmitInput, deviceHelloInput, type DeviceHello } from '@boite/contracts';

/**
 * This device's one key: what lets it into every machine of its group.
 *
 * A phone or a browser makes one Ed25519 key the first time it is added to a
 * group and keeps it here. A member lists the public half in the group's
 * roster; from then on each hello carries a signature made for the machine
 * it is said to, dated and never repeated (`deviceHelloInput`). No secret
 * travels, so a machine reached through another, or at an address the page
 * cannot vouch for, gets nothing it could use elsewhere.
 *
 * The key is made in JavaScript (`@noble/ed25519`) rather than WebCrypto: a
 * page served over plain HTTP on a LAN has no `crypto.subtle`, and Safari 15
 * signs with no Ed25519. It is stored in this origin's storage, as the
 * session keys it replaces were.
 */
export const DEVICE_STORAGE_KEY = 'boite.device';

export interface DeviceKey {
  /** Raw public key, base64url. */
  publicKey: string;
  /** SHA-256 of it, hex: the device's id in its group. */
  id: string;
  /** A hello for one machine. */
  hello(coreId: string): DeviceHello;
  /** What a grant or a code is redeemed with: the key, and a signature over that grant. */
  admit(grant: string, name: string): { publicKey: string; name: string; sig: string };
  /** What a device paired the older way hands over to one machine. */
  enroll(coreId: string): { publicKey: string; at: number; sig: string };
}

type Noble = typeof import('@noble/ed25519');

let noble: Noble | null = null;
let loading: Promise<Noble> | null = null;
let sha256: ((data: Uint8Array) => Uint8Array) | null = null;

/** Loads the signing code once; a page that never signs never downloads it. */
export function loadSigner(): Promise<Noble> {
  loading ??= Promise.all([import('@noble/ed25519'), import('@noble/hashes/sha2.js')]).then(([ed, hashes]) => {
    ed.hashes.sha512 = hashes.sha512;
    sha256 = hashes.sha256;
    noble = ed;
    return ed;
  });
  return loading;
}

function b64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function nonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function readSecret(): Uint8Array | null {
  try {
    const stored = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) ?? 'null') as { secret?: unknown } | null;
    if (typeof stored?.secret !== 'string') return null;
    const secret = fromB64url(stored.secret);
    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  }
}

function build(ed: Noble, secret: Uint8Array): DeviceKey {
  const publicKey = b64url(ed.getPublicKey(secret));
  const sign = (input: string): string => b64url(ed.sign(new TextEncoder().encode(input), secret));
  return {
    publicKey,
    id: hex(sha256!(fromB64url(publicKey))),
    hello(coreId) {
      const at = Date.now();
      const once = nonce();
      return { id: this.id, at, nonce: once, sig: sign(deviceHelloInput(coreId, at, once)) };
    },
    admit(grant, name) {
      return { publicKey, name, sig: sign(deviceAdmitInput(grant, publicKey)) };
    },
    enroll(coreId) {
      const at = Date.now();
      return { publicKey, at, sig: sign(deviceHelloInput(coreId, at, 'enroll')) };
    }
  };
}

let current: DeviceKey | null = null;

/** The key this device already holds, or null. Synchronous once `loadSigner` resolved. */
export function heldDeviceKey(): DeviceKey | null {
  if (current !== null || noble === null) return current;
  const secret = readSecret();
  current = secret === null ? null : build(noble, secret);
  return current;
}

/** This device's key, made and kept on first use. */
export async function deviceKey(): Promise<DeviceKey> {
  const ed = await loadSigner();
  const held = heldDeviceKey();
  if (held !== null) return held;
  const secret = ed.utils.randomSecretKey();
  localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ secret: b64url(secret) }));
  current = build(ed, secret);
  return current;
}

/**
 * The group removed this device: its key opens nothing any more and is never
 * admitted again, so it goes, and the next admission makes a new one.
 */
export function dropDeviceKey(): void {
  try { localStorage.removeItem(DEVICE_STORAGE_KEY); } catch { /* storage refused */ }
  current = null;
}

/** Another window made or replaced the key: read it again. */
export function forgetLoadedKey(): void {
  current = null;
}
