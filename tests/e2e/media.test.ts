import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

/*
 * A long thread of screenshots on a real core, read by the production UI in
 * headless Chrome. The page holds every `messages.attachment` frame while a
 * test says so, which is how the blur is caught on screen and how a scroll is
 * checked to stay put while the pictures land.
 */

const SHOTS = 24;
const WIDTH = 960;
const HEIGHT = 540;
const artifacts = process.env.BOITE_MEDIA_CAPTURES ?? join(import.meta.dir, '.artifacts');
const timeline = '[data-testid=timeline]';
/** The pictures on screen: the ones far from it are not asked for, which is the point. */
const visible = `Array.from(document.querySelectorAll('${timeline} [data-testid=image-box]')).filter((node) => {
  const rect = node.getBoundingClientRect();
  const box = document.querySelector('${timeline}').getBoundingClientRect();
  return rect.bottom > box.top && rect.top < box.bottom;
})`;
const allShown = `(${visible}).length > 0 && (${visible}).every((node) => node.dataset.state === 'shown')`;

let core: RunningCore;
let client: CoreClient;
let page: BrowserPage;
let threadId: string;
let agentThreadId: string;
const SCENES = 9;

/** A gradient with noise on it: a PNG of about a megabyte that blurs to its own colours. */
function screenshot(index: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  let seed = index * 7919 + 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) % 48;
  };
  const hue = (index * 47) % 255;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = y * (WIDTH * 3 + 1) + 1 + x * 3;
      rows[at] = Math.min(255, Math.round((x / WIDTH) * 200) + noise());
      rows[at + 1] = Math.min(255, hue + noise());
      rows[at + 2] = Math.min(255, Math.round((y / HEIGHT) * 200) + noise());
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

/** Counts every `messages.attachment` the page sends and, while `hold` is set, keeps it from leaving. */
const HOLD_MEDIA = `(() => {
  const state = window.__media = { sent: 0, hold: false, held: [] };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (frame) {
    if (typeof frame === 'string' && frame.includes('"method":"messages.attachment"')) {
      state.sent += 1;
      if (state.hold) { state.held.push(() => send.call(this, frame)); return; }
    }
    return send.call(this, frame);
  };
  state.release = () => { state.hold = false; for (const go of state.held.splice(0)) go(); };
})()`;

async function settled(): Promise<void> {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true });
  core = await startCore();
  client = await connect(core.url, core.token);
  const echo = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
  const project = await client.call('projects.add', { path: core.dataDir, name: 'Screenshots' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: echo.id, title: 'A long thread of screenshots' });
  threadId = thread.id;
  for (let index = 0; index < SHOTS; index += 1) {
    const done = new Promise<void>((resolve) => {
      const off = client.on('turn.finished', (turn) => { if (turn.threadId === threadId) { off(); resolve(); } });
    });
    await client.call('turns.start', {
      threadId,
      prompt: `Screenshot ${index + 1}: the layout after change ${index + 1}. The text under it must not move while it loads.`,
      attachments: [{ kind: 'image', mimeType: 'image/png', data: screenshot(index), name: `shot-${index + 1}.png` }],
    });
    await done;
  }
  // A thread where the agent attached its own screenshots, as `boite attach` does.
  const agent = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: echo.id, title: 'An agent attaching screenshots' });
  agentThreadId = agent.id;
  const turned = new Promise<void>((resolve) => {
    const off = client.on('turn.finished', (turn) => { if (turn.threadId === agentThreadId) { off(); resolve(); } });
  });
  await client.call('turns.start', { threadId: agentThreadId, prompt: 'Show me every scene of the game.' });
  await turned;
  for (let index = 0; index < SCENES; index += 1) {
    writeFileSync(join(core.dataDir, `scene-${index + 1}.png`), Buffer.from(screenshot(SHOTS + index), 'base64'));
    await client.call('artifacts.publish', { threadId: agentThreadId, path: `scene-${index + 1}.png` });
  }
  page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 900 } });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOLD_MEDIA });
  await page.navigate(pairingUrlOf(core));
}, 180_000);

