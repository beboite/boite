import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, VIEW_CONTENT_POLICY, VIEW_HELP, VIEW_GUIDE_LINE, viewDocument, viewFrameHeight, viewTitleOf, readViewMessage, type MessagePart } from '@boite/contracts';
import { agentGuide } from '../src/agent-guide.ts';
import { findChromium } from '../src/browser/chromium.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import { buildView, viewAdvice } from '../src/views.ts';
import { VIEW_EXAMPLE } from '../src/view-example.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

/** The checks that load a page need a Chromium-based browser; the rest runs with none, as a machine without one would. */
const browser = findChromium().path;
const real = browser ? test : test.skip;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let harness: TestCore;
let client: CoreClient;
let agent: CoreClient;
let threadId: string;
let savedBrowser: string | undefined;

async function start(withBrowser: boolean): Promise<void> {
  savedBrowser = process.env.BOITE_BROWSER;
  if (withBrowser) delete process.env.BOITE_BROWSER; else process.env.BOITE_BROWSER = join(import.meta.dir, 'no-such-browser');
  harness = await startTestCore(); client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
  await client.call('turns.start', { threadId, prompt: 'Explain it with a drawing' });
  await waitFor(() => harness.core.threads.require(threadId).status === 'idle');
}
beforeEach(() => start(false));
afterEach(async () => {
  agent?.close(); await harness?.stop();
  if (savedBrowser === undefined) delete process.env.BOITE_BROWSER; else process.env.BOITE_BROWSER = savedBrowser;
});

const page = (body: string, head = '') => `<!doctype html>\n<html>\n<head>${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
const write = (path: string, text: string | Buffer) => { mkdirSync(join(harness.dataDir, path, '..'), { recursive: true }); writeFileSync(join(harness.dataDir, path), text); };
const viewOf = (parts: MessagePart[]) => parts[0]?.type === 'artifact' ? parts[0] : null;

async function cli(...args: string[]): Promise<{ code: number; output: string; error: string }> {
  let output = '', error = '';
  const code = await runCli(args, {
    cwd: harness.dataDir, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
    out: text => output += text, err: text => error += text,
  });
  return { code, output, error };
}

test('the session guide names the command and what calls for it, and view help carries the rules', async () => {
  expect(agentGuide(true)).toContain(VIEW_GUIDE_LINE);
  expect(VIEW_GUIDE_LINE).toMatch(/when asked for a visual or a schema/);
  // One line of the session prompt, which every turn of every thread pays for.
  expect(VIEW_GUIDE_LINE.length).toBeLessThan(240);
  const help = await cli('view', 'help');
  expect(help.code).toBe(0);
  expect(help.output).toContain(VIEW_HELP);
  for (const told of ['--color-foreground', '--series-1', 'Nothing remote loads', 'one file each', 'data-reduced-motion', 'do not announce it']) expect(VIEW_HELP).toContain(told);
  // The app's look is explained, the kit is listed, and a full page is one command away.
  for (const told of ['The look', 'One accent', 'input[type=range]', '.segmented', '.stat', '.series-1', 'Never write a fixed color', 'boite view example', 'advice']) expect(VIEW_HELP).toContain(told);
  const example = await cli('view', 'example');
  expect(example.code).toBe(0);
  expect(example.output).toContain(VIEW_EXAMPLE);
});

test('advice names what will not look like the app, and the example needs none', () => {
  expect(viewAdvice(VIEW_EXAMPLE)).toEqual([]);
  // The example is the kit used as intended: no color and no font of its own.
  for (const used of ['class="controls"', 'class="field"', 'class="segmented"', 'class="stat"', 'class="stroke accent soft"', 'data-reduced-motion']) expect(VIEW_EXAMPLE).toContain(used);
  expect(viewAdvice(page('<p style="color: var(--color-accent); font: 600 12px var(--font-mono)">fine</p><a href="#fab">in page</a><use href="#add"/><rect style="fill:url(#bad)"/>&#123;', '<style>#stage { color: currentColor } .a { font-family: var(--font-sans) }</style>'))).toEqual([]);
  const advice = viewAdvice(page('<rect fill="red"/><p style="background: rgb(10, 20, 30)">x</p><img src="data:image/png;base64,AAAA#fff">', '<style>.a { color: #FF0000; border-color: #abc } .b { font-family: Arial, sans-serif }</style>'));
  expect(advice).toHaveLength(2);
  expect(advice[0]).toMatch(/^4 fixed colors \(#ff0000, #abc, rgb\(10,20,30\), red\) will not follow the user's theme/);
  expect(advice[1]).toMatch(/^a font of its own \(Arial, sans-serif\)/);
  const many = viewAdvice('<style>a{color:#111}b{color:#222}c{color:#333}d{color:#444}e{color:#555}</style>');
  expect(many[0]).toMatch(/^5 fixed colors \(#111, #222, #333, #444, and more\)/);
});

test('the stored page starts its head with the policy, the theme and the bootstrap, on the line the head opens on', () => {
  const stored = viewDocument(page('<svg viewBox="0 0 10 10"></svg>', '<title>Orbit</title>'));
  const head = stored.split('\n')[2]!;
  expect(head.startsWith(`<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CONTENT_POLICY}">`)).toBe(true);
  expect(head).toContain('<style id="boite-view-theme">');
  // The kit is in the page once, apart from the theme the bootstrap rewrites.
  expect(head).toContain('<style id="boite-view-kit">');
  expect(stored.split(':where(.card)').length).toBe(2);
  expect(stored).toContain('input[type=range]');
  expect(head.indexOf('<script>')).toBeLessThan(head.indexOf('<title>Orbit</title>'));
  // Nothing the page wrote moved to another line: a script error still names the agent's own line.
  expect(stored.split('\n').length).toBe(page('').split('\n').length);
  expect(viewDocument('<svg></svg>').startsWith('<!doctype html><head>')).toBe(true);
  // A page written without a doctype is given one, on its first line.
  expect(viewDocument('<html><head></head>\n<body></body></html>')).toMatch(/^<!doctype html><html><head><meta charset="utf-8">.*\n<body><\/body><\/html>$/s);
  expect(viewDocument('<html>\n<body></body></html>').startsWith('<!doctype html><html><head><meta')).toBe(true);
  expect(viewDocument('<!-- <head> --><script>var s = "<head>";</script><p>x</p>')).toMatch(/^<!doctype html><head>.*<\/head><!-- <head> -->/s);
  expect(viewTitleOf('<script>var t = "<title>no</title>";</script><title> Orbit \n of the Moon </title>')).toBe('Orbit of the Moon');
  expect(viewTitleOf('<p>none</p>')).toBeNull();
});

