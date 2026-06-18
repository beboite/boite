// crypto.randomUUID is only defined in a secure context (HTTPS or localhost).
// Boite is commonly served over plain ws://http:// on a LAN IP (no TLS, behind
// a tunnel), where randomUUID is undefined and calling it throws. getRandomValues
// IS available in insecure contexts, so derive a v4 UUID from it as a fallback.
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}
