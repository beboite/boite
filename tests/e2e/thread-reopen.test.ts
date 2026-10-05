import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import type { RunningCore } from './lib/core.ts';
import { startCoreWithLongThread } from './lib/long-thread.ts';
import { mobileAction } from './lib/mobile.ts';
import { startUi } from './lib/ui.ts';

/**
 * What a reader of a long thread does after its first page: scrolls up to a
 * picture the page left on the core, edits a prompt whose file stayed there,
 * reads far up, leaves, and comes back where they were. On a real core and
 * the real UI, at phone and desktop widths.
 */
const artifacts = process.env.BOITE_OPEN_CAPTURES ?? join(import.meta.dir, '.artifacts');
const STORE = 'globalThis.__boiteTest.workspace.active';
/** In the last page, read upwards: a prompt with a 1.5 MB PDF, then one with a 220x220 picture. */
const PICTURE = 'msg_fixture0082u';
const FILE = 'msg_fixture0091u';
/** Far above the last page: where the reader stops before leaving. */
const FAR = 'msg_fixture0030u';

let core: RunningCore;
let ui: { close(): Promise<void> };
let origin = '';
let long = '';
let short = '';
let fileBytes = 0;

beforeAll(async () => {
  const seeded = await startCoreWithLongThread();
  core = seeded.core;
  long = seeded.long;
  short = seeded.short;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  ui = await startUi(port, { development: true });
  const client = await connect(core.url, core.token, { client: { name: 'test', version: '0' }, timeoutMs: 30_000 });
  try {
    await client.call('settings.set', { browserOrigins: [origin] });
    const page = await client.call('threads.get', { threadId: long, limit: 40, compactTools: true, compactFiles: true, compactImages: true });
    const parts = (id: string) => page.messages.find((message) => message.id === id)!.parts;
    // The picture and the file this test fetches really are left on the core by the first page.
    expect(parts(PICTURE).find((part) => part.type === 'image')).toMatchObject({ data: '', dataDeferred: true });
    expect(parts(FILE).find((part) => part.type === 'file')).toMatchObject({ data: '', dataDeferred: true });
    const index = parts(FILE).findIndex((part) => part.type === 'file');
    fileBytes = (await client.call('messages.attachment', { threadId: long, messageId: FILE, partIndex: index })).data.length;
  } finally {
    client.close();
  }
}, 180_000);

afterAll(async () => {
  await ui?.close();
  await core?.stop();
}, 30_000);

/**
 * Scrolls the timeline up in short steps, as a finger does, until `id` is on
 * screen, then nudges it to the top of the view when `top` is asked. Long
 * jumps are avoided: the window is laid out on estimated heights, and a jump
 * lands somewhere else than asked. With `near`, it stops instead once the
 * element `near` selects inside that message is within 300 px above the view,
 * still off screen.
 */
function reveal(id: string, options: { top?: boolean; near?: string } = {}): string {
  return `(async () => {
    const timeline = document.querySelector('[data-testid=timeline]');
    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const near = ${JSON.stringify(options.near ?? null)};
    const offset = () => {
      const node = timeline.querySelector('[data-mid="${id}"]' + (near ? ' ' + near : ''));
      if (!node) return null;
      const box = node.getBoundingClientRect(), view = timeline.getBoundingClientRect();
      if (near) return box.bottom <= view.top && box.bottom > view.top - 300 ? box.bottom - view.top : null;
      return box.bottom > view.top && box.top < view.bottom ? box.top - view.top : null;
    };
    for (let step = 0; step < 1500 && offset() === null; step += 1) {
      timeline.scrollTop = Math.max(0, timeline.scrollTop - (near ? 100 : 200));
      timeline.dispatchEvent(new Event('scroll'));
      await settle(${STORE}.loadingOlder ? 300 : 40);
    }
    for (let nudge = 0; ${options.top === true} && nudge < 10 && offset() !== null && Math.abs(offset()) > 2; nudge += 1) {
      timeline.scrollTop += offset();
      timeline.dispatchEvent(new Event('scroll'));
      await settle(300);
    }
    if (offset() !== null) return true;
    return JSON.stringify({ top: timeline.scrollTop, count: ${STORE}.openThread.messages.length, rendered: [...timeline.querySelectorAll('[data-mid]')].map((n) => n.dataset.mid).slice(0, 3) });
  })()`;
}

