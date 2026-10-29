import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_ENV, VIEW_BLOCK_MAX_BYTES, VIEW_CONTENT_POLICY, VIEW_HELP, VIEW_GUIDE_LINE, viewDocument, viewFrameHeight, viewTitleOf, readViewMessage, type MessagePart } from '@boite/contracts';
import { agentGuide, CHAT_VISUALS } from '../src/agent-guide.ts';
import { findChromium } from '../src/browser/chromium.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import { buildView, viewAdvice } from '../src/views.ts';
import { VIEW_EXAMPLE } from '../src/view-example.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

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
  // Every check starts a browser of its own, and a loaded Windows runner took past the 20-second limit to start one:
  // the page then goes out unchecked and a refusal this file expects never comes (2026-10-13, twice). These tests
  // are about what a check finds, so they give it a minute; the product keeps its limit.
  const probe = harness.core.browser.probe.bind(harness.core.browser);
  harness.core.browser.probe = (url, widths) => probe(url, widths, 60_000);
  const checkView = harness.core.browser.checkView.bind(harness.core.browser);
  harness.core.browser.checkView = (url, options) => checkView(url, options, 60_000);
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

test('the session guide sends a visual to the chat\'s own Mermaid, TeX and view blocks first, and view help carries the page rules', async () => {
  const guide = agentGuide(true);
  // A diagram, a chart, a formula or a small page needs no command and no help to read: the guide names the blocks chat draws.
  expect(guide).toContain(CHAT_VISUALS);
  for (const header of ['```mermaid', 'flowchart', 'sequenceDiagram', 'xychart-beta with "quoted" labels', 'pie', 'gantt', 'timeline', 'quadrantChart', 'sankey-beta', 'mindmap', '`$$`', 'never single `$`', '```view fence of HTML, SVG, CSS and script', 'interactive or animated', 'no fixed color']) expect(CHAT_VISUALS).toContain(header);
  expect(CHAT_VISUALS).toMatch(/when asked for a visual or when a picture explains better than text/);
  // Then the page a block does not suit: its help is read before a page, not before every visual.
  expect(guide.indexOf(CHAT_VISUALS)).toBeLessThan(guide.indexOf(VIEW_GUIDE_LINE));
  expect(VIEW_GUIDE_LINE).toMatch(/^A larger page, or one kept as a file, needs `boite view/);
  // The logs hint stands without a skill (one that could not be written), and only while agents may read logs.
  expect(agentGuide(true, true, [])).toContain('`boite logs problems`');
  expect(agentGuide(true, false, [])).not.toContain('boite logs');
  // The diagnostic skill is offered only beside its logs; the others stand on their own.
  const skills = [{ name: 'boite-report-issue', description: 'd1', path: '/r' }, { name: 'boite-prove-it', description: 'd2', path: '/p' }];
  expect(agentGuide(true, false, skills)).not.toContain('boite-report-issue');
  expect(agentGuide(true, false, skills)).toContain('boite-prove-it: d2\nFile: /p');
  expect(agentGuide(true, true, skills)).toContain('; skill boite-report-issue: /r');
  // Two lines of the session prompt, which every turn of every thread pays for: 419 before the ```view fence, whose 130
  // spare a small page its command and its help (549 measured 2026-10-26).
  expect(CHAT_VISUALS.length + VIEW_GUIDE_LINE.length).toBeLessThan(550);
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
  // Every rule of the kit weighs nothing, and none overrides what a drawing says in its own attributes.
  const kit = /<style id="boite-view-kit">([\s\S]*?)<\/style>/.exec(stored)![1]!;
  expect(kit).toContain(':where(svg text:not([fill]))');
  for (const rule of kit.split('}').map(part => part.split('{')[0]!.trim()).filter(selector => selector && !selector.startsWith('@') && !selector.startsWith('html'))) expect(rule).toMatch(/^:where\(/);
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
    // A `url(` in script text or prose is no address: it stays as written, and the script still parses.
    '<script>const css = "url(dot.png)";</script>',
    '<p>Write url(dot.png) or url(gone.png) in a rule.</p>',
    '<svg><rect style=\'fill: url(dot.png)\'/></svg>',
    // A quoted `>` does not end its tag, and an address quoted in another attribute is that attribute's text.
    '<div title="a > b" style="background: url(dot.png)"></div>',
    '<img alt="x > y src=gone.png" src="dot.png">',
    // Prose and a textarea's text are no rules, nor tags: nothing in them is loaded or refused.
    '<p>Write @import url("theme.css") in a stylesheet.</p>',
    '<textarea><style>.x { background: url(gone.png) }</style><img src="gone.png"></textarea>',
    // Only a CSS attribute holds CSS: a tooltip, a data value or a handler keeps its text.
    '<div title="url(gone.png)" data-css="@import \'x.css\'">tip</div>',
    '<button onclick="alert(\'url(dot.png)\')">show</button>',
    '<svg><rect fill="url(dot.png)"/></svg>',
    // A tag spelled inside a quoted value starts nothing, and a custom element named like a text one is markup.
    '<div title="<textarea>" data-a="<style>" data-b="<img src=gone.png>"></div><p>url(gone.png) after</p>',
    '<title-card><img src="dot.png" alt="card"></title-card>',
    // A style body is CSS, not tags: a script, textarea or title spelled in its strings hides nothing after it.
    '<style>.icon::after { content: "<script>" } .note::before { content: "<textarea><title>" } .icon { background: url(dot.png) }</style><img src="dot.png" alt="after-style">',
  ].join('\n'), '<link rel="stylesheet" href="look.css"><link rel="stylesheet" href="theme/skin.css">'), join(harness.dataDir, 'views'), harness.dataDir);
  expect(built.problems).toEqual([]);
  const data = `data:image/png;base64,${PNG.toString('base64')}`;
  expect(built.html).toContain(`<img src="${data}" alt="">`);
  expect(built.html).toContain(`<div style="background: url(${data})"></div>`);
  expect(built.html).toContain(`<rect style='fill: url(${data})'/>`);
  expect(built.html).toContain(`<div title="a > b" style="background: url(${data})"></div>`);
  expect(built.html).toContain(`<img alt="x > y src=gone.png" src="${data}">`);
  expect(built.html).toContain('<textarea><style>.x { background: url(gone.png) }</style><img src="gone.png"></textarea>');
  expect(built.html).toContain('<div title="url(gone.png)" data-css="@import \'x.css\'">tip</div>');
  expect(built.html).toContain('<button onclick="alert(\'url(dot.png)\')">show</button>');
  expect(built.html).toContain(`<rect fill="url(${data})"/>`);
  expect(built.html).toContain('<div title="<textarea>" data-a="<style>" data-b="<img src=gone.png>"></div><p>url(gone.png) after</p>');
  expect(built.html).toContain(`<title-card><img src="${data}" alt="card"></title-card>`);
  expect(built.html).toContain(`.icon { background: url(${data}) }</style><img src="${data}" alt="after-style">`);
  const script = /<script>(const css[^<]*)<\/script>/.exec(built.html)![1]!;
  expect(script).toBe('const css = "url(dot.png)";');
  expect(() => new Function(script)).not.toThrow();
  expect(built.html).toContain('<p>Write url(dot.png) or url(gone.png) in a rule.</p>');
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

test('a page of many small style blocks is read in one pass', () => {
  // 32,000 blocks, 864 KB: one pass takes tens of milliseconds, a copy of the page per block takes seconds.
  const started = performance.now();
  const built = buildView('<style>a{color:red}</style>'.repeat(32_000), join(harness.dataDir, 'views'), harness.dataDir);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(built.problems).toEqual([]);
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
  // The output hands the agent the line that places the page in its answer, a path with spaces in angle brackets.
  write('views/two words.html', page('<p>quiet</p>', '<title>Two [words]</title>'));
  expect((await cli('view', 'views/two words.html')).output).toContain('place: ![Two words](<views/two words.html>) alone on a line of your answer');
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

  // The snapshot was gzipped once at publication: a client reading gzip gets that copy, under the same policy.
  const view = async (encoding: string) => {
    const { url } = await client.call('artifacts.read', { threadId, messageId: result.message.id, artifactId: part.id, view: true });
    return fetch(new URL(url, harness.url), { headers: { 'accept-encoding': encoding }, decompress: false });
  };
  const compressed = await view('gzip, deflate, br');
  expect(compressed.headers.get('content-encoding')).toBe('gzip');
  expect(compressed.headers.get('vary')).toBe('accept-encoding');
  expect(compressed.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${VIEW_CONTENT_POLICY}`);
  expect(compressed.headers.get('cache-control')).toBe('no-store');
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer())))).toBe(stored);
  const identity = await view('identity');
  expect(identity.headers.get('content-encoding')).toBeNull();
  expect(await identity.text()).toBe(stored);
  // A view published before the copy existed is sent as it is.
  rmSync(join(harness.dataDir, 'artifacts', `${part.id}.gz`));
  const older = await view('gzip');
  expect(older.headers.get('content-encoding')).toBeNull();
  expect(await older.text()).toBe(stored);

  // The download address of the same snapshot never opens as a page, and a file ticket is nothing on the view route.
  const download = await client.call('artifacts.read', ids);
  expect(download.url).toMatch(/^\/file\//);
  expect((await fetch(new URL(download.url, harness.url))).headers.get('content-disposition')).toContain('attachment');
  expect((await fetch(new URL(download.url.replace('/file/', '/view/'), harness.url))).status).toBe(404);

  writeFileSync(join(harness.dataDir, 'report.txt'), 'x'.repeat(6 * 1024 * 1024));
  const file = await agent.call('artifacts.publish', { threadId, path: 'report.txt' });
  const plain = viewOf(file.parts)!;
  expect(await thrown(client.call('artifacts.read', { threadId, messageId: file.id, artifactId: plain.id, view: true }))).toThrow('published with boite view');
});

test('a view block opens as a page held in memory, under the view sandbox, and only downloads from the file route', async () => {
  const html = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg><script>document.title = "drawn"</script>';
  const { url } = await client.call('artifacts.viewBlock', { html });
  expect(url).toMatch(/^\/view\/[\w-]+$/);
  // The same HTML keeps its address, so a block drawn again loads the same page.
  expect((await client.call('artifacts.viewBlock', { html })).url).toBe(url);
  const response = await fetch(new URL(url, harness.url));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${VIEW_CONTENT_POLICY}`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(await response.text()).toBe(viewDocument(html));
  const download = await fetch(new URL(url.replace('/view/', '/file/'), harness.url));
  expect(download.headers.get('content-disposition')).toContain('attachment');
  expect(existsSync(join(harness.dataDir, 'artifacts')) ? readdirSync(join(harness.dataDir, 'artifacts')) : []).toEqual([]);

  expect(await thrown(client.call('artifacts.viewBlock', { html: ' \n' }))).toThrow('html must be the HTML of a view block');
  expect(await thrown(client.call('artifacts.viewBlock', { html: 'x'.repeat(VIEW_BLOCK_MAX_BYTES + 1) }))).toThrow('html must be at most 512 KB');
  // An agent shows a page through its answer, not through a client's method.
  expect(await thrown(agent.call('artifacts.viewBlock', { html }))).toThrow("artifacts.viewBlock is not one of the agent's methods");

  // Only the last 64 pages are held: the ticket of an older one opens nothing.
  for (let index = 0; index < 64; index++) await client.call('artifacts.viewBlock', { html: `<p>${index}</p>` });
  expect((await fetch(new URL(url, harness.url))).status).toBe(404);
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
  expect(await thrown(agent.call('artifacts.view', { threadId, path: 'notes.md' }))).toThrow('must be an HTML file');
  expect(await thrown(agent.call('artifacts.view', { threadId, path: 'empty.html' }))).toThrow('page is empty');
  expect(await thrown(agent.call('artifacts.view', { threadId, path: '../outside.html' }))).toThrow('leaves');
  const other = await echoThread(harness, client, 'another thread');
  expect(await thrown(agent.call('artifacts.view', { threadId: other.threadId, path: 'broken.html' }))).toThrow('is for thread');
  await client.call('threads.archive', { threadId });
  expect(await thrown(client.call('artifacts.view', { threadId, path: 'empty.html' }))).toThrow('active thread');
});

type SavedCheck = { checked: boolean; errors: string[]; advice: string[]; captures: Array<{ width: number; height: number; path: string; value?: unknown; png?: string }> };

test('view check without a browser fails explicitly without publishing or opening anything', async () => {
  write('quiet.html', page('<p>quiet</p>'));
  await client.call('threads.subscribe', { threadId });
  const before = (await client.call('threads.get', { threadId })).messages;
  const events: string[] = [];
  const off = client.onAny(event => events.push(event));
  try {
    const checked = await cli('view', 'check', 'quiet.html', '--json');
    expect(checked.code).toBe(1);
    expect(checked.error).toBe('');
    const result = JSON.parse(checked.output) as SavedCheck;
    expect(result.checked).toBe(false);
    expect(result.errors.join(' ')).toMatch(/browser/i);
    expect(result.captures).toEqual([]);
    expect((await client.call('threads.get', { threadId })).messages).toEqual(before);
    expect(events.filter(event => /^(message\.|panel\.|browser\.remote)/.test(event))).toEqual([]);
    expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
    expect(existsSync(join(harness.dataDir, 'view-checks')) ? readdirSync(join(harness.dataDir, 'view-checks')) : []).toEqual([]);
  } finally { off(); }
});

test('view check validates its file and options before publication', async () => {
  for (const args of [[], ['quiet.html', 'extra.html'], ['quiet.html', '--script'], ['quiet.html', '--scheme', 'sepia']]) {
    const checked = await cli('view', 'check', ...args);
    expect(checked.code).toBe(2);
  }
  write('quiet.html', page('<p>quiet</p>'));
  const missing = await cli('view', 'check', 'quiet.html', '--script', 'missing.js');
  expect(missing.code).toBe(1);
  expect(missing.error).toContain('missing.js');
  expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
});

test('view check RPC refuses invalid options, unsafe input and another agent thread', async () => {
  write('quiet.html', page('<p>quiet</p>'));
  const params = { threadId, path: 'quiet.html' };
  expect(await thrown(agent.call('artifacts.viewCheck', { ...params, scheme: 'sepia' as 'dark' }))).toThrow('scheme must be dark or light');
  expect(await thrown(agent.call('artifacts.viewCheck', { ...params, script: 42 as unknown as string }))).toThrow('script must be JavaScript text');
  expect(await thrown(agent.call('artifacts.viewCheck', { ...params, path: '../outside.html' }))).toThrow('leaves');
  write('remote.html', page('<script src="https://example.com/library.js"></script>'));
  expect(await thrown(agent.call('artifacts.viewCheck', { ...params, path: 'remote.html' }))).toThrow('library.js is remote');
  const other = await echoThread(harness, client, 'another thread');
  expect(await thrown(agent.call('artifacts.viewCheck', { ...params, threadId: other.threadId }))).toThrow('is for thread');
  await client.call('threads.archive', { threadId });
  expect(await thrown(client.call('artifacts.viewCheck', params))).toThrow('active thread');
  expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
  expect(existsSync(join(harness.dataDir, 'view-checks'))).toBe(false);
});

real('view check scripts run on a fresh page at each width and leave only local captures', async () => {
  await restartWithBrowser();
  write('controls.html', page('<button id="increment">Add</button><output id="count">0</output><script>document.querySelector("#increment").onclick = () => document.querySelector("#count").textContent++;</script>'));
  write('checks.js', `
    const count = document.querySelector('#count');
    if (count.textContent !== '0') throw new Error('page was reused');
    document.querySelector('#increment').click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (count.textContent !== '1') throw new Error('button did not increment');
    return { count: Number(count.textContent), scheme: getComputedStyle(document.documentElement).colorScheme };
  `);
  await client.call('threads.subscribe', { threadId });
  const before = (await client.call('threads.get', { threadId })).messages;
  const events: string[] = [];
  const off = client.onAny(event => events.push(event));
  try {
    const checked = await cli('view', 'check', 'controls.html', '--script', 'checks.js', '--scheme', 'light', '--json');
    expect(checked.code).toBe(0);
    expect(checked.error).toBe('');
    const result = JSON.parse(checked.output) as SavedCheck;
    expect(result).toMatchObject({ checked: true, errors: [], advice: [] });
    expect(result.captures.map(capture => capture.width)).toEqual([816, 330]);
    for (const capture of result.captures) {
      expect(capture.height).toBeGreaterThan(0);
      expect(capture.value).toEqual({ count: 1, scheme: 'light' });
      expect(capture.png).toBeUndefined();
      expect(dirname(capture.path)).toBe(harness.dataDir);
      expect(readFileSync(capture.path).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    expect((await client.call('threads.get', { threadId })).messages).toEqual(before);
    const status = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { tabs: unknown[] };
    expect(status.tabs).toEqual([]);
    expect(events.filter(event => /^(message\.|panel\.|browser\.remote)/.test(event))).toEqual([]);
    expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
    expect(existsSync(join(harness.dataDir, 'view-checks')) ? readdirSync(join(harness.dataDir, 'view-checks')) : []).toEqual([]);
  } finally { off(); }
}, 180_000);

real('view check keeps screenshots after a script error, returns failure and never overwrites a capture', async () => {
  await restartWithBrowser();
  write('throws.html', page('<p>Still visible</p>'));
  write('fails.js', "document.querySelector('p').textContent = 'Changed before failure'; throw new Error('control assertion failed');");
  const failed = await cli('view', 'check', 'throws.html', '--script', 'fails.js', '--json');
  expect(failed.code).toBe(1);
  expect(failed.error).toBe('');
  const result = JSON.parse(failed.output) as SavedCheck;
  expect(result.checked).toBe(true);
  expect(result.errors.join(' ')).toContain('control assertion failed');
  expect(result.captures.map(capture => capture.width)).toEqual([816, 330]);
  for (const capture of result.captures) {
    expect(capture.png).toBeUndefined();
    expect(readFileSync(capture.path).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(capture.path, 'keep this capture');
  }
  const again = await cli('view', 'check', 'throws.html', '--script', 'fails.js');
  expect(again.code).toBe(1);
  expect(again.output).toContain('capture:');
  expect(again.output).toContain('control assertion failed');
  for (const capture of result.captures) {
    expect(readFileSync(capture.path, 'utf8')).toBe('keep this capture');
    expect(again.output).not.toContain(capture.path);
  }
  expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
  expect(existsSync(join(harness.dataDir, 'view-checks')) ? readdirSync(join(harness.dataDir, 'view-checks')) : []).toEqual([]);
  // Each width fits alone, but together the values would exceed one RPC response.
  write('large-result.js', 'return "x".repeat(8 * 1024 * 1024);');
  const oversized = await cli('view', 'check', 'throws.html', '--script', 'large-result.js', '--json');
  expect(oversized.code).toBe(1);
  expect(oversized.error).toBe('');
  const oversizedResult = JSON.parse(oversized.output) as SavedCheck;
  expect(oversizedResult).toMatchObject({ checked: true, captures: [] });
  expect(oversizedResult.errors.join(' ')).toContain('16 MB');
  expect(existsSync(join(harness.dataDir, 'artifacts'))).toBe(false);
  expect(readdirSync(join(harness.dataDir, 'view-checks'))).toEqual([]);
}, 180_000);

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
  // The output hands the agent the line that places the page in its answer, a path with spaces in angle brackets.
  expect(loud.output).toContain('place: ![loud](views/loud.html) alone on a line of your answer');

  // Without a doctype a root is as tall as the window it is loaded in: the stored page has one, so its own height is what is measured.
  write('views/bare.html', '<html><head></head><body><div style="height:120px"></div></body></html>');
  const bare = viewOf((await agent.call('artifacts.view', { threadId, path: 'views/bare.html' })).message.parts)!.view!;
  expect(bare.height).toBeGreaterThanOrEqual(120);
  expect(bare.height).toBeLessThan(200);

  // A page wider than the answer is refused, naming the outermost element that sticks out; what a scrolling box holds is the page's own business.
  write('views/wide.html', page('<div class="flow" style="display:flex;gap:8px"><div style="flex:none;width:200px">a</div><div style="flex:none;width:200px">b</div></div>\n<div style="overflow-x:auto"><div style="width:2000px">scrolls</div></div>'));
  const wide = await agent.call('artifacts.view', { threadId, path: 'views/wide.html' }).then(() => null, (error: Error) => error.message);
  expect(wide).toContain('at 330px wide the page is cut on the right');
  expect(wide).toContain('<div> inside <div class="flow"> ends 78px past the right edge');
  expect(wide).not.toContain('at 816px');
  // A card on the very edge of the column fits: the frame keeps room for its border and shadow.
  write('views/edge.html', page('<div class="grid"><div class="card">1</div><div class="card">2</div><div class="card">3</div><div class="card">4</div><div class="card">5</div></div>'));
  expect((await agent.call('artifacts.view', { threadId, path: 'views/edge.html' })).checked).toBe(true);

  write('views/throws.html', page('<p>before</p>\n<script>\n  const stage = document.querySelector("#stage");\n  stage.getContext("2d");\n</script>'));
  const failure = await agent.call('artifacts.view', { threadId, path: 'views/throws.html' }).then(() => null, (error: Error) => error.message);
  expect(failure).toContain('not ready to show');
  expect(failure).toMatch(/TypeError: Cannot read properties of null/);
  // The line is the one of the agent's own file, not of the stored copy.
  expect(failure).toMatch(/:8:\d+|line 8/);

  write('views/calls.html', page('<script>fetch("https://example.com/data.json").catch(() => {});</script>'));
  const called = await agent.call('artifacts.view', { threadId, path: 'views/calls.html' }).then(() => null, (error: Error) => error.message);
  expect(called).toMatch(/Content Security Policy/i);
  // The route's sandbox puts the page on an opaque origin: the core's own storage is out of its reach.
  write('views/stores.html', page('<script>localStorage.setItem("seen", "1");</script>'));
  const stored = await agent.call('artifacts.view', { threadId, path: 'views/stores.html' }).then(() => null, (error: Error) => error.message);
  expect(stored).toMatch(/SecurityError/);
  // Five views were kept, each with its gzipped copy; the refused ones left neither.
  const kept = readdirSync(join(harness.dataDir, 'artifacts'));
  expect(kept.filter(name => !name.endsWith('.gz')).length).toBe(5);
  expect(kept.filter(name => name.endsWith('.gz')).sort()).toEqual(kept.filter(name => !name.endsWith('.gz')).map(name => `${name}.gz`).sort());
}, 180_000);

/** The gated test runs with the machine's browser: the core started without one is replaced. */
async function restartWithBrowser(): Promise<void> {
  agent.close(); await harness.stop();
  if (savedBrowser === undefined) delete process.env.BOITE_BROWSER; else process.env.BOITE_BROWSER = savedBrowser;
  await start(true);
}
