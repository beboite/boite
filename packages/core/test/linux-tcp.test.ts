import { expect, test } from 'bun:test';
import { LinuxTcp } from '../src/platform/linux-tcp.ts';
import { LinuxTcpClient, type TcpWorkerHandle } from '../src/platform/linux-tcp-client.ts';
import type { TcpWorkerCommand } from '../src/platform/linux-tcp-worker.ts';
import { unavailableResourceBytes } from '../src/resource-usage.ts';
import { parseDiagnosticPacket, type TcpCounter } from '../src/platform/linux-tcp-parser.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

function stat(pid: number, birth = 100): string {
  const fields = Array<string>(20).fill('0'); fields[0] = 'S'; fields[19] = String(birth);
  return `${pid} (fixture) ${fields.join(' ')}`;
}

function packet(counter: TcpCounter): Uint8Array {
  const bytes = new Uint8Array(372);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length, true); view.setUint16(4, 20, true); view.setUint32(8, 1, true);
  view.setUint32(16 + 68, counter.inode, true); view.setUint32(16 + 44, 7, true); view.setUint32(16 + 48, 8, true);
  view.setUint16(88, 284, true); view.setUint16(90, 2, true);
  view.setBigUint64(92 + 128, BigInt(counter.readBytes), true); view.setBigUint64(92 + 200, BigInt(counter.writeBytes), true);
  return bytes;
}

test('TCP diagnostics decode payload counters and refuse malformed or interrupted snapshots', () => {
  const bytes = packet({ inode: 700, cookie: 'unused', readBytes: 8192, writeBytes: 16384 });
  expect(parseDiagnosticPacket(bytes, 1).counters).toEqual([{ inode: 700, cookie: '7:8', readBytes: 8192, writeBytes: 16384 }]);
  expect(parseDiagnosticPacket(bytes.subarray(0, bytes.length - 1), 1).error).toBe(true);
  expect(parseDiagnosticPacket(bytes, 2).error).toBe(true);
  new DataView(bytes.buffer).setUint16(6, 0x10, true);
  expect(parseDiagnosticPacket(bytes, 1).error).toBe(true);
});

test('TCP attribution requires an owned FD, stable PID birth and socket cookie; shared sockets contribute to neither agent', async () => {
  const files = new Map([['/proc/10/stat', stat(10)], ['/proc/20/stat', stat(20)], ['/proc/10/fd', '3'], ['/proc/20/fd', '3']]);
  const links = new Map([['/proc/self/ns/net', 'net:[1]'], ['/proc/10/ns/net', 'net:[1]'], ['/proc/20/ns/net', 'net:[1]'], ['/proc/10/fd/3', 'socket:[700]']]);
  let now = 1000;
  let loads = 0;
  let dumps = 0;
  let closes = 0;
  let counters: TcpCounter[] | null = [{ inode: 700, cookie: '7:8', readBytes: 100, writeBytes: 200 }];
  const collector = new LinuxTcp(path => files.get(path) ?? null, path => links.get(path) ?? null, () => now,
    async () => { loads += 1; return { dump: async () => { dumps += 1; return counters; }, close: () => { closes += 1; } }; });
  const one = new Map([['one', [{ pid: 10, birth: 100 }]]]);
  collector.finish(one);
  expect(loads).toBe(0);
  collector.watch(true);
  const sample = async (members = one) => { collector.finish(members); await waitFor(() => collector.sample('one').sampledAt === now); now += 1000; };
  await sample();
  expect(collector.sample('one')).toMatchObject({ readBytes: 0, readBytesPerSecond: null });
  counters = null;
  await collector.finish(one);
  expect(collector.sample('one')).toMatchObject({ coverage: 'unavailable', sampledAt: null, readBytes: null, writeBytes: null });
  now += 1000;
  counters = [{ inode: 700, cookie: '7:8', readBytes: 8192 + 100, writeBytes: 16384 + 200 }];
  await sample();
  expect(collector.sample('one')).toMatchObject({ since: 1000, readBytes: 8192, writeBytes: 16384, readBytesPerSecond: 4096, writeBytesPerSecond: 8192 });
  links.set('/proc/20/fd/3', 'socket:[700]');
  counters = [{ inode: 700, cookie: '7:8', readBytes: 99999, writeBytes: 99999 }];
  await sample(new Map([['one', [{ pid: 10, birth: 100 }]], ['two', [{ pid: 20, birth: 100 }]]]));
  expect(collector.sample('one').readBytes).toBe(8192);
  expect(collector.sample('two').readBytes).toBe(0);
  links.delete('/proc/20/fd/3');
  counters = [{ inode: 700, cookie: 'new:cookie', readBytes: 999999, writeBytes: 999999 }];
  await sample();
  expect(collector.sample('one').readBytes).toBe(8192);
  files.set('/proc/10/stat', stat(10, 200));
  collector.finish(one);
  await waitFor(() => collector.sample('one').coverage === 'unavailable');
  collector.watch(false);
  expect(closes).toBe(1);
  const previousDumps = dumps;
  collector.finish(one);
  expect(dumps).toBe(previousDumps);
});

