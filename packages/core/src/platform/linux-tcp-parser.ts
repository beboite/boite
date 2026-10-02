/** Kernel TCP payload counters; no endpoint or unrelated socket row reaches clients. */
export interface TcpCounter { inode: number; cookie: string; readBytes: number; writeBytes: number }

export interface DiagnosticPacket { counters: TcpCounter[]; done: boolean; error: boolean }

/** Bounded netlink datagram parser. A truncated or malformed packet is refused. */
export function parseDiagnosticPacket(packet: Uint8Array, sequence: number): DiagnosticPacket {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const result: DiagnosticPacket = { counters: [], done: false, error: false };
  let messages = 0;
  for (let offset = 0; offset < packet.byteLength;) {
    if (++messages > 4096 || offset + 16 > packet.byteLength) return { ...result, error: true };
    const length = view.getUint32(offset, true);
    if (length < 16 || offset + length > packet.byteLength) return { ...result, error: true };
    const type = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 6, true);
    if (view.getUint32(offset + 8, true) !== sequence || (flags & 0x10) !== 0) return { ...result, error: true };
    if (type === 3) { result.done = true; if (length >= 20 && view.getInt32(offset + 16, true) !== 0) result.error = true; }
    else if (type === 2) result.error = true;
    else if (type === 20) {
      if (length < 88) return { ...result, error: true };
      const body = offset + 16;
      const inode = view.getUint32(body + 68, true);
      const cookie = `${view.getUint32(body + 44, true)}:${view.getUint32(body + 48, true)}`;
      for (let attribute = body + 72; attribute < offset + length;) {
        if (attribute + 4 > offset + length) return { ...result, error: true };
        const size = view.getUint16(attribute, true);
        if (size < 4 || attribute + size > offset + length) return { ...result, error: true };
        const kind = view.getUint16(attribute + 2, true) & 0x3fff;
        if (kind === 2 && size >= 212 && inode > 0 && cookie !== '4294967295:4294967295') {
          const info = attribute + 4;
          const readBytes = Number(view.getBigUint64(info + 128, true));
          const writeBytes = Number(view.getBigUint64(info + 200, true));
          if (Number.isSafeInteger(readBytes) && Number.isSafeInteger(writeBytes)) result.counters.push({ inode, cookie, readBytes, writeBytes });
        }
        attribute += (size + 3) & ~3;
      }
    }
    offset += (length + 3) & ~3;
  }
  return result;
}
