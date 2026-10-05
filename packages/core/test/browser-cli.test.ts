import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, BROWSER_RECORDING_CHUNK_BYTES } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { browserAction, browserLines } from '../src/browser-cli.ts';
import { parse } from '../src/cli-args.ts';
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

test('a recording starts with the requested rate and codec, is saved with the extension of its format, says why it ended and is refused when its bytes are another', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    await owner.call('threads.subscribe', { threadId });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
    let mime = 'video/mp4', bytes = mp4, reason = 'stopped';
    const discarded: string[] = [], started: unknown[] = [], reads: unknown[] = [];
    owner.on('browser.requested', request => {
      const action = request.action as { kind: string; recordingId?: string; offset?: number };
      if (action.kind === 'recording-start') started.push(action);
      if (action.kind === 'recording-read') reads.push(action);
      const result = action.kind === 'recording-start' ? { tabId: 'browser:test' } : action.kind === 'recording-stop'
        ? { tabId: 'browser:test', recording: { id: `r-${mime.split('/')[1]}`, mime, bytes: bytes.length, durationMs: 1000, codec: 'av1', reason } }
        : action.kind === 'recording-read'
          ? { tabId: 'browser:test', value: { base64: bytes.toString('base64'), nextOffset: bytes.length, done: true } }
          : (discarded.push(action.recordingId!), { tabId: 'browser:test' });
      void owner.call('browser.complete', { requestId: request.requestId, result: result as never }).catch(() => {});
    });
    const cwd = join(harness.dataDir, 'recordings'); mkdirSync(cwd);
    const run = async (args = ['recording-stop']) => {
      let out = '';
      const code = await runCli(['browser', ...args, '--json'], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => out += text });
      return { code, out };
    };
    expect((await run(['recording-start', '--fps', '60', '--codec', 'AV1', 'browser:test'])).code).toBe(0);
    expect((await run(['recording-start'])).code).toBe(0);
    // A rate or codec no desktop records never reaches it.
    expect((await run(['recording-start', '--fps', '25'])).out).toContain('frameRate must be 30 or 60');
    expect((await run(['recording-start', '--codec', 'vp9'])).out).toContain('codec must be h264, hevc, av1');
    expect((await run(['recording-start', '--codec'])).code).not.toBe(0);
    expect(started).toEqual([{ kind: 'recording-start', frameRate: 60, codec: 'av1' }, { kind: 'recording-start' }]);
    const saved = await run();
    expect(saved.out).toContain('boite-browser-');
    expect(JSON.parse(saved.out).codec).toBe('av1');
    expect(JSON.parse(saved.out).note).toBeUndefined();
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.out).path).toMatch(/boite-browser-[a-f0-9-]+\.mp4$/);
    expect(readFileSync(JSON.parse(saved.out).path)).toEqual(mp4);
    // This core asks for whole chunks; the desktop sends older cores the 512 KiB they accept.
    expect(reads[0]).toMatchObject({ offset: 0, maxBytes: BROWSER_RECORDING_CHUNK_BYTES });
    // A recording that hit the size cap is saved, with the reason spelled out.
    mime = 'video/webm'; bytes = webm; reason = 'size';
    const capped = JSON.parse((await run()).out);
    expect(capped.path).toMatch(/\.webm$/);
    expect(capped.note).toContain('100 MB size limit');
    reason = 'stopped';
    // Bytes that are not the announced format leave no file behind.
    mime = 'video/mp4';
    expect((await run()).code).not.toBe(0);
    mime = 'video/x-matroska';
    expect((await run()).code).not.toBe(0);
    expect(readdirSync(cwd).map(name => name.split('.').at(-1)).sort()).toEqual(['mp4', 'webm']);
    expect(discarded).toEqual(['r-mp4', 'r-webm']);
  } finally { owner.close(); await harness.stop(); }
});

