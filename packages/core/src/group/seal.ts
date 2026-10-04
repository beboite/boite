/*
 * What two members of a group say to each other, sealed.
 *
 * A group runs over whatever network its machines share, and that network is
 * not always a tailnet or HTTPS. So a request between members is encrypted to
 * the recipient before it leaves, whatever carries it: nobody on the path
 * reads a roster, an agent's message or an invitation's grant, and nobody
 * changes one unnoticed.
 *
 * Each machine holds an X25519 key beside its Ed25519 identity and lists the
 * public half in the roster, signed with that identity so no other member can
 * swap it. To seal, the sender makes a one-time X25519 key, agrees on a secret
 * with the recipient's listed key, and derives two AES-256-GCM keys from it
 * with HKDF-SHA256: one for the request, one for the answer. The construction
 * is the base mode of HPKE (RFC 9180) with its answer key, written with the
 * primitives the runtime ships rather than a dependency.
 *
 * What is sealed is the signed message, signature included, so who sent it is
 * proved inside and hidden outside. The key derivation takes both machines'
 * ids, so a sealed request opened by the wrong machine, or presented as coming
 * from another, fails to open. An invitation's grant goes in as a pre-shared
 * key: a join request only opens for the machine that minted that invitation.
 *
 * The limit: the recipient's key is long-lived. Someone who records the
 * traffic and later steals that machine's key file reads what was sent to it.
 */

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { invalidParams } from '../errors.ts';

/** What the signature header carries when the body is sealed and the signature is inside it. */
export const SEALED = 'sealed-v1';
const LABEL = 'boite-group-seal-v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NO_PSK = Buffer.alloc(KEY_BYTES);

/** The two machines of one exchange, by id: who seals and who opens. */
export interface SealContext {
  from: string;
  to: string;
}

/** What the answer to a sealed request is sealed with, kept by both ends for the length of one exchange. */
export interface Sealing {
  responseKey: Buffer;
  context: SealContext;
}

interface SealedRequest { v: 1; epk: string; iv: string; ct: string }
interface SealedResponse { v: 1; iv: string; ct: string }

export class SealFailure extends Error {}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

function bytes(value: unknown, length: number | null, what: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new SealFailure(`${what}: not base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (length !== null && decoded.length !== length) throw new SealFailure(`${what}: expected ${length} bytes`);
  return decoded;
}

export function newBoxKey(): KeyObject {
  return generateKeyPairSync('x25519').privateKey;
}

export function readBoxKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'x25519') throw new Error('expected an X25519 private key');
  return key;
}

/** The public half as the roster lists it: 32 bytes, base64url. */
export function boxPublic(privateKey: KeyObject): string {
  return (createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x;
}

function publicKey(box: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64(bytes(box, KEY_BYTES, 'box key')) }, format: 'jwk' });
}

/** Refused with the field when it is not a usable X25519 public key. */
export function checkBox(value: unknown, field: string): string {
  try {
    const raw = bytes(value, KEY_BYTES, field);
    publicKey(b64(raw));
    return b64(raw);
  } catch {
    throw invalidParams(`${field}: expected an X25519 public key of 32 bytes in base64url`, { field });
  }
}

/** What a machine signs to say a box key is its own. */
export function boxSigningInput(coreId: string, box: string): Buffer {
  return Buffer.from(`boite-group-box\n${coreId}\n${box}`);
}

function agree(privateKey: KeyObject, peer: KeyObject): Buffer {
  // The runtime refuses a key that would give an all-zero secret.
  try { return diffieHellman({ privateKey, publicKey: peer }); } catch { throw new SealFailure('key agreement failed'); }
}

function deriveKeys(shared: Buffer, epk: string, box: string, context: SealContext, psk: Buffer): { request: Buffer; response: Buffer } {
  const info = Buffer.from(`${LABEL}\n${context.from}\n${context.to}\n${epk}\n${box}`);
  const okm = Buffer.from(hkdfSync('sha256', shared, psk, info, KEY_BYTES * 2));
  return { request: okm.subarray(0, KEY_BYTES), response: okm.subarray(KEY_BYTES) };
}

function aad(direction: 'request' | 'response', context: SealContext): Buffer {
  return Buffer.from(`${LABEL}\n${direction}\n${context.from}\n${context.to}`);
}

function encrypt(key: Buffer, data: Buffer, plaintext: string): { iv: string; ct: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(data);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: b64(iv), ct: b64(ct) };
}

function decrypt(key: Buffer, data: Buffer, iv: unknown, ct: unknown): string {
  const sealed = bytes(ct, null, 'ciphertext');
  if (sealed.length < TAG_BYTES) throw new SealFailure('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes(iv, IV_BYTES, 'iv'), { authTagLength: TAG_BYTES });
  decipher.setAAD(data);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new SealFailure('the sealed message does not open: wrong key, wrong machine or altered in transit');
  }
}

function parse(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SealFailure('not a sealed message'); }
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) throw new SealFailure('not a sealed message');
  return value as Record<string, unknown>;
}

/**
 * Seals `plaintext` to the machine whose listed key is `box`. `responseKey`
 * opens that machine's answer and nothing else: it is the caller's to keep
 * until the answer arrives.
 */
export function seal(plaintext: string, box: string, context: SealContext, psk: Buffer = NO_PSK): { body: string; responseKey: Buffer } {
  const ephemeral = generateKeyPairSync('x25519');
  const epk = boxPublic(ephemeral.privateKey);
  const keys = deriveKeys(agree(ephemeral.privateKey, publicKey(box)), epk, box, context, psk);
  const message: SealedRequest = { v: 1, epk, ...encrypt(keys.request, aad('request', context), plaintext) };
  return { body: JSON.stringify(message), responseKey: keys.response };
}

/** Opens a request sealed to this machine. Throws `SealFailure` on anything that is not one. */
export function open(body: string, privateKey: KeyObject, context: SealContext, psk: Buffer = NO_PSK): { plaintext: string; responseKey: Buffer } {
  const message = parse(body);
  const epk = b64(bytes(message['epk'], KEY_BYTES, 'epk'));
  const keys = deriveKeys(agree(privateKey, publicKey(epk)), epk, boxPublic(privateKey), context, psk);
  return { plaintext: decrypt(keys.request, aad('request', context), message['iv'], message['ct']), responseKey: keys.response };
}

export function sealResponse(plaintext: string, responseKey: Buffer, context: SealContext): string {
  const message: SealedResponse = { v: 1, ...encrypt(responseKey, aad('response', context), plaintext) };
  return JSON.stringify(message);
}

export function openResponse(body: string, responseKey: Buffer, context: SealContext): string {
  const message = parse(body);
  return decrypt(responseKey, aad('response', context), message['iv'], message['ct']);
}

/** A signed message and its signature as one sealed text: the signature first, then the body untouched. */
export function pack(body: string, signature: string): string {
  return `${signature}\n${body}`;
}

export function unpack(plaintext: string): { body: string; signature: string } {
  const cut = plaintext.indexOf('\n');
  if (cut <= 0) throw new SealFailure('the sealed message carries no signature');
  return { signature: plaintext.slice(0, cut), body: plaintext.slice(cut + 1) };
}