test('a frame takes the page\'s own height, else the measure for its width, inside the bounds', () => {
  const view = { title: 'Orbit', height: 420, narrowHeight: 610 };
  expect(viewFrameHeight(view, 780)).toBe(420);
  expect(viewFrameHeight(view, 360)).toBe(610);
  expect(viewFrameHeight({ title: 'Orbit', height: 420 }, 360)).toBe(420);
  expect(viewFrameHeight(view, 780, 433.2)).toBe(433);
  expect(viewFrameHeight(view, 780, 90_000)).toBe(2400);
  expect(readViewMessage({ boiteView: 1, type: 'size', height: 300 })).toEqual({ type: 'size', height: 300 });
  expect(readViewMessage({ boiteView: 1, type: 'link', url: 'https://example.com/a' })).toEqual({ type: 'link', url: 'https://example.com/a' });
  for (const bad of [null, { type: 'size', height: 300 }, { boiteView: 1, type: 'size', height: -4 }, { boiteView: 1, type: 'link', url: 'javascript:alert(1)' }]) expect(readViewMessage(bad)).toBeNull();
});

test('local files are embedded, and a remote address or a missing file is a problem with its line', () => {
  write('views/dot.png', PNG);
  write('views/lib.js', 'window.lib = "</script>";');
  write('views/look.css', '.stage { height: 200px }');
  // A stylesheet in another folder names its own files from there.
  write('views/theme/skin.css', '.skin { background: url(tile.png) } .mark { background: url("#mark") }');
  write('views/theme/tile.png', PNG);
  const built = buildView(page([
    '<img src="dot.png" alt="">',
    '<div style="background: url(dot.png)"></div>',
    '<script src="lib.js"></script>',
    '<a href="https://example.com/docs">docs</a>',
    '<script>var tag = "<img src=\\"https://example.com/in-a-string.png\\">";</script>',
  ].join('\n'), '<link rel="stylesheet" href="look.css"><link rel="stylesheet" href="theme/skin.css">'), join(harness.dataDir, 'views'), harness.dataDir);
  expect(built.problems).toEqual([]);
  const data = `data:image/png;base64,${PNG.toString('base64')}`;
  expect(built.html).toContain(`<img src="${data}" alt="">`);
  expect(built.html).toContain(`url("${data}")`);
  expect(built.html).toContain('<script>window.lib = "<\\/script>";</script>');
  expect(built.html).toContain('<style>.stage { height: 200px }</style>');
  expect(built.html).toContain(`<style>.skin { background: url("data:image/png;base64,${PNG.toString('base64')}") } .mark { background: url("#mark") }</style>`);
  expect(built.html).toContain('<a href="https://example.com/docs">');
  expect(built.html).toContain('in-a-string.png');

  write('views/theme/broken.css', '@import "more.css"; .a { background: url(gone.png) } .b { background: url(https://example.com/b.png) }');
  const refused = buildView(page([
    '<script src="https://cdn.example.com/chart.js"></script>',
    '<img src="missing.png">',
    '<img src="../../outside.png">',
    '<style>@import url("https://fonts.example.com/inter.css"); .a { background: url(//example.com/a.png) }</style>',
    '<iframe src="other.html"></iframe>',
    '<img src="notes.txt">',
    '<link rel="stylesheet" href="theme/broken.css">',
  ].join('\n')), join(harness.dataDir, 'views'), harness.dataDir).problems;
  expect(refused.find(line => line.includes('chart.js'))).toMatch(/^line 5: https:\/\/cdn\.example\.com\/chart\.js is remote/);
  expect(refused.find(line => line.includes('missing.png'))).toMatch(/^line 6: missing\.png: .*does not exist/);
  expect(refused.find(line => line.includes('outside.png'))).toMatch(/leaves/);
  expect(refused.some(line => /@import of https:\/\/fonts\.example\.com\/inter\.css is remote/.test(line))).toBe(true);
  expect(refused.some(line => /url\(\/\/example\.com\/a\.png\) is remote/.test(line))).toBe(true);
  expect(refused.some(line => /<iframe> cannot load other\.html/.test(line))).toBe(true);
  expect(refused.some(line => /notes\.txt is not a file a view can embed/.test(line))).toBe(true);
  expect(refused.some(line => /^line 11: the stylesheet uses @import/.test(line))).toBe(true);
  expect(refused.some(line => /^line 11: gone\.png: .*does not exist/.test(line))).toBe(true);
  expect(refused.some(line => /^line 11: url\(https:\/\/example\.com\/b\.png\) in the stylesheet is remote/.test(line))).toBe(true);
});

