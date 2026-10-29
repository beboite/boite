/*
 * One PTR question to Tailscale's resolver, asked over UDP by hand.
 *
 * `Resolver.reverse` from `node:dns` cannot be trusted with it: on Windows,
 * Bun answers it from the system resolver whatever `setServers` says, and the
 * system resolver names this machine's own address by its bare host name
 * (`nuno-x870`, not `nuno-x870.tail0.ts.net`), so a Windows core never learnt
 * its tailnet name. A datagram sent to 100.100.100.100 goes where it says on
 * every platform. Only the answer to the question asked, with its id, counts.
 */
import { randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';

const TYPE_PTR = 12;
const CLASS_IN = 1;
/** A name is 255 bytes at most: no more labels than that to follow. */
const MAX_LABELS = 128;

/** The question for `ip`'s PTR record, `4.3.2.1.in-addr.arpa`, with `id`. */
export function ptrQuestion(ip: string, id: number): Buffer {
  const name = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  // Recursion desired, one question.
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')]));
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(TYPE_PTR, 1);
  tail.writeUInt16BE(CLASS_IN, 3);
  return Buffer.concat([header, ...labels, tail]);
}

/** The name at `offset`, following compression pointers, and where the record goes on. Throws on a malformed one. */
function readName(message: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let at = offset;
  let end: number | null = null;
  for (let step = 0; step < MAX_LABELS; step += 1) {
    if (at >= message.length) throw new Error('name past the end');
    const length = message[at]!;
    if (length === 0) return { name: labels.join('.'), end: end ?? at + 1 };
    if ((length & 0xc0) === 0xc0) {
      if (at + 1 >= message.length) throw new Error('pointer past the end');
      end ??= at + 2;
      at = ((length & 0x3f) << 8) | message[at + 1]!;
      continue;
    }
    if (length > 63 || at + 1 + length > message.length) throw new Error('label past the end');
    labels.push(message.subarray(at + 1, at + 1 + length).toString('latin1'));
    at += 1 + length;
  }
  throw new Error('name too long');
}

/** The first PTR name an answer to question `id` carries, or null: another id, an error code, no PTR. */
export function ptrAnswer(message: Buffer, id: number): string | null {
  try {
    if (message.length < 12 || message.readUInt16BE(0) !== id) return null;
    const flags = message.readUInt16BE(2);
    // A response, without an error code.
    if ((flags & 0x8000) === 0 || (flags & 0x000f) !== 0) return null;
    const questions = message.readUInt16BE(4);
    const answers = message.readUInt16BE(6);
    let at = 12;
    for (let index = 0; index < questions; index += 1) at = readName(message, at).end + 4;
    for (let index = 0; index < answers; index += 1) {
      at = readName(message, at).end;
      if (at + 10 > message.length) return null;
      const type = message.readUInt16BE(at);
      const length = message.readUInt16BE(at + 8);
      at += 10;
      if (type === TYPE_PTR) return readName(message, at).name;
      at += length;
    }
    return null;
  } catch {
    return null;
  }
}

/** The PTR name `server` gives `ip`, or null when it has none or stays silent for `timeoutMs`. */
export function reverseLookup(ip: string, server: { host: string; port: number }, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    const id = randomInt(0x10000);
    const socket = createSocket('udp4');
    let settled = false;
    const done = (name: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Closed already. */ }
      resolve(name);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('error', () => done(null));
    socket.on('message', (message, from) => {
      // A datagram from anywhere else, or an answer to another question, is not this one's.
      if (from.address !== server.host || from.port !== server.port) return;
      const name = ptrAnswer(message, id);
      if (name !== null || (message.length >= 2 && message.readUInt16BE(0) === id)) done(name);
    });
    socket.send(ptrQuestion(ip, id), server.port, server.host, error => { if (error) done(null); });
  });
}
