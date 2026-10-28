import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, BROWSER_RECORDING_CHUNK_BYTES, type BrowserAction, type BrowserReply } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { browserAction, browserLines } from '../src/browser-cli.ts';
import { parse } from '../src/cli-args.ts';
import { echoThread, startTestCore } from './harness.ts';
import { refused } from '../src/errors.ts';

test('browser screenshots accept explicit destinations, preserve existing files and document default cleanup', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    const png = readFileSync(join(import.meta.dir, '../../ui/public/icons/icon-192.png'));
    // The CLI's own work: what the browser answers is the core's, tested in browser.test.ts.
    spyOn(harness.core.browser, 'command').mockImplementation(async () => ({ tabId: 'browser:test', screenshot: { mime: 'image/png', base64: png.toString('base64') } }));
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
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
    let mime = 'video/mp4', bytes = mp4, reason = 'stopped';
    const discarded: string[] = [], started: unknown[] = [], reads: unknown[] = [];
    spyOn(harness.core.browser, 'command').mockImplementation(async request => {
      const action = request.action as { kind: string; recordingId?: string; offset?: number };
      if (action.kind === 'recording-start') started.push(action);
      if (action.kind === 'recording-read') reads.push(action);
      const result = action.kind === 'recording-start' ? { tabId: 'browser:test' } : action.kind === 'recording-stop'
        ? { tabId: 'browser:test', recording: { id: `r-${mime.split('/')[1]}`, mime, bytes: bytes.length, durationMs: 1000, codec: 'av1', reason } }
        : action.kind === 'recording-read'
          ? { tabId: 'browser:test', value: { base64: bytes.toString('base64'), nextOffset: bytes.length, done: true } }
          : (discarded.push(action.recordingId!), { tabId: 'browser:test' });
      return result as BrowserReply;
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
    // The CLI asks for whole chunks.
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
  // Until a command's text begins: from there every word is that text, a global flag's spelling included.
  const fill = parse(['--json', 'browser', 'fill', '#query', '--json']);
  expect(fill).toMatchObject({ positional: ['browser', 'fill', '#query', '--json'], json: true });
  expect(read(fill.positional.slice(1)).action).toEqual({ kind: 'fill', selector: '#query', text: '--json' });
  expect(parse(['browser', 'fill', '--json', '#query', 'a'])).toMatchObject({ positional: ['browser', 'fill', '#query', 'a'], json: true });
  expect(parse(['browser', 'eval', 'f("--thread")', '--thread', 'x']).positional).toEqual(['browser', 'eval', 'f("--thread")', '--thread', 'x']);
  const run = parse(['browser', 'run', '--tab', 'browser:a', 'batch.js', '--tab', 'browser:b', '--core', 'arg', '--json']);
  expect(run).toMatchObject({ positional: ['browser', 'run', '--tab', 'browser:a', 'batch.js', '--tab', 'browser:b', '--core', 'arg', '--json'], json: false });
  expect(run.core).toBeUndefined();
  expect(parse(['browser', 'run', '--json', 'batch.js'])).toMatchObject({ positional: ['browser', 'run', 'batch.js'], json: true });
  // `-` is the script read from stdin, an operand like a file name.
  const stdin = parse(['browser', 'run', '-', '--core', 'script-argument', '--json']);
  expect(stdin).toMatchObject({ positional: ['browser', 'run', '-', '--core', 'script-argument', '--json'], json: false });
  expect(stdin.core).toBeUndefined();
  // Any other command's text takes a global flag's spelling after `--`.
  expect(parse(['task', 'add', '--json', '--', '--json', '--core'])).toMatchObject({ positional: ['task', 'add', '--json', '--core'], json: true });
  // A command that reads its own flags gets the words after `--`, and Boite takes none of them.
  const owned = parse(['browser', 'run', '--json', '--', 'batch.js', '--core', 'arg']);
  expect(owned).toMatchObject({ positional: ['browser', 'run', 'batch.js', '--core', 'arg'], json: true });
  expect(owned.core).toBeUndefined();
  expect(parse(['browser', 'snapshot', '--', '--json'])).toMatchObject({ positional: ['browser', 'snapshot', '--json'], json: false });
  const logs = parse(['logs', '--', '--core', 'payload']);
  expect([logs.positional, logs.core]).toEqual([['logs', '--core', 'payload'], undefined]);
  // Inside a command's text, `--` is that text.
  expect(parse(['browser', 'fill', '#q', '--', '--json']).positional).toEqual(['browser', 'fill', '#q', '--', '--json']);
  expect(parse(['browser', 'profiles', 'add', '--channel', 'dev']).positional).toEqual(['browser', 'profiles', 'add', '--channel', 'dev']);
  expect(parse(['browser', 'profiles', '--json'])).toMatchObject({ positional: ['browser', 'profiles'], json: true });
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

test('browser run sends a script\'s steps in order in one call, prints what they did and what it returns, and stops at a failed step with the page it left', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    const sent: BrowserAction[] = [], tabs: Array<string | undefined> = [];
    const page = { tabId: 'browser:t', url: 'https://shop.test/', title: 'Shop' };
    // The CLI's own work: the core's answers are tested in browser.test.ts.
    spyOn(harness.core.browser, 'command').mockImplementation(async request => {
      const action = request.action as BrowserAction;
      sent.push(action); tabs.push(request.tabId);
      if (action.kind === 'open') return { ...page, value: { ok: true, navigated: true, url: page.url, title: page.title } };
      if (action.kind === 'snapshot') return { tabId: page.tabId, value: { text: '- button "Go" [ref=e1]\n- textbox "Name" [ref=e2]', refs: 2, url: page.url, title: page.title } };
      if (action.kind === 'click' && action.selector === '@e7') throw refused('ref @e7 is stale because the page changed; take a new snapshot');
      if (action.kind === 'click') return { tabId: page.tabId, value: { ok: true, navigated: true, url: 'https://shop.test/next', title: 'Next' } };
      if (action.kind === 'evaluate') return { tabId: page.tabId, value: 42 };
      if (action.kind === 'status') return { value: { tabs: [{ ...page, active: true }] } };
      return { tabId: page.tabId, value: { ok: true } };
    });
    const cwd = join(harness.dataDir, 'scripts'); mkdirSync(cwd);
    const run = async (args: string[], stdin?: string) => {
      let out = '', error = '';
      const code = await runCli(['browser', 'run', ...args], { cwd, ...(stdin === undefined ? {} : { stdin: async () => stdin }),
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => error += text });
      return { code, out, error };
    };
    writeFileSync(join(cwd, 'flow.js'), [
      "await page.open('https://shop.test/')",
      'const tree = await page.snapshot({ interactive: true })',
      "await page.fill('@e2', args[0])",
      "await page.click(tree.includes('Go') ? '@e1' : '@e9')",
      "console.log('clicked', { at: 1 })",
      'return { sum: await page.eval((a, b) => a + b, 40, 2) }',
    ].join('\n'));
    const done = await run(['flow.js', 'secret-name']);
    expect(done.code).toBe(0);
    expect(sent.map(action => action.kind)).toEqual(['open', 'snapshot', 'fill', 'click', 'evaluate']);
    expect(sent[1]).toEqual({ kind: 'snapshot', interactive: true });
    expect(sent[2]).toEqual({ kind: 'fill', selector: '@e2', text: 'secret-name' });
    expect(sent[4]).toEqual({ kind: 'evaluate', expression: '((a, b) => a + b)(...[40,2])' });
    expect(done.out).toContain('> click @e1\n✓ Next\n  https://shop.test/next\n');
    expect(done.out).toContain('clicked {"at":1}\n');
    expect(done.out).toEndWith('{\n  "sum": 42\n}\n');
    // What was typed stays out of the output: it can be a password.
    expect(done.out).not.toContain('secret-name');

    sent.length = 0;
    const stopped = await run(['-'], "await page.click('@e1')\nawait page.click('@e7')\nawait page.click('@e8')");
    expect(stopped.code).toBe(1);
    expect(sent.map(action => action.kind === 'click' ? action.selector : action.kind)).toEqual(['@e1', '@e7', 'snapshot']);
    expect(stopped.out).toContain('✗ step 2, click @e7: ref @e7 is stale because the page changed; take a new snapshot\npage now: Shop  https://shop.test/\n- button "Go" [ref=e1]');
    expect(stopped.error).toContain('browser run stopped at step 2, click @e7');

    const broken = await run(['-'], "await page.click('@e1')\nnull.go()");
    expect(broken.out).toContain('✗ stdin.js line 2: ');
    expect((await run(['-'], 'await page.click(')).error).toContain('stdin.js does not parse');
    const plain = await run(['-'], "await page.click('@e1')");
    expect(plain.out).toEndWith('✓ 1 step; the page is Shop  https://shop.test/\n');
    let help = '';
    await runCli(['browser', 'help'], { cwd, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) }, out: text => help += text, err: () => {} });
    expect(help).toContain('run <script.js|-> [--tab <id>] [args...]');
    // A tab named before the script or right after it drives every step; later words are the script's.
    for (const args of [['--tab', 'browser:x', '-'], ['-', '--tab', 'browser:x', '--tab']]) {
      tabs.length = 0;
      expect((await run(args, "await page.click('@e1'); return args")).out).toEndWith(`${JSON.stringify(args.slice(3), null, 2)}\n`);
      expect(tabs).toEqual(['browser:x']);
    }
  } finally { owner.close(); await harness.stop(); }
});
