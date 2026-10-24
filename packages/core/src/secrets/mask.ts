/**
 * Replaces a secret's value by `•••• (<NAME>)` in text the core shows or
 * keeps, without holding the value: each pattern is the value's length, a
 * rolling hash of its UTF-8 bytes and an HMAC under a key drawn for this
 * process. A window whose rolling hash matches is confirmed by its HMAC.
 * The URL-encoded form is a pattern of its own. Values under
 * `SECRET_MASK_MIN_BYTES` are left alone: masking `abc` would hide every
 * `abc` the agent writes.
 */
import { SECRET_MASK_MIN_BYTES, secretMask } from '@boite/contracts';

interface Pattern {
  name: string;
  length: number;
  hash: number;
  mac: string;
}

const BASE = 257;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function rolling(bytes: Uint8Array, start: number, length: number): number {
  let hash = 0;
  for (let index = start; index < start + length; index += 1) hash = (Math.imul(hash, BASE) + bytes[index]!) >>> 0;
  return hash;
}

function power(length: number): number {
  let out = 1;
  for (let index = 1; index < length; index += 1) out = Math.imul(out, BASE) >>> 0;
  return out;
}

export class SecretMasks {
  readonly #key = crypto.getRandomValues(new Uint8Array(32));
  /** Scope (`thread:<id>` or `project:<id>`) to secret key to its patterns. */
  readonly #scopes = new Map<string, Map<string, Pattern[]>>();

  #mac(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256', this.#key).update(bytes).digest('hex');
  }

  #pattern(name: string, bytes: Uint8Array): Pattern {
    return { name, length: bytes.length, hash: rolling(bytes, 0, bytes.length), mac: this.#mac(bytes) };
  }

  /**
   * Learns `value` under `scope`. The bytes stay the caller's to zero; the
   * URL-encoded form needs a JS string for the length of this call.
   */
  add(scope: string, secretKey: string, name: string, value: Uint8Array): void {
    if (value.length < SECRET_MASK_MIN_BYTES) return;
    const patterns = [this.#pattern(name, value)];
    const encoded = encoder.encode(encodeURIComponent(decoder.decode(value)));
    if (encoded.length !== value.length || encoded.some((byte, index) => byte !== value[index])) patterns.push(this.#pattern(name, encoded));
    encoded.fill(0);
    let secrets = this.#scopes.get(scope);
    if (secrets === undefined) this.#scopes.set(scope, secrets = new Map());
    secrets.set(secretKey, patterns);
  }

  remove(scope: string, secretKey: string): void {
    const secrets = this.#scopes.get(scope);
    secrets?.delete(secretKey);
    if (secrets?.size === 0) this.#scopes.delete(scope);
  }

  removeScope(scope: string): void {
    this.#scopes.delete(scope);
  }

  get empty(): boolean {
    return this.#scopes.size === 0;
  }

  has(scopes: readonly string[]): boolean {
    return scopes.some(scope => this.#scopes.has(scope));
  }

  /** Masks with the patterns of these scopes only. */
  mask(scopes: readonly string[], text: string): string {
    if (this.#scopes.size === 0) return text;
    const patterns: Pattern[] = [];
    for (const scope of scopes) for (const list of this.#scopes.get(scope)?.values() ?? []) patterns.push(...list);
    return this.#apply(patterns, text);
  }

  /** Masks with every pattern known: for logs, which are not one thread's. */
  maskAll(text: string): string {
    if (this.#scopes.size === 0) return text;
    const patterns: Pattern[] = [];
    for (const secrets of this.#scopes.values()) for (const list of secrets.values()) patterns.push(...list);
    return this.#apply(patterns, text);
  }

  #apply(patterns: Pattern[], text: string): string {
    // A UTF-16 unit is at most three UTF-8 bytes: no shorter text holds the shortest value masked.
    if (patterns.length === 0 || text.length * 3 < SECRET_MASK_MIN_BYTES) return text;
    const bytes = encoder.encode(text);
    const byLength = new Map<number, Pattern[]>();
    for (const pattern of patterns) {
      if (pattern.length > bytes.length) continue;
      const group = byLength.get(pattern.length);
      if (group === undefined) byLength.set(pattern.length, [pattern]);
      else group.push(pattern);
    }
    const hits: { start: number; end: number; name: string }[] = [];
    for (const [length, group] of byLength) {
      const top = power(length);
      let hash = rolling(bytes, 0, length);
      for (let start = 0; ; start += 1) {
        for (const pattern of group) {
          if (pattern.hash === hash && this.#mac(bytes.subarray(start, start + length)) === pattern.mac) {
            hits.push({ start, end: start + length, name: pattern.name });
            break;
          }
        }
        if (start + length >= bytes.length) break;
        hash = (Math.imul((hash - Math.imul(bytes[start]!, top)) >>> 0, BASE) + bytes[start + length]!) >>> 0;
      }
    }
    if (hits.length === 0) return text;
    // A match starts on a UTF-8 lead byte and ends before one: cutting there never splits a character.
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = '';
    let at = 0;
    for (const hit of hits) {
      if (hit.start < at) continue;
      out += decoder.decode(bytes.subarray(at, hit.start)) + secretMask(hit.name);
      at = hit.end;
    }
    return out + decoder.decode(bytes.subarray(at));
  }
}

/** Masks every string inside a JSON-like value, the same objects back when nothing changed. */
export function maskDeep<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === 'string') return mask(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => { const next = maskDeep(item, mask); changed ||= next !== item; return next; });
    return (changed ? out : value) as T;
  }
  if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) { const next = maskDeep(item, mask); changed ||= next !== item; out[key] = next; }
    return (changed ? out : value) as T;
  }
  return value;
}