test('the browser CLI reads agent-browser command lines into actions', () => {
  const read = (line: string[]) => browserAction(line);
  expect(read(['open', 'https://example.com'])).toEqual({ action: { kind: 'open', url: 'https://example.com', reuse: true } });
  // A named profile is a tab of its own, as before.
  expect(read(['open', 'https://example.com', '--profile', 'private']).action).toEqual({ kind: 'open', url: 'https://example.com', reuse: true, profile: 'private' });
  expect(read(['tab', 'new', 'https://example.com']).action).toEqual({ kind: 'open', url: 'https://example.com' });
  expect(read(['tab', 'browser:abc'])).toEqual({ action: { kind: 'activate' }, tabId: 'browser:abc' });
  expect(read(['snapshot', '-i', '-c', '-d', '3', '-s', '#main', '-u']).action).toEqual({ kind: 'snapshot', interactive: true, compact: true, urls: true, depth: 3, selector: '#main' });
  expect(read(['dblclick', '@e2']).action).toEqual({ kind: 'click', selector: '@e2', count: 2 });
  // Unquoted words after the target are the text, as a shell splits them.
  expect(read(['fill', '@e3', 'Ada', 'Lovelace']).action).toEqual({ kind: 'fill', selector: '@e3', text: 'Ada Lovelace' });
  expect(read(['select', '@e4', 'a', 'b']).action).toEqual({ kind: 'select', selector: '@e4', values: ['a', 'b'] });
  expect(read(['press', 'Control+a']).action).toEqual({ kind: 'press', key: 'Control+a' });
  expect(read(['scroll', 'down', '500']).action).toEqual({ kind: 'scroll', x: 0, y: 500 });
  expect(read(['scroll', '0', '-200']).action).toEqual({ kind: 'scroll', x: 0, y: -200 });
  expect(read(['wait', '1500']).action).toEqual({ kind: 'wait', ms: 1500 });
  expect(read(['wait', '--text', 'Saved', '--timeout', '4000']).action).toEqual({ kind: 'wait', text: 'Saved', timeoutMs: 4000 });
  expect(read(['wait', '@e9']).action).toEqual({ kind: 'wait', selector: '@e9' });
  expect(read(['get', 'attr', '@e1', 'href']).action).toEqual({ kind: 'get', what: 'attr', selector: '@e1', name: 'href' });
  expect(read(['is', 'checked', '@e5']).action).toEqual({ kind: 'get', what: 'checked', selector: '@e5' });
  expect(read(['eval', 'document.title']).action).toEqual({ kind: 'evaluate', expression: 'document.title' });
  expect(read(['dialog', 'accept', 'hello']).action).toEqual({ kind: 'dialog', decision: 'accept', text: 'hello' });
  expect(read(['set', 'viewport', '390', '844']).action).toEqual({ kind: 'resize', width: 390, height: 844 });
  expect(read(['set', 'media', 'dark']).action).toEqual({ kind: 'appearance', colorScheme: 'dark' });
  expect(read(['back']).action).toEqual({ kind: 'history', direction: 'back' });
  // The tab id that used to follow the arguments still selects the tab.
  expect(read(['click', '#go', 'browser:abc'])).toEqual({ action: { kind: 'click', selector: '#go' }, tabId: 'browser:abc' });
  expect(read(['screenshot', 'browser:abc', '--output', 'a.png'])).toEqual({ action: { kind: 'screenshot' }, tabId: 'browser:abc', output: 'a.png' });
  expect(read(['screenshot', 'page.png']).output).toBe('page.png');
  expect(() => read(['press', 'Hyper+q'])).toThrow('unsupported browser key');
  expect(() => read(['wait', '--text', 'a', '--url', 'b'])).toThrow('exactly one condition');
  expect(() => read(['click'])).toThrow('needs a target');
  expect(() => read(['frobnicate'])).toThrow('unknown browser command');
  // Boite's own connection flags stay global after the browser command.
  expect(parse(['browser', 'snapshot', '-i', '--core', 'https://host.test', '--channel', 'dev'])).toMatchObject({ positional: ['browser', 'snapshot', '-i'], core: 'https://host.test', channel: 'dev' });
});

test('browser output is agent-browser text: a check, the page reached and the dialogs answered', () => {
  const lines = (action: Parameters<typeof browserLines>[0], value: unknown, extra = {}) => browserLines(action, { tabId: 'browser:t', value, ...extra });
  expect(lines({ kind: 'snapshot' }, { text: '- button "Go" [ref=e1]', refs: 1 })).toEqual(['- button "Go" [ref=e1]']);
  expect(lines({ kind: 'click', selector: '@e1' }, { ok: true })).toEqual(['✓ Done']);
  expect(lines({ kind: 'click', selector: '@e1' }, { ok: true, navigated: true, url: 'https://x.test/done', title: 'Done page', dialogs: [{ type: 'confirm', message: 'Sure?', accepted: true }] }))
    .toEqual(['✓ Done page', '  https://x.test/done', '  confirm "Sure?" accepted']);
  expect(lines({ kind: 'open', url: 'https://x.test', reuse: true }, { ok: true, navigated: true, url: 'https://x.test/', title: 'X', loading: true })[2]).toContain('still loading');
  expect(lines({ kind: 'select', selector: '@e2', values: ['2'] }, { ok: true, value: ['Two'] })).toEqual(['✓ Selected Two']);
  expect(lines({ kind: 'get', what: 'text', selector: '@e1' }, 'plain words')).toEqual(['plain words']);
  expect(lines({ kind: 'get', what: 'checked', selector: '@e1' }, false)).toEqual(['false']);
  expect(lines({ kind: 'status' }, { tabs: [{ tabId: 'browser:t', url: 'https://x.test/', title: 'X', profileName: 'Privé', active: true }] })).toEqual(['* browser:t  X  https://x.test/  [Privé]']);
});
