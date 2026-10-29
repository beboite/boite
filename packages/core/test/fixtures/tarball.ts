import { gzipSync } from 'fflate';

/**
 * A gzipped ustar archive the way npm packs a package. A name past the
 * 100-byte field goes in a pax header before its entry, as npm writes it.
 */
export function tarball(entries: { name: string; bytes?: Uint8Array; type?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const text = new TextEncoder();
  const header = (name: string, size: number, type: string): Uint8Array => {
    const block = new Uint8Array(512);
    const put = (offset: number, value: string): void => block.set(text.encode(value), offset);
    put(0, name.slice(0, 100));
    put(100, '0000755\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, `${size.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, type);
    put(257, 'ustar\0');
    put(263, '00');
    const sum = block.reduce((total, byte) => total + byte, 0);
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    return block;
  };
  const body = (bytes: Uint8Array): Uint8Array => {
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 512) * 512);
    padded.set(bytes);
    return padded;
  };
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array(0);
    if (entry.name.length > 100) {
      const record = ` path=${entry.name}\n`;
      // The length counts its own digits.
      let length = record.length + 1;
      while (`${length}${record}`.length !== length) length += 1;
      const pax = text.encode(`${length}${record}`);
      blocks.push(header('PaxHeader', pax.byteLength, 'x'), body(pax));
    }
    blocks.push(header(entry.name, bytes.byteLength, entry.type ?? '0'), body(bytes));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks));
}
