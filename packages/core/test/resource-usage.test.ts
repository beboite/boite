import { describe, expect, spyOn, test } from 'bun:test';
import { ResourceWatches, ObservedBytes, RESOURCE_WATCH_MS } from '../src/resource-usage.ts';
import { LinuxResources, storageBytes } from '../src/platform/linux-resources.ts';
import { LinuxLoad } from '../src/platform/linux-load.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { connect } from '../src/client.ts';
import { processPlatform } from '../src/platform/index.ts';

function stat(pid: number, parent = 1, birth = 100): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = 'S'; fields[1] = String(parent); fields[19] = String(birth);
  return `${pid} (fixture) ${fields.join(' ')}`;
}

describe('resource sampling demand and identity', () => {
  test('visible viewers own independent leases; close and expiry release only their lease', () => {
    let now = 0;
    const watches = new ResourceWatches(() => now);
    watches.set('desktop', undefined);
    expect(watches.active()).toBe(false);
    watches.set('desktop', true);
    now = 2000;
    watches.set('phone', true);
    watches.set('desktop', false);
    expect(watches.active()).toBe(true);
    watches.remove('phone');
    expect(watches.active()).toBe(false);
    watches.set('desktop', true);
    now += RESOURCE_WATCH_MS;
    expect(watches.active()).toBe(false);
  });

  test('rates use identity deltas, keep observed totals and never borrow a reused counter', () => {
    const bytes = new ObservedBytes();
    expect(bytes.sample([{ identity: 'old', readBytes: 100, writeBytes: 200 }], 1000, 'linux-proc-io', '').readBytesPerSecond).toBeNull();
    const next = bytes.sample([{ identity: 'old', readBytes: 200, writeBytes: 400 }, { identity: 'old', readBytes: 200, writeBytes: 400 }], 3000, 'linux-proc-io', '');
    expect(next).toMatchObject({ readBytes: 100, writeBytes: 200, readBytesPerSecond: 50, writeBytesPerSecond: 100, since: 1000 });
    expect(bytes.sample([{ identity: 'new', readBytes: 1000, writeBytes: 2000 }], 4000, 'linux-proc-io', '').readBytes).toBe(100);
  });

  test('storage counters exclude character IO and do not recount reaped children through parent totals', () => {
    expect(storageBytes('rchar: 900000\nwchar: 900000\nread_bytes: 100\nwrite_bytes: 200\n')).toEqual({ readBytes: 100, writeBytes: 200 });
    expect(storageBytes('rchar: 900000\nwchar: 900000\n')).toBeNull();
    const files = new Map([
      ['/proc/10/stat', stat(10)], ['/proc/10/task', '10'], ['/proc/10/task/10/stat', stat(10)],
      ['/proc/10/task/10/io', 'read_bytes: 100\nwrite_bytes: 200\n'],
      ['/proc/10/io', 'read_bytes: 100\nwrite_bytes: 200\n'],
    ]);
    let now = 1000;
    const resources = new LinuxResources(path => files.get(path) ?? null, () => now);
    resources.watch(true);
    expect(resources.sample('thread', [{ pid: 10, birth: 100 }])?.disk.readBytesPerSecond).toBeNull();
    // Waiting for a child adds its counters to /proc/10/io, not task/10/io.
    files.set('/proc/10/io', 'read_bytes: 100000\nwrite_bytes: 200000\n');
    now += 1000;
    expect(resources.sample('thread', [{ pid: 10, birth: 100 }])?.disk.readBytes).toBe(0);
    files.set('/proc/10/task/10/io', 'read_bytes: 150\nwrite_bytes: 250\n');
    now += 1000;
    expect(resources.sample('thread', [{ pid: 10, birth: 100 }])?.disk).toMatchObject({ readBytes: 50, writeBytes: 50 });
    resources.watch(false);
    expect(resources.sample('thread', [{ pid: 10, birth: 100 }])).toBeUndefined();
    resources.watch(true);
    expect(resources.sample('thread', [{ pid: 10, birth: 100 }])?.disk).toMatchObject({ readBytes: 0, readBytesPerSecond: null });
    files.set('/proc/10/stat', stat(10, 1, 200));
    expect(resources.sample('thread', [{ pid: 10, birth: 100 }])?.disk.coverage).toBe('unavailable');
  });

  test('an agent registered below another agent owns its own sampled subtree', () => {
    const files = new Map([
      ['/proc', '10 20 30'], ['/proc/10/stat', stat(10)], ['/proc/20/stat', stat(20, 10)], ['/proc/30/stat', stat(30, 20)],
      ['/proc/10/status', 'RssAnon: 10 kB\n'], ['/proc/20/status', 'RssAnon: 20 kB\n'], ['/proc/30/status', 'RssAnon: 30 kB\n'],
    ]);
    const load = new LinuxLoad(2, path => files.get(path) ?? null, () => 1000);
    load.add('parent-agent', 10);
    load.add('child-agent', 20);
    expect(load.sample('parent-agent')?.memoryBytes).toBe(10 * 1024);
    expect(load.sample('child-agent')?.memoryBytes).toBe(50 * 1024);
  });

  test('a registered root PID reused before exit reconciliation does not acquire the replacement process', () => {
    const files = new Map([['/proc', '10'], ['/proc/10/stat', stat(10)], ['/proc/10/status', 'RssAnon: 10 kB\n'],
      ['/proc/10/task', '10'], ['/proc/10/task/10/stat', stat(10)], ['/proc/10/task/10/io', 'read_bytes: 100\nwrite_bytes: 200\n']]);
    let now = 1000;
    const load = new LinuxLoad(2, path => files.get(path) ?? null, () => now);
    load.watchResources(true);
    load.add('agent', 10);
    expect(load.sample('agent')?.memoryBytes).toBe(10 * 1024);
    files.set('/proc/10/task/10/io', 'read_bytes: 200\nwrite_bytes: 300\n');
    now += 1000;
    expect(load.sample('agent')?.resources?.disk).toMatchObject({ writeBytes: 100, writeBytesPerSecond: 100 });
    files.set('/proc/10/stat', stat(10, 1, 200));
    files.set('/proc/10/status', 'RssAnon: 100000 kB\n');
    now += 1000;
    expect(load.sample('agent')).toBeNull();
    files.set('/proc/10/stat', stat(10));
    files.set('/proc/10/task/10/io', 'read_bytes: 1000\nwrite_bytes: 2000\n');
    now += 1000;
    expect(load.sample('agent')?.resources?.disk).toMatchObject({ writeBytes: 0, writeBytesPerSecond: null, since: now });
    load.watchResources(false);
  });

  test('a replacement descendant with the same PID cannot contribute the previous child CPU delta', () => {
    const withTicks = (birth: number, ticks: number): string => {
      const fields = stat(20, 10, birth).split(' '); fields[13] = String(ticks); return fields.join(' ');
    };
    const files = new Map([['/proc', '10 20'], ['/proc/10/stat', stat(10)], ['/proc/20/stat', withTicks(200, 100)],
      ['/proc/10/status', 'RssAnon: 10 kB\n'], ['/proc/20/status', 'RssAnon: 10 kB\n']]);
    let now = 1000;
    const load = new LinuxLoad(2, path => files.get(path) ?? null, () => now);
    load.add('agent', 10); load.sample('agent');
    files.set('/proc/20/stat', withTicks(300, 10000)); now += 1000;
    expect(load.sample('agent')?.cpuPercent).toBe(0);
  });
});