afterAll(async () => { await page?.close(); client?.close(); await core?.stop(); }, 15_000);

test('a thread of screenshots opens on a light page and fetches only the pictures near the screen', async () => {
  const plain = JSON.stringify(await client.call('threads.get', { threadId })).length;
  const started = performance.now();
  const light = JSON.stringify(await client.call('threads.get', { threadId, compactImages: true })).length;
  const took = performance.now() - started;
  console.log(`threads.get: ${plain} characters with the bytes, ${light} with compactImages (${took.toFixed(0)} ms, blurs made on this first read)`);
  expect(light * 100).toBeLessThan(plain);

  await page.click(`[data-thread-id="${threadId}"]`);
  await page.waitFor(`document.querySelectorAll('${timeline} [data-testid=image-box][data-state=shown]').length > 0`);
  await settled();
  await Bun.sleep(500);
  const sent = await page.evaluate<number>('window.__media.sent');
  const mounted = await page.evaluate<number>(`document.querySelectorAll('${timeline} [data-testid=image-box]').length`);
  console.log(`opened at the bottom: ${sent} pictures fetched of ${SHOTS}, ${mounted} mounted`);
  expect(sent).toBeLessThan(SHOTS / 2);
  expect(sent).toBeLessThanOrEqual(mounted);
  await page.screenshot(join(artifacts, 'media-desktop-loaded.png'));
}, 60_000);