test('disabling a watch discards a pending diagnostic result and disposes its native reader', async () => {
  let resolve: ((value: TcpCounter[]) => void) | undefined;
  let closed = false;
  const collector = new LinuxTcp(path => path.endsWith('/stat') ? stat(10) : '3',
    path => path.endsWith('/3') ? 'socket:[700]' : 'net:[1]', Date.now,
    async () => ({ dump: () => new Promise<TcpCounter[]>(done => { resolve = done; }), close: () => { closed = true; } }));
  collector.watch(true);
  collector.finish(new Map([['one', [{ pid: 10, birth: 100 }]]]));
  await waitFor(() => resolve !== undefined);
  collector.watch(false);
  resolve!([{ inode: 700, cookie: '7:8', readBytes: 8192, writeBytes: 16384 }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(closed).toBe(true);
  expect(collector.sample('one').coverage).toBe('unavailable');
});

test('lazy TCP worker serializes requests, rejects changed process births and forgotten or offscreen replies, then stops', async () => {
  let starts = 0;
  let stops = 0;
  const commands: TcpWorkerCommand[] = [];
  const worker: TcpWorkerHandle = { onmessage: null, onerror: null,
    postMessage: command => {
      commands.push(command);
      if (command.kind === 'stop') queueMicrotask(() => worker.onmessage?.({ data: { kind: 'stopped' } }));
    }, terminate: () => { stops += 1; } };
  const client = new LinuxTcpClient(() => { starts += 1; return worker; });
  const members = new Map([['one', [{ pid: 10, birth: 100 }]]]);
  const usage = { ...unavailableResourceBytes(), source: 'linux-tcp-info' as const, coverage: 'partial' as const,
    sampledAt: 1000, readBytes: 8192, writeBytes: 16384 };
  client.finish(members);
  expect(starts).toBe(0);
  client.watch(true); client.finish(members); client.finish(members);
  expect(starts).toBe(1);
  expect(commands.filter(command => command.kind === 'sample')).toHaveLength(1);
  worker.onmessage?.({ data: { kind: 'sample', id: 1, samples: [['one', usage]] } });
  expect(client.sample('one', members.get('one')!).writeBytes).toBe(16384);
  expect(client.sample('one', [{ pid: 10, birth: 200 }]).coverage).toBe('unavailable');
  client.finish(members); client.forget('one');
  worker.onmessage?.({ data: { kind: 'sample', id: 2, samples: [['one', usage]] } });
  expect(client.sample('one', members.get('one')!).coverage).toBe('unavailable');
  client.finish(members); client.watch(false);
  worker.onmessage?.({ data: { kind: 'sample', id: 3, samples: [['one', usage]] } });
  await client.closed();
  expect(stops).toBe(1);
  expect(client.sample('one', members.get('one')!).coverage).toBe('unavailable');
});

test('TCP worker fallback termination bounds a worker that refuses its stop acknowledgement', async () => {
  let terminated = false;
  const worker: TcpWorkerHandle = { onmessage: null, onerror: null, postMessage() {}, terminate() { terminated = true; } };
  const client = new LinuxTcpClient(() => worker);
  client.watch(true); client.finish(new Map([['one', [{ pid: 10, birth: 100 }]]]));
  const started = performance.now();
  await client.closed();
  expect(terminated).toBe(true);
  expect(performance.now() - started).toBeLessThan(1000);
});

test('a TCP worker error recovers under the existing visible lease and rejects replies from the failed worker', async () => {
  const workers: TcpWorkerHandle[] = [];
  const commands: TcpWorkerCommand[][] = [];
  let now = 0;
  const client = new LinuxTcpClient(() => {
    const index = workers.length; commands.push([]);
    const worker: TcpWorkerHandle = { onmessage: null, onerror: null, terminate() {},
      postMessage(command) {
        commands[index]!.push(command);
        if (command.kind === 'stop') queueMicrotask(() => worker.onmessage?.({ data: { kind: 'stopped' } }));
      } };
    workers.push(worker); return worker;
  }, () => now);
  const members = new Map([['one', [{ pid: 10, birth: 100 }]]]);
  const usage = { ...unavailableResourceBytes(), source: 'linux-tcp-info' as const, coverage: 'partial' as const,
    sampledAt: 1000, readBytes: 8192, writeBytes: 16384 };
  try {
    client.watch(true); client.finish(members);
    const previousReply = workers[0]!.onmessage!;
    workers[0]!.onerror?.(new Error('fixture worker failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    client.finish(members); expect(workers).toHaveLength(1);
    now = 1000;
    client.finish(members);
    expect(workers).toHaveLength(2);
    const request = commands[1]!.find(command => command.kind === 'sample');
    expect(request?.kind).toBe('sample');
    previousReply({ data: { kind: 'sample', id: 1, samples: [['one', usage]] } });
    expect(client.sample('one', members.get('one')!).coverage).toBe('unavailable');
    workers[1]!.onmessage?.({ data: { kind: 'sample', id: request!.kind === 'sample' ? request!.id : -1, samples: [['one', usage]] } });
    expect(client.sample('one', members.get('one')!).writeBytes).toBe(16384);
    const replacedReply = workers[1]!.onmessage!;
    client.watch(false); client.watch(true); client.finish(members);
    expect(workers).toHaveLength(2);
    await new Promise(resolve => setTimeout(resolve, 0));
    client.finish(members);
    expect(workers).toHaveLength(3);
    replacedReply({ data: { kind: 'sample', id: request!.kind === 'sample' ? request!.id : -1, samples: [['one', usage]] } });
    expect(client.sample('one', members.get('one')!).coverage).toBe('unavailable');
  } finally { await client.closed(); }
});

test('an unresponsive TCP worker times out on shared detail ticks without retrying offscreen', async () => {
  let now = 0;
  let starts = 0;
  let terminated = 0;
  const client = new LinuxTcpClient(() => {
    starts += 1;
    const worker: TcpWorkerHandle = { onmessage: null, onerror: null,
      terminate() { terminated += 1; }, postMessage(command) {
        if (command.kind === 'stop') queueMicrotask(() => worker.onmessage?.({ data: { kind: 'stopped' } }));
      } };
    return worker;
  }, () => now);
  const members = new Map([['one', [{ pid: 10, birth: 100 }]]]);
  try {
    client.watch(true); client.finish(members);
    now = 1000; client.finish(members); expect(starts).toBe(1);
    now = 2000; client.finish(members);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(terminated).toBe(1);
    now = 2999; client.finish(members); expect(starts).toBe(1);
    now = 3000; client.finish(members); expect(starts).toBe(2);
    client.watch(false);
    now = 100000; client.finish(members); expect(starts).toBe(2);
  } finally { await client.closed(); }
});

test.skipIf(process.platform !== 'linux')('real watched agent TCP transfers report exact 16KiB sent and 8KiB received', async () => {
  const harness = await startTestCore();
  const threadIdHolder: string[] = [];
  const serverId = 'tcp-owned-fixture-server';
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner); threadIdHolder.push(threadId);
    const serverCode = "const net=require('node:net');const server=net.createServer(s=>{let n=0;s.on('data',b=>{n+=b.length;if(n===16384)s.write(Buffer.alloc(8192))})});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));process.stdin.on('data',()=>{server.close();process.exit(0)})";
    const server = harness.core.procs.spawnPiped(serverId, process.execPath, ['-e', serverCode], { cwd: harness.dataDir });
    const port = Number(new TextDecoder().decode((await server.proc.stdout.getReader().read()).value).trim());
    expect(port).toBeGreaterThan(0);
    const clientCode = "const net=require('node:net');const socket=net.connect(Number(process.argv[1]),'127.0.0.1',()=>console.log('connected'));let n=0;socket.on('data',b=>{n+=b.length;if(n===8192)console.log('received')});process.stdin.on('data',b=>{if(b.toString().trim()==='transfer')socket.write(Buffer.alloc(16384));else{socket.destroy();process.exit(0)}})";
    const client = harness.core.procs.spawnPiped(threadId, process.execPath, ['-e', clientCode, String(port)], { cwd: harness.dataDir });
    const reader = client.proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('connected');
    await owner.call('resources.usage', { watch: true });
    await waitFor(() => harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId)?.network.source === 'linux-tcp-info', 5000);
    client.proc.stdin.write('transfer\n');
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('received');
    await waitFor(() => {
      const network = harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId)?.network;
      return network?.writeBytes === 16384 && network.readBytes === 8192;
    }, 5000);
    const usage = harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId)!.network;
    expect(usage).toMatchObject({ readBytes: 8192, writeBytes: 16384, coverage: 'partial', source: 'linux-tcp-info' });
    expect(usage.readBytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(usage.writeBytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(Math.max(usage.readBytesPerSecond!, usage.writeBytesPerSecond!)).toBeGreaterThan(0);
    await owner.call('resources.usage', { watch: false });
    client.proc.stdin.write('exit\n'); client.proc.stdin.end(); await client.exited;
    server.proc.stdin.write('exit\n'); server.proc.stdin.end(); await server.exited;
  } finally {
    for (const id of [...threadIdHolder, serverId]) await harness.core.procs.stopAndWait(id);
    await harness.stop();
  }
}, 15000);
