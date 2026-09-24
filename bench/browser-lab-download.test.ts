import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserLabEngine } from './browser-lab-engine.ts';
import { useNativeDownload } from './browser-lab-download.ts';

async function fixture(outcome: 'completed' | 'canceled' | 'missing' | 'pending') {
  const directory = mkdtempSync(join(tmpdir(), 'boite-download-test-'));
  let client: any, policy: any, closed = 0;
  const actions: string[] = [], logs: any[] = [], actionArgs: any[] = [];
  const guid = '12345678-abcd-abcd-abcd-123456789012';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('upgrade required'); },
    websocket: { open(socket) { client = socket; }, message(socket, data) {
      const request = JSON.parse(String(data));
      if (request.method === 'Browser.setDownloadBehavior') policy = request;
      const result = request.method === 'Target.attachToTarget' ? { sessionId: 'session' }
        : request.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame', url: 'https://example.test/release' } } } : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    } },
  });
  const emit = (method: string, params: any) => client.send(JSON.stringify({ method: 'Browser.' + method, params }));
  const engine = {
    kind: 'agent-browser', cdpUrl: `ws://127.0.0.1:${server.port}`, metadata: {},
    activeTargetId: async () => 'target',
    close: async () => { closed++; },
    command: async (action: string, args: any) => {
      actions.push(action);
      actionArgs.push(args);
      if (action === 'click') {
        emit('downloadWillBegin', { guid: 'unrelated', frameId: 'other-frame', url: 'https://example.test/unrelated' });
        emit('downloadProgress', { guid: 'unrelated', state: 'canceled' });
        emit('downloadWillBegin', { guid, frameId: 'frame', url: 'https://example.test/release.zip', suggestedFilename: 'release.zip' });
        if (outcome === 'completed') writeFileSync(join(policy.params.downloadPath, guid), Buffer.from('504b030400000000', 'hex'));
        if (outcome !== 'pending') emit('downloadProgress', { guid, state: outcome === 'canceled' ? 'canceled' : 'completed' });
      }
      return { clicked: true };
    },
  } as unknown as BrowserLabEngine;
  useNativeDownload(engine, entry => logs.push(entry));
  return { engine, directory, logs, actions, actionArgs, policy: () => policy, closed: () => closed, cleanup: async () => {
    await engine.close(); server.stop(true);
    if (!resolve(directory).startsWith(resolve(join(tmpdir(), 'boite-download-test-')))) throw new Error('Unexpected cleanup directory.');
    rmSync(directory, { recursive: true, force: true });
  } };
}

test('native download matches active-frame GUID, ignores unrelated cancellation and saves verified artifact', async () => {
  const f = await fixture('completed');
  try {
    const path = join(f.directory, 'artifact.zip');
    const result = await f.engine.command('download', { selector: '@e12', path });
    expect(readFileSync(path).subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(result.bytes).toBe(8);
    expect(result.sourceUrl).toBe('https://example.test/release.zip');
    expect(result.sourcePageUrl).toBe('https://example.test/release');
    expect(f.policy().sessionId).toBeUndefined();
    expect(f.policy().params.downloadPath.startsWith('\\\\?\\')).toBe(false);
    expect(f.actions).toEqual(['click']);
    expect(f.actionArgs).toEqual([{ selector: '@e12', pinTab: true }]);
    expect(f.logs.at(-1).success).toBe(true);
  } finally { await f.cleanup(); }
});

for (const outcome of ['canceled', 'missing'] as const) test(`native download rejects ${outcome} artifact`, async () => {
  const f = await fixture(outcome);
  try {
    await expect(f.engine.command('download', { selector: '@e12', path: join(f.directory, 'artifact.zip') })).rejects.toThrow(outcome === 'canceled' ? 'canceled' : 'missing');
    expect(existsSync(join(f.directory, 'artifact.zip'))).toBe(false);
    expect(f.logs.at(-1).success).toBe(false);
  } finally { await f.cleanup(); }
});

test('closing engine cancels pending download and still chains owner cleanup', async () => {
  const f = await fixture('pending');
  try {
    const pending = f.engine.command('download', { selector: '@e12', path: join(f.directory, 'artifact.zip') });
    const settled = pending.then(() => null, error => error);
    while (!f.actions.includes('click')) await new Promise(resolve => setTimeout(resolve, 5));
    await expect(f.engine.command('download', { selector: '@e12', path: join(f.directory, 'other.zip') })).rejects.toThrow('already active');
    await f.engine.close();
    expect((await settled)?.message).toContain('closed');
    expect(f.closed()).toBe(1);
  } finally { await f.cleanup(); }
});

test('Playwright engine remains untouched', () => {
  const command = async () => ({}), close = async () => {};
  const engine = { kind: 'playwright', command, close, metadata: {} } as unknown as BrowserLabEngine;
  useNativeDownload(engine, () => {});
  expect(engine.command).toBe(command);
  expect(engine.close).toBe(close);
  expect(engine.metadata).toEqual({});
});