test('paired resource usage is sanitized, read-only and unavailable to agent tokens', async () => {
  const harness = await startTestCore();
  const watchSpy = process.platform === 'linux' ? spyOn(processPlatform, 'watchResources') : null;
  let phone: Awaited<ReturnType<typeof connect>> | undefined;
  let agent: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const command = process.platform === 'linux'
      ? "const fs = require('node:fs'); setInterval(() => { const fd = fs.openSync('agent-storage.bin', 'w'); fs.writeSync(fd, Buffer.alloc(65536)); fs.fsyncSync(fd); fs.closeSync(fd); }, 200)"
      : 'setTimeout(() => {}, 30000)';
    const fixture = harness.core.procs.spawn(threadId, process.execPath, ['-e', command, 'private-command-marker'], { cwd: harness.dataDir });
    const { grant } = await owner.call('pairing.grant', {});
    phone = await connect(harness.url, '', { grant, client: { name: 'resource-test', version: 'test' } });
    const snapshot = await phone.call('resources.usage', { watch: true });
    const row = snapshot.agents.find(row => row.threadId === threadId);
    expect(row?.load.processes).toBe(1);
    expect(Object.keys(row ?? {}).sort()).toEqual(['disk', 'load', 'loadAvailable', 'model', 'network', 'parentThreadId', 'projectId', 'providerId', 'status', 'threadId', 'title']);
    expect(JSON.stringify(snapshot)).not.toContain(harness.dataDir);
    expect(JSON.stringify(snapshot)).not.toContain('private-command-marker');
    await expect(phone.call('resources.list', {})).rejects.toThrow('owner only');
    await expect(phone.call('resources.killTree', { threadId })).rejects.toThrow('owner only');
    await expect(phone.call('resources.usage', { watch: 'bad' } as never)).rejects.toThrow('watch: expected a boolean');
    agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    await expect(agent.call('resources.usage', { watch: true })).rejects.toThrow("not one of the agent's methods");
    if (process.platform === 'linux') {
      await waitFor(() => (harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId)?.disk.writeBytesPerSecond ?? 0) > 0, 5000);
      expect(harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId)?.disk).toMatchObject({ coverage: 'partial', source: 'linux-proc-io' });
      const unreadable = spyOn(processPlatform, 'sample').mockReturnValue(null);
      try {
        await waitFor(() => harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId)?.loadAvailable?.memory === false, 5000);
        const unavailable = (await phone.call('resources.usage', {})).agents.find(row => row.threadId === threadId)!;
        expect(unavailable.disk).toMatchObject({ coverage: 'unavailable', writeBytesPerSecond: null });
        expect(unavailable.network).toMatchObject({ coverage: 'unavailable', writeBytesPerSecond: null });
      } finally { unreadable.mockRestore(); }
      await owner.call('resources.usage', { watch: true });
      await phone.call('resources.usage', { watch: false });
      expect(watchSpy?.mock.calls.at(-1)?.[0]).toBe(true);
      await owner.call('resources.usage', { watch: false });
      expect(watchSpy?.mock.calls.at(-1)?.[0]).toBe(false);
      await phone.call('resources.usage', { watch: true });
      phone.close();
      await waitFor(() => watchSpy?.mock.calls.at(-1)?.[0] === false);
    }
    else await phone.call('resources.usage', { watch: false });
    harness.core.procs.killTree(threadId);
    await fixture.exited;
  } finally {
    phone?.close(); agent?.close(); await harness.stop(); watchSpy?.mockRestore();
  }
}, 15000);
