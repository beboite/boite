import { afterEach, expect, spyOn, test } from 'bun:test';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { connect } from '../src/client.ts';
import { BrowserDaemon } from '../src/browser/daemon.ts';
import { parseManifest } from '../src/plugins/manifest.ts';
import { RECOMMENDED } from '../src/plugins.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserStore } from '../src/browser.ts';

let harness: TestCore | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => { await harness?.stop(); harness = undefined; for (const cleanup of cleanups.splice(0)) cleanup(); });

test.each(['{', '{"enabled":"yes","executablePath":null}'])('invalid browser settings disable automation and remain repairable: %s', async raw => {
  harness = await startTestCore();
  const file = join(harness.dataDir, 'browser.json');
  writeFileSync(file, raw);
  const warning = spyOn(harness.core, 'log'); cleanups.push(() => warning.mockRestore());
  const browser = new BrowserStore(harness.core);
  await Promise.resolve();
  expect(browser.status().config).toEqual({ enabled: false, executablePath: null });
  expect(warning).toHaveBeenCalledWith('warn', expect.stringContaining(file));
  await browser.configure({ enabled: true, executablePath: null });
  expect(new BrowserStore(harness.core).status().config.enabled).toBe(true);
});

test('browser capability is explicit and rejects unknown protocol versions', () => {
  const manifest = RECOMMENDED.find(item => item.id === 'jev-browser')!;
  expect(parseManifest(manifest, 'fixture').provides.browser?.protocol).toBe('agent-browser-0.37');
  expect(() => parseManifest({ ...manifest, provides: { browser: { protocol: 'anything' } } }, 'fixture')).toThrow('provides.browser.protocol');
});

test('browser configuration accepts automatic discovery or an existing file and rejects a missing executable', async () => {
  harness = await startTestCore(); const owner = await harness.connect();
  const executablePath = join(harness.dataDir, 'browser-fixture');
  await expect(owner.call('browser.configure', { enabled: false, executablePath })).rejects.toThrow('existing browser executable');
  writeFileSync(executablePath, 'fixture, never executed');
  expect((await owner.call('browser.configure', { enabled: false, executablePath })).config.executablePath).toBe(executablePath);
  expect((await owner.call('browser.configure', { enabled: false, executablePath: null })).config.executablePath).toBeNull();
});

test('shutdown refuses a new browser task before checking plugin configuration', async () => {
  harness = await startTestCore();
  await harness.core.drain();
  expect(() => harness!.core.browser.start({ threadId: 't1', pluginId: 'jev-browser', url: 'https://example.org', goal: 'Open page', completion: { text: 'Example' } })).toThrow('shutting down');
});

test('agents cannot enable automation, inspect credentials, or read another thread', async () => {
  harness = await startTestCore(); const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
  try {
    await expect(agent.call('browser.status', {})).rejects.toThrow('agent');
    await expect(agent.call('browser.configure', { enabled: true, executablePath: null })).rejects.toThrow('agent');
    await expect(agent.call('browser.list', { threadId: 'someone-else' })).rejects.toThrow('not thread');
    await expect(agent.call('browser.cancel', { threadId, id: 'unknown' })).rejects.toThrow('belong');
    await expect(agent.call('browser.start', { threadId, pluginId: 'jev-browser', url: 'https://example.org', goal: 'Open page', completion: { text: 'Example' } })).rejects.toThrow('Enable browser');
    expect(await agent.call('browser.list', { threadId })).toEqual([]);
  } finally { agent.close(); }
});

test('browser progress reaches the owner and owning agent, not other agents or devices', async () => {
  harness = await startTestCore(); const owner = await harness.connect();
  const { threadId, accountId } = await echoThread(harness, owner);
  const first = await owner.call('threads.get', { threadId });
  const second = await owner.call('threads.create', { projectId: first.projectId, providerId: 'echo', accountId, title: 'second' });
  const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
  const other = await connect(harness.url, harness.core.agents.tokenFor(second.id));
  const { grant } = await owner.call('pairing.grant', {});
  const device = await connect(harness.url, '', { grant });
  const counts = { owner: 0, agent: 0, other: 0, device: 0 };
  owner.on('browser.updated', () => counts.owner++); agent.on('browser.updated', () => counts.agent++);
  other.on('browser.updated', () => counts.other++); device.on('browser.updated', () => counts.device++);
  try {
    harness.core.bus.emit('browser.updated', { id: 'fixture', threadId, pluginId: 'jev-browser', goal: 'Own task', status: 'running', step: 0, maxSteps: 1, startedAt: Date.now(), finishedAt: null, url: 'https://example.org', message: 'Starting', inputTokens: 0 });
    // Responses on these same sockets follow the progress event in wire order.
    await Promise.all([owner.call('browser.status', {}), agent.call('browser.list', { threadId }), other.call('browser.list', { threadId: second.id }), device.call('threads.list', {})]);
    expect(counts).toEqual({ owner: 1, agent: 1, other: 0, device: 0 });
    await expect(device.call('browser.list', { threadId })).rejects.toThrow('owner only');
  } finally { agent.close(); other.close(); device.close(); }
});

test.each([false, true])('cancellation closes the driver and preserves cleanup errors: %s', async (cleanupFails) => {
  harness = await startTestCore(); const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  const oldKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'test-only-key';
  cleanups.push(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  const binary = spyOn(harness.core.plugins, 'browserBinary').mockReturnValue('fixture'); cleanups.push(() => binary.mockRestore());
  let closed = false;
  const launch = spyOn(BrowserDaemon, 'launch').mockImplementation(async (_core, _id, _binary, _path, signal) => ({
    command: async () => await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }),
    close: async () => { closed = true; if (cleanupFails) throw new Error('cleanup failure'); },
  }) as unknown as BrowserDaemon); cleanups.push(() => launch.mockRestore());
  await owner.call('browser.configure', { enabled: true, executablePath: null });
  const task = await owner.call('browser.start', { threadId, pluginId: 'jev-browser', url: 'https://example.org', goal: 'Open page', completion: { text: 'Example' } });
  await waitFor(() => launch.mock.calls.length === 1);
  await expect(owner.call('plugins.uninstall', { id: 'jev-browser' })).rejects.toThrow('Cancel');
  await expect(owner.call('plugins.install', { id: 'jev-browser' })).rejects.toThrow('Wait');
  const done = await owner.call('browser.cancel', { threadId, id: task.id });
  expect(done.status).toBe(cleanupFails ? 'error' : 'cancelled'); expect(closed).toBe(true); expect(done.finishedAt).not.toBeNull();
});