test('pictures scrolled to keep their size and blur, and the text under the reader does not move when they land', async () => {
  await page.evaluate('window.__media.hold = true');
  await page.evaluate(`document.querySelector('${timeline}').scrollTop = document.querySelector('${timeline}').scrollHeight * 0.35`);
  await page.waitFor(`document.querySelector('${timeline} [data-testid=image-box][data-state=waiting] [data-testid=image-preview]')`);
  await settled();
  await Bun.sleep(300);
  // The reading anchor: the first prompt text whose top is on screen.
  const anchor = `(() => {
    const box = document.querySelector('${timeline}').getBoundingClientRect();
    const text = Array.from(document.querySelectorAll('${timeline} [data-testid=text-part]')).find((node) => node.getBoundingClientRect().top >= box.top);
    return text ? { text: text.textContent, top: Math.round(text.getBoundingClientRect().top), scroll: document.querySelector('${timeline}').scrollTop } : null;
  })()`;
  const before = await page.evaluate<{ text: string; top: number; scroll: number }>(anchor);
  expect(before).not.toBeNull();
  // Every picture on screen is drawn at its own proportions, from the header alone.
  const boxes = await page.evaluate<{ ratio: number; preview: boolean }[]>(`(${visible}).map((node) => {
    const rect = node.getBoundingClientRect();
    return { ratio: rect.width / rect.height, preview: !!node.querySelector('[data-testid=image-preview]') };
  })`);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(Math.abs(box.ratio - WIDTH / HEIGHT)).toBeLessThan(0.02);
    expect(box.preview).toBe(true);
  }
  await page.screenshot(join(artifacts, 'media-desktop-blur.png'));

  await page.evaluate('window.__media.release()');
  await page.waitFor(allShown);
  await settled();
  const after = await page.evaluate<{ text: string; top: number; scroll: number }>(anchor);
  console.log(`anchor before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  expect(after.text).toBe(before.text);
  expect(after.top).toBe(before.top);
  expect(after.scroll).toBe(before.scroll);
  await page.screenshot(join(artifacts, 'media-desktop-scrolled.png'));

}, 60_000);

test('on a phone the pictures fit the column at their proportions', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate('window.__media.hold = true');
  // The oldest screenshots were never fetched: the top of the thread shows them blurred.
  await page.evaluate(`document.querySelector('${timeline}').scrollTop = 0`);
  await page.waitFor(`(${visible}).some((node) => node.dataset.state === 'waiting' && node.querySelector('[data-testid=image-preview]'))`);
  await settled();
  await page.screenshot(join(artifacts, 'media-phone-blur.png'));
  await page.evaluate('window.__media.release()');
  await page.waitFor(allShown);
  await settled();
  const fits = await page.evaluate<boolean>(`(${visible}).every((node) => {
    const rect = node.getBoundingClientRect();
    return rect.right <= window.innerWidth && Math.abs(rect.width / rect.height - ${WIDTH / HEIGHT}) < 0.02;
  })`);
  expect(fits).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(artifacts, 'media-phone-loaded.png'));
}, 60_000);

test("an agent's attached screenshots open on a light page and load near the screen in boxes of their size", async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const light = await client.call('threads.get', { threadId: agentThreadId, limit: 40, compactTools: true, compactFiles: true, compactImages: true, compactToolParts: true });
  const files = light.messages.flatMap((message) => message.parts.filter((part) => part.type === 'file'));
  const total = files.reduce((sum, part) => sum + (part.type === 'file' ? part.bytes ?? 0 : 0), 0);
  console.log(`agent pictures: ${files.length} files of ${total} bytes, the light page ${JSON.stringify(light).length} characters`);
  expect(files).toHaveLength(SCENES);
  expect(files.every((part) => part.type === 'file' && part.dataDeferred && part.width === WIDTH && part.height === HEIGHT && part.preview)).toBe(true);
  expect(JSON.stringify(light).length).toBeLessThan(total / 20);

  const shown = `Array.from(document.querySelectorAll('${timeline} [data-testid=chat-file] .shot')).filter((node) => {
    const rect = node.getBoundingClientRect();
    const box = document.querySelector('${timeline}').getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  })`;
  await page.evaluate('window.__media.sent = 0; window.__media.hold = true');
  await page.click(`[data-thread-id="${agentThreadId}"]`);
  await page.waitFor(`(${shown}).length > 0 && (${shown}).every((node) => node.querySelector('[data-testid=artifact-blur]'))`);
  await settled();
  const ratios = await page.evaluate<number[]>(`(${shown}).map((node) => { const rect = node.getBoundingClientRect(); return rect.width / rect.height; })`);
  for (const ratio of ratios) expect(Math.abs(ratio - WIDTH / HEIGHT)).toBeLessThan(0.02);
  const asked = await page.evaluate<number>('window.__media.sent');
  console.log(`agent thread opened: ${asked} of ${SCENES} pictures asked, ${ratios.length} on screen`);
  expect(asked).toBeLessThan(SCENES);
  await page.screenshot(join(artifacts, 'media-agent-blur.png'));
  const top = `Math.round(document.querySelector('${timeline} [data-testid=chat-file]').getBoundingClientRect().top)`;
  const before = await page.evaluate<number>(top);

  await page.evaluate('window.__media.release()');
  await page.waitFor(`(${shown}).length > 0 && (${shown}).every((node) => node.querySelector('img:not(.blur)')?.complete && !node.querySelector('.blur'))`);
  await settled();
  expect(await page.evaluate<number>(top)).toBe(before);
  await page.screenshot(join(artifacts, 'media-agent-loaded.png'));

  // What the timeline drew is the light WebP copy; the original is one click away.
  const scene = light.messages.find((message) => message.parts.some((part) => part.type === 'file'))!;
  const index = scene.parts.findIndex((part) => part.type === 'file');
  const copy = await client.call('messages.attachment', { threadId: agentThreadId, messageId: scene.id, partIndex: index, display: true });
  const original = await client.call('messages.attachment', { threadId: agentThreadId, messageId: scene.id, partIndex: index });
  console.log(`agent picture: original ${original.data.length} base64 characters, copy ${copy.data.length} as ${copy.mimeType}`);
  expect(copy.mimeType).toBe('image/webp');
  expect(copy.data.length * 5).toBeLessThan(original.data.length);
  await page.evaluate(`(${shown}).at(-1).click()`);
  await page.waitFor(`document.querySelector('[data-testid=image-viewer] img')?.complete && document.querySelector('[data-testid=image-viewer] img').naturalWidth === ${WIDTH}`);
  expect(await page.evaluate<string>(`document.querySelector('[data-testid=image-viewer] img').getAttribute('src').slice(0, 5)`)).toBe('blob:');
  await settled();
  await page.screenshot(join(artifacts, 'media-agent-original.png'));
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
}, 60_000);
