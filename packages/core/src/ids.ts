const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LENGTH = 20;

/** Every byte maps to exactly eight of the 256 values, so the draw stays uniform. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte >> 3);
  return prefix + out;
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