test('boite view publishes a page as an artifact that opens only on the view route, under its sandbox', async () => {
  await client.call('threads.subscribe', { threadId });
  write('.boite/views/orbit.html', page('<svg viewBox="0 0 100 40"><circle cx="20" cy="20" r="8" fill="currentColor"/></svg>', '<title>Orbit of the Moon</title>'));
  const sent = await cli('view', '.boite/views/orbit.html', '--json');
  expect(sent.error).toBe(''); expect(sent.code).toBe(0);
  const result = JSON.parse(sent.output) as { message: { id: string; turnId: string; parts: MessagePart[] }; checked: boolean; advice: string[] };
  expect(result.checked).toBe(false);
  expect(result.advice).toEqual([]);
  const part = viewOf(result.message.parts)!;
  expect(part).toMatchObject({ type: 'artifact', name: 'orbit.html', mimeType: 'text/html', view: { title: 'Orbit of the Moon', height: 320, source: '.boite/views/orbit.html' } });
  const stored = readFileSync(join(harness.dataDir, 'artifacts', part.id), 'utf8');
  expect(stored).toContain('boite-view-theme');
  expect(stored).toContain('<circle cx="20"');
  expect(readdirSync(join(harness.dataDir, 'artifacts')).filter(name => name.endsWith('.partial'))).toEqual([]);
  const history = await client.call('threads.get', { threadId });
  expect(history.messages.find(message => message.id === result.message.id)?.parts).toEqual(result.message.parts);

  const ids = { threadId, messageId: result.message.id, artifactId: part.id };
  const shown = await client.call('artifacts.read', { ...ids, view: true });
  expect(shown.url).toMatch(/^\/view\/[\w-]+$/);
  const response = await fetch(new URL(shown.url, harness.url));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${VIEW_CONTENT_POLICY}`);
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(await response.text()).toBe(stored);
  expect((await fetch(new URL(shown.url, harness.url), { method: 'POST' })).status).toBe(405);

  // The download address of the same snapshot never opens as a page, and a file ticket is nothing on the view route.
  const download = await client.call('artifacts.read', ids);
  expect(download.url).toMatch(/^\/file\//);
  expect((await fetch(new URL(download.url, harness.url))).headers.get('content-disposition')).toContain('attachment');
  expect((await fetch(new URL(download.url.replace('/file/', '/view/'), harness.url))).status).toBe(404);

  writeFileSync(join(harness.dataDir, 'report.txt'), 'x'.repeat(6 * 1024 * 1024));
  const file = await agent.call('artifacts.publish', { threadId, path: 'report.txt' });
  const plain = viewOf(file.parts)!;
  await expect(client.call('artifacts.read', { threadId, messageId: file.id, artifactId: plain.id, view: true })).rejects.toThrow('published with boite view');
});

test('a page that is not ready is refused with what to fix, and nothing is stored or shown', async () => {
  write('broken.html', page('<script src="https://cdn.example.com/chart.js"></script>\n<img src="nowhere.png">'));
  const sent = await cli('view', 'broken.html');
  expect(sent.code).not.toBe(0);
  expect(sent.error).toContain('not ready to show');
  expect(sent.error).toContain('line 5: https://cdn.example.com/chart.js is remote');
  expect(sent.error).toContain('line 6: nowhere.png');
  expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
  const history = await client.call('threads.get', { threadId });
  expect(history.messages.some(message => message.parts.some(part => part.type === 'artifact'))).toBe(false);

  write('notes.md', '# no');
  write('empty.html', '  \n');
  await expect(agent.call('artifacts.view', { threadId, path: 'notes.md' })).rejects.toThrow('must be an HTML file');
  await expect(agent.call('artifacts.view', { threadId, path: 'empty.html' })).rejects.toThrow('page is empty');
  await expect(agent.call('artifacts.view', { threadId, path: '../outside.html' })).rejects.toThrow('leaves');
  const other = await echoThread(harness, client, 'another thread');
  await expect(agent.call('artifacts.view', { threadId: other.threadId, path: 'broken.html' })).rejects.toThrow('is for thread');
  await client.call('threads.archive', { threadId });
  await expect(client.call('artifacts.view', { threadId, path: 'empty.html' })).rejects.toThrow('active thread');
});

real('a page is loaded in a headless browser before it is shown: its height is measured, its errors refuse it', async () => {
  await restartWithBrowser();
  write('views/bars.html', page('<div style="height:260px">bars</div>\n<div style="width:300px;height:40px;display:inline-block"></div><div style="width:300px;height:40px;display:inline-block"></div>'));
  const good = await agent.call('artifacts.view', { threadId, path: 'views/bars.html', title: '  Bars   by month ' });
  expect(good.checked).toBe(true);
  const view = viewOf(good.message.parts)!.view!;
  expect(view.title).toBe('Bars by month');
  expect(view.height).toBeGreaterThanOrEqual(300);
  expect(view.height).toBeLessThan(330);
  // At a phone's width the two blocks no longer sit side by side.
  expect(view.narrowHeight!).toBeGreaterThan(view.height);

  // The example an agent starts from loads cleanly and asks for no advice; a page with colors of its own is shown, and told.
  write('views/pendulum.html', VIEW_EXAMPLE);
  const example = await agent.call('artifacts.view', { threadId, path: 'views/pendulum.html' });
  expect(example).toMatchObject({ checked: true, advice: [] });
  expect(viewOf(example.message.parts)!.view!.height).toBeGreaterThan(300);
  write('views/loud.html', page('<p style="color:#ff0000">loud</p>'));
  const loud = await cli('view', 'views/loud.html');
  expect(loud.code).toBe(0);
  expect(loud.output).toContain("advice: 1 fixed color (#ff0000) will not follow the user's theme");

  // Without a doctype a root is as tall as the window it is loaded in: the stored page has one, so its own height is what is measured.
  write('views/bare.html', '<html><head></head><body><div style="height:120px"></div></body></html>');
  const bare = viewOf((await agent.call('artifacts.view', { threadId, path: 'views/bare.html' })).message.parts)!.view!;
  expect(bare.height).toBeGreaterThanOrEqual(120);
  expect(bare.height).toBeLessThan(200);

  write('views/throws.html', page('<p>before</p>\n<script>\n  const stage = document.querySelector("#stage");\n  stage.getContext("2d");\n</script>'));
  const thrown = await agent.call('artifacts.view', { threadId, path: 'views/throws.html' }).then(() => null, (error: Error) => error.message);
  expect(thrown).toContain('not ready to show');
  expect(thrown).toMatch(/TypeError: Cannot read properties of null/);
  // The line is the one of the agent's own file, not of the stored copy.
  expect(thrown).toMatch(/:8:\d+|line 8/);

  write('views/calls.html', page('<script>fetch("https://example.com/data.json").catch(() => {});</script>'));
  const called = await agent.call('artifacts.view', { threadId, path: 'views/calls.html' }).then(() => null, (error: Error) => error.message);
  expect(called).toMatch(/Content Security Policy/i);
  // The route's sandbox puts the page on an opaque origin: the core's own storage is out of its reach.
  write('views/stores.html', page('<script>localStorage.setItem("seen", "1");</script>'));
  const stored = await agent.call('artifacts.view', { threadId, path: 'views/stores.html' }).then(() => null, (error: Error) => error.message);
  expect(stored).toMatch(/SecurityError/);
  expect(readdirSync(join(harness.dataDir, 'artifacts')).length).toBe(4);
}, 90_000);

/** The gated test runs with the machine's browser: the core started without one is replaced. */
async function restartWithBrowser(): Promise<void> {
  agent.close(); await harness.stop();
  if (savedBrowser === undefined) delete process.env.BOITE_BROWSER; else process.env.BOITE_BROWSER = savedBrowser;
  await start(true);
}
