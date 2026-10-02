import { dlopen, FFIType, ptr } from 'bun:ffi';
import { parseDiagnosticPacket, type TcpCounter } from './linux-tcp-parser.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 4096;
const MAX_MS = 40;

export interface TcpDiagnostics {
  dump(): Promise<TcpCounter[] | null>;
  close(): void;
}

/** Created only under an active resource lease. Socket reads never block the core. */
export function createTcpDiagnostics(): TcpDiagnostics {
  const library = dlopen('libc.so.6', {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    sendto: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
    recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  const api = library.symbols;
  const sockets = new Set<number>();
  let closed = false;

  function release(fd: number): void {
    if (sockets.delete(fd)) api.close(fd);
  }

  async function family(family: number, sequence: number, deadline: number, budget: { bytes: number; messages: number }): Promise<TcpCounter[] | null> {
    if (closed) return null;
    // SOCK_NONBLOCK and SOCK_CLOEXEC prevent blocking and inheritance by agents.
    const fd = api.socket(16, 2 | 0x800 | 0x80000, 4);
    if (fd < 0) return null;
    sockets.add(fd);
    try {
      const address = new Uint8Array(12);
      new DataView(address.buffer).setUint16(0, 16, true);
      const request = new Uint8Array(72);
      const view = new DataView(request.buffer);
      view.setUint32(0, request.length, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 1 | 0x300, true);
      view.setUint32(8, sequence, true);
      request[16] = family; request[17] = 6; request[18] = 2;
      view.setUint32(20, 0xffffffff, true);
      view.setUint32(64, 0xffffffff, true); view.setUint32(68, 0xffffffff, true);
      if (Number(api.sendto(fd, ptr(request), request.length, 0, ptr(address), address.length)) !== request.length) return null;
      const buffer = new Uint8Array(65536);
      const counters: TcpCounter[] = [];
      while (!closed && performance.now() < deadline) {
        const received = Number(api.recv(fd, ptr(buffer), buffer.length, 0));
        if (received < 0) {
          // Non-blocking recv has no data yet; the deadline also bounds refusal.
          await new Promise(resolve => setTimeout(resolve, 2));
          continue;
        }
        if (received === 0 || (budget.bytes += received) > MAX_BYTES) return null;
        const decoded = parseDiagnosticPacket(buffer.subarray(0, received), sequence);
        if (decoded.error || (budget.messages += decoded.counters.length) > MAX_MESSAGES) return null;
        counters.push(...decoded.counters);
        if (decoded.done) return counters;
      }
      return null;
    } finally { if (!closed) release(fd); }
  }

  return {
    async dump() {
      const deadline = performance.now() + MAX_MS;
      const budget = { bytes: 0, messages: 0 };
      const ipv4 = await family(2, 1, deadline, budget);
      if (ipv4 === null || closed) return null;
      const ipv6 = await family(10, 2, deadline, budget);
      return ipv6 === null ? null : [...ipv4, ...ipv6];
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fd of sockets) release(fd);
      library.close();
    },
  };
}
