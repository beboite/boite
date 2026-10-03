import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore } from './harness.ts';

test('browser screenshots accept explicit destinations, preserve existing files and document default cleanup', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    await owner.call('threads.subscribe', { threadId });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
    const png = readFileSync(join(import.meta.dir, '../../ui/public/icons/icon-192.png'));
    owner.on('browser.requested', request => {
      void owner.call('browser.complete', { requestId: request.requestId, result: { tabId: 'browser:test', screenshot: { mime: 'image/png', base64: png.toString('base64') } } });
    });
    const cwd = join(harness.dataDir, 'screenshots'); mkdirSync(cwd);
    const run = async (args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['browser', ...args, '--json'], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => error += text });
      return { code, out, error };
    };
    const destination = join(harness.dataDir, 'review capture.png');
    const explicit = await run(['screenshot', 'browser:test', '--output', destination]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.out).path).toBe(destination);
    expect(readFileSync(destination)).toEqual(png);
    expect(readdirSync(cwd)).toEqual([]);
    expect((await run(['screenshot', '--output', destination])).code).not.toBe(0);
    expect(readFileSync(destination)).toEqual(png);
    expect((await run(['screenshot', '--output', 'relative.png'])).code).toBe(0);
    expect(readFileSync(join(cwd, 'relative.png'))).toEqual(png);
    const automatic = await run(['screenshot']);
    expect(automatic.code).toBe(0);
    expect(JSON.parse(automatic.out).path).toMatch(/boite-browser-[a-f0-9-]+\.png$/);
    expect((await run(['help'])).out).toContain('caller owns cleanup');
    expect((await run(['screenshot', '--output'])).code).not.toBe(0);
  } finally { owner.close(); await harness.stop(); }
});

test('a recording is saved with the extension of its format and refused when its bytes are another', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    await owner.call('threads.subscribe', { threadId });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
    let mime = 'video/mp4', bytes = mp4;
    const discarded: string[] = [];
    owner.on('browser.requested', request => {
      const action = request.action as { kind: string; recordingId?: string; offset?: number };
      const result = action.kind === 'recording-stop'
        ? { tabId: 'browser:test', recording: { id: `r-${mime.split('/')[1]}`, mime, bytes: bytes.length, durationMs: 1000, reason: 'stopped' } }
        : action.kind === 'recording-read'
          ? { tabId: 'browser:test', value: { base64: bytes.toString('base64'), nextOffset: bytes.length, done: true } }
          : (discarded.push(action.recordingId!), { tabId: 'browser:test' });
      void owner.call('browser.complete', { requestId: request.requestId, result: result as never }).catch(() => {});
    });
    const cwd = join(harness.dataDir, 'recordings'); mkdirSync(cwd);
    const run = async () => {
      let out = '';
      const code = await runCli(['browser', 'recording-stop', '--json'], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => out += text });
      return { code, out };
    };
    const saved = await run();
    expect(saved.out).toContain('boite-browser-');
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.out).path).toMatch(/boite-browser-[a-f0-9-]+\.mp4$/);
    expect(readFileSync(JSON.parse(saved.out).path)).toEqual(mp4);
    mime = 'video/webm'; bytes = webm;
    expect(JSON.parse((await run()).out).path).toMatch(/\.webm$/);
    // Bytes that are not the announced format leave no file behind.
    mime = 'video/mp4';
    expect((await run()).code).not.toBe(0);
    mime = 'video/x-matroska';
    expect((await run()).code).not.toBe(0);
    expect(readdirSync(cwd).map(name => name.split('.').at(-1)).sort()).toEqual(['mp4', 'webm']);
    expect(discarded).toEqual(['r-mp4', 'r-webm']);
  } finally { owner.close(); await harness.stop(); }
});
