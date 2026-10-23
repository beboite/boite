import { afterEach, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { magicName } from '../src/group/addresses.ts';
import { ptrAnswer, ptrQuestion } from '../src/group/magic-dns.ts';

const servers: Socket[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

/** An answer to `question`: its id and question, then one PTR record whose owner points back at the question's name. */
function answer(question: Buffer, name: string, { id, rcode = 0 }: { id?: number; rcode?: number } = {}): Buffer {
  const header = Buffer.from(question.subarray(0, 12));
  if (id !== undefined) header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(rcode === 0 ? 1 : 0, 6);
  const body = question.subarray(12);
  if (rcode !== 0) return Buffer.concat([header, body]);
  const rdata = Buffer.concat([...name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  const record = Buffer.alloc(12);
  // A compression pointer to the question's name at offset 12, type PTR, class IN, TTL 600.
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(12, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(600, 6);
  record.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([header, body, record, rdata]);
}

/** A resolver on loopback that answers each question with `reply`, or stays silent when it returns null. */
async function resolver(reply: (question: Buffer) => Buffer[] | null): Promise<{ host: string; port: number }> {
  const server = createSocket('udp4');
  servers.push(server);
  server.on('message', (message, from) => {
    for (const datagram of reply(message) ?? []) server.send(datagram, from.port, from.address);
  });
  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: server.address().port };
}

test('the tailnet name comes from the resolver asked, not from the system one that names this machine by its bare host name', async () => {
  const asked: string[] = [];
  const server = await resolver(question => {
    asked.push(question.subarray(12).toString('latin1'));
    return [answer(question, 'Desk.tail0.ts.net.')];
  });
  expect(await magicName('100.101.102.103', server)).toBe('desk.tail0.ts.net');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('103');
  expect(asked[0]).toContain('in-addr');
  // The bare host name the Windows system resolver gives is no address another machine can dial.
  const bare = await resolver(question => [answer(question, 'nuno-x870')]);
  expect(await magicName('100.101.102.103', bare)).toBeNull();
});

test('an answer to another question is ignored, an error code or silence is no name', async () => {
  const late = await resolver(question => [answer(question, 'spoof.tail0.ts.net', { id: (question.readUInt16BE(0) + 1) % 0x10000 }), answer(question, 'desk.tail0.ts.net')]);
  expect(await magicName('100.101.102.103', late)).toBe('desk.tail0.ts.net');
  const missing = await resolver(question => [answer(question, '', { rcode: 3 })]);
  expect(await magicName('100.101.102.103', missing)).toBeNull();
  const silent = await resolver(() => null);
  const started = Date.now();
  expect(await magicName('100.101.102.103', silent)).toBeNull();
  expect(Date.now() - started).toBeLessThan(3000);
});

test('a malformed answer reads as no name', () => {
  const question = ptrQuestion('100.101.102.103', 7);
  const good = answer(question, 'desk.tail0.ts.net');
  expect(ptrAnswer(good, 7)).toBe('desk.tail0.ts.net');
  expect(ptrAnswer(good, 8)).toBeNull();
  expect(ptrAnswer(good.subarray(0, good.length - 4), 7)).toBeNull();
  // A name that points at itself ends instead of spinning.
  const start = good.length - 19;
  const loop = Buffer.concat([good.subarray(0, start), Buffer.from([0xc0 | (start >> 8), start & 0xff])]);
  expect(ptrAnswer(loop, 7)).toBeNull();
});
