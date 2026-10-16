/**
 * What one live event costs the core for each window that receives it.
 * Run: bun bench/fanout.ts [--runs 30] [--mib 1]
 *
 * emit: a finished tool call of `--mib` MiB, sent as `message.part` to 1, 2
 * and 4 loopback sockets that opened the thread without compaction, timed
 * around the synchronous `bus.emit` that serializes and writes it.
 * prompt: the bytes a remote window, opened as the UI opens a thread (light
 * files and pictures), receives through a counting relay until the
 * `message.started` of its own prompt with a `--mib` MiB picture arrives.
 */
import { randomBytes } from 'node:crypto';
import { echoThread, startTestCore } from '../packages/core/test/harness';
import { connect, type CoreClient } from '../packages/core/src/client';
import { startWire } from './lib/wire';

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const runs = option('runs', 30), mib = option('mib', 1);
if (!Number.isSafeInteger(runs) || runs < 1 || !(mib > 0 && mib <= 8)) throw new Error('expected --runs >= 1 and 0 < --mib <= 8');

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const harness = await startTestCore();
const clients: CoreClient[] = [];
let wire: ReturnType<typeof startWire> | undefined;
try {
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner, 'Fan-out fixture');
  // Log lines with quotes, tabs and newlines: JSON has to escape them, as a real build log.
  const line = 'error[E0308]: mismatched types\t--> src/main.rs:12:5 "expected `u32`, found `&str`" é\n';
  const output = line.repeat(Math.ceil(mib * 1024 * 1024 / line.length));
  const emit: Record<string, number> = {};
  for (const sockets of [1, 2, 4]) {
    while (clients.length < sockets) {
      const client = await harness.connect();
      await client.call('threads.get', { threadId, limit: 1, open: {} });
      clients.push(client);
    }
    const samples: number[] = [];
    for (let run = 0; run < runs + 2; run++) {
      const toolId = `fanout-${sockets}-${run}`;
      const arrived = clients.map(client => client.next('message.part', event => event.part.type === 'tool' && event.part.toolId === toolId, 30_000));
      const started = performance.now();
      harness.core.bus.emit('message.part', { threadId, messageId: 'fanout', partIndex: 0, part: { type: 'tool', toolId, name: 'Bash', input: { command: 'cat big.log' }, output, status: 'done' } });
      const ms = performance.now() - started;
      await Promise.all(arrived);
      // The first two warm the JIT and the sockets.
      if (run >= 2) samples.push(ms);
    }
    emit[`${sockets} socket${sockets > 1 ? 's' : ''}`] = Number(median(samples).toFixed(2));
  }

  wire = startWire(harness.server.port);
  const phone = await connect(wire.url, harness.token, { headers: { host: 'fanout.fixture.test' }, client: { name: 'bench', version: 'test' } });
  clients.push(phone);
  await phone.call('threads.get', { threadId, limit: 1, compactTools: true, compactToolParts: true, compactFiles: true, compactImages: true, open: {} });
  const picture = randomBytes(Math.round(mib * 1024 * 1024)).toString('base64');
  await Bun.sleep(100);
  wire.reset();
  const landed = phone.next('message.started', message => message.role === 'user', 30_000);
  await phone.call('turns.start', { threadId, prompt: 'look at this', attachments: [{ kind: 'image', mimeType: 'image/png', data: picture, name: 'photo.png' }] });
  const message = await landed;
  const { down } = wire.read();
  const part = message.parts.find(entry => entry.type === 'image');
  console.log(JSON.stringify({
    date: new Date().toISOString(), runs, mib,
    emitMedianMs: emit,
    prompt: { downBytes: down, pictureDeferred: part?.type === 'image' && part.dataDeferred === true },
  }, null, 2));
} finally {
  for (const client of clients) client.close();
  wire?.stop();
  await harness.stop();
}