/** Whether `id` is rendered and at least partly inside the timeline's box. */
function inView(id: string): string {
  return `(() => {
    const timeline = document.querySelector('[data-testid=timeline]').getBoundingClientRect();
    const node = document.querySelector('[data-testid=timeline] [data-mid="${id}"]');
    if (!node) return false;
    const box = node.getBoundingClientRect();
    return box.bottom > timeline.top && box.top < timeline.bottom;
  })()`;
}

for (const phone of [true, false]) {
  const name = phone ? 'phone' : 'desktop';
  test(`a long thread's deferred picture, Edit of a deferred file and the return to the reader's place, on ${name}`, async () => {
    const page = await BrowserPage.launch({
      url: `${origin}/?core=${encodeURIComponent(core.url)}&token=${encodeURIComponent(core.token)}`,
      windowSize: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    });
    try {
      await page.click('[data-testid=confirm-ok]');
      await page.waitFor(`${STORE}?.connection === 'ready'`, 30_000);
      const open = async (id: string): Promise<void> => {
        if (phone) await mobileAction(page, 'mobile-conversations');
        await page.click(phone ? `[data-testid=mobile-thread-${id}]` : `[data-thread-id="${id}"]`);
        // The short thread holds no message; the long one is open once its rows are drawn.
        await page.waitFor(`${STORE}.openThread?.id === '${id}' && ${STORE}.loadingThreadId === null${id === long ? " && !!document.querySelector('[data-testid=timeline] [data-mid]')" : ''}`, 60_000);
      };
      await open(short);
      await open(long);
      expect(await page.evaluate<boolean>(`${STORE}.messagesAfter === null`)).toBe(true);

      // Edit fetches the file the page left on the core before it fills the composer.
      expect(await page.evaluate<boolean | string>(reveal(FILE), 120_000)).toBe(true);
      await page.click(`[data-mid="${FILE}"] [data-testid=message-edit]`);
      await page.waitFor(`${STORE}.composerStates['${long}']?.editing === '${FILE}'`, 30_000);
      expect(await page.evaluate<number[]>(`${STORE}.composerStates['${long}'].attachments.map((attachment) => attachment.data.length)`)).toEqual([fileBytes]);
      await page.waitFor(`document.querySelectorAll('[data-testid=composer-attachment]').length === 1`);
      await page.screenshot(join(artifacts, `thread-reopen-edit-${name}.png`));
      // Leaving the edit: the composer goes back to empty.
      await page.evaluate(`Object.assign(${STORE}.composerStates['${long}'], { editing: null, text: '', attachments: [] })`);

      // The picture is a placeholder that fetches it as it nears the screen, before it is on it.
      expect(await page.evaluate<boolean | string>(reveal(PICTURE, { near: '.images' }), 120_000)).toBe(true);
      await page.waitFor(`document.querySelector('[data-mid="${PICTURE}"] [data-testid=image-part]')?.naturalWidth === 220`, 30_000);
      expect(await page.evaluate<boolean | string>(reveal(PICTURE), 120_000)).toBe(true);
      await page.screenshot(join(artifacts, `thread-reopen-picture-${name}.png`));

      // Far up, past what the reading cache keeps, the reader stops on one message and leaves.
      expect(await page.evaluate<boolean | string>(reveal(FAR, { top: true }), 120_000)).toBe(true);
      await page.waitFor(inView(FAR));
      await open(short);
      await open(long);

      // Back on the page around that message, not the last one, with the message on screen.
      expect(await page.evaluate<string | null>(`${STORE}.messagesAfter`)).not.toBeNull();
      expect(await page.evaluate<boolean>(`${STORE}.openThread.messages.some((message) => message.id === 'msg_fixture0099a')`)).toBe(false);
      await page.waitFor(inView(FAR), 10_000);
      await page.screenshot(join(artifacts, `thread-reopen-around-${name}.png`));

      // Its bottom is not the end: the next page comes as the reader gets there.
      const before = await page.evaluate<number>(`${STORE}.openThread.messages.length`);
      await page.evaluate(`(() => { const timeline = document.querySelector('[data-testid=timeline]'); timeline.scrollTop = timeline.scrollHeight; timeline.dispatchEvent(new Event('scroll')); })()`);
      await page.waitFor(`${STORE}.openThread.messages.length > ${before}`, 30_000);

      // "Jump to latest" reads the last page and lands on its end.
      await page.click('[data-testid=jump-to-latest]');
      await page.waitFor(`${STORE}.messagesAfter === null`, 30_000);
      await page.waitFor(inView('msg_fixture0099a'), 30_000);
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 240_000);
}
