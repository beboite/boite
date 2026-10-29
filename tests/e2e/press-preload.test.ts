import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

// A remote machine 200 ms away, and a mouse button held 120 ms: the press
// should hide most of the click's round trip behind the hold.
const RTT_MS = 200;
const HOLD_MS = 120;
const SAMPLES = 4;

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;

/** A fresh page: nothing in the reading cache, the spy and the release clock in place. */
async function load(): Promise<void> {
  await page.navigate(url);
  await page.waitFor('document.querySelector("[data-testid=thread-row]") && globalThis.__boiteTest?.workspace.active.loadingThreadId === null', 30_000);
  // The sidebar slides in on load: a row is pressed where it comes to rest.
  await page.evaluate(`Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))`);
  await page.waitFor(`[...document.querySelectorAll('[data-testid=thread-row]')].every(row => row.getBoundingClientRect().left >= 0)`);
  await page.evaluate(`(() => {
    const client = globalThis.__boiteTest.workspace.active.client;
    const real = client.call.bind(client);
    window.__calls = [];
    client.call = (method, params, options) => { window.__calls.push(method + ' ' + (params?.threadId ?? '')); return real(method, params, options); };
    addEventListener('pointerup', () => { window.__upAt = performance.now(); }, { capture: true });
  })()`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent&rtt=${RTT_MS}`;
  // `BrowserPage.launch` tells every page it is driven, as the guard expects to see.
  page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  await page.waitFor('document.querySelector("[data-testid=thread-row]")', 30_000);
  await load();
}, 90_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function center(threadId: string): Promise<{ x: number; y: number }> {
  return page.evaluate<{ x: number; y: number }>(`(() => {
    const box = document.querySelector('[data-testid=thread-row][data-thread-id="${threadId}"]').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
}

/**
 * Press, hold, release on a row of a fresh page; the time from release to the
 * thread's messages in hand. The row turns open at the click either way, with
 * the loading view until its page lands.
 */
async function openByPress(threadId: string, preload: boolean): Promise<number> {
  await load();
  await page.evaluate(`window.__BOITE_PRESS_PRELOAD_TEST__ = ${preload}`);
  const { x, y } = await center(threadId);
  await page.evaluate(`(() => {
    window.__shownAt = null;
    const look = () => {
      const store = globalThis.__boiteTest.workspace.active;
      if (store.openThread?.id === '${threadId}' && store.loadingThreadId === null && store.openThread.messages.length > 0) window.__shownAt = performance.now();
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await Bun.sleep(HOLD_MS);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await page.waitFor('window.__shownAt !== null');
  return page.evaluate<number>('window.__shownAt - window.__upAt');
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test('a press under automation stays a plain click unless the test opts in', async () => {
  expect(await page.evaluate<boolean>('navigator.webdriver')).toBe(true);
  await page.evaluate('window.__calls = []');
  const { x, y } = await center('t-scheduler');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  let asked: string[];
  try {
    await Bun.sleep(RTT_MS);
    // Background refreshes and focus pings may run meanwhile; nothing may read this thread.
    asked = await page.evaluate<string[]>(`window.__calls.filter(call => /^threads\\.(get|subscribe) t-scheduler$/.test(call))`);
  } finally {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  expect(asked).toEqual([]);
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === 't-scheduler' && globalThis.__boiteTest.workspace.active.loadingThreadId === null`);
}, 30_000);

test('loading on press hides the round trip behind the held button, and a press dragged away gives its thread back', async () => {
  const targets = ['t-scheduler', 't-bench'];
  const plain: number[] = [];
  const pressed: number[] = [];
  // Two plain then two preloaded, each on a fresh page with nothing cached.
  for (let index = 0; index < SAMPLES * 2; index++) {
    const preload = Math.floor(index / 2) % 2 === 1;
    (preload ? pressed : plain).push(await openByPress(targets[index % 2]!, preload));
  }
  console.log(`press-preload rtt=${RTT_MS}ms hold=${HOLD_MS}ms: plain median ${median(plain).toFixed(0)} ms [${plain.map(v => v.toFixed(0)).join(', ')}], preloaded median ${median(pressed).toFixed(0)} ms [${pressed.map(v => v.toFixed(0)).join(', ')}]`);
  expect(median(plain)).toBeGreaterThanOrEqual(RTT_MS * 0.9);
  expect(median(plain) - median(pressed)).toBeGreaterThan(HOLD_MS * 0.6);

  // Pressed, dragged off the row and released on the chat: no click, no open,
  // and the subscription the press took is returned after the grace.
  await load();
  await page.evaluate(`window.__BOITE_PRESS_PRELOAD_TEST__ = true; window.__calls = []`);
  const open = await page.evaluate<string>('globalThis.__boiteTest.workspace.active.openThread.id');
  const other = open === 't-trace' ? 't-descriptors' : 't-trace';
  const { x, y } = await center(other);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.waitFor(`globalThis.__boiteTest.workspace.active.client.coreSubscribers.includes('${other}')`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 600, y, button: 'left' });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 600, y, button: 'left', clickCount: 1 });
  await page.waitFor(`!globalThis.__boiteTest.workspace.active.client.coreSubscribers.includes('${other}')`, 5_000);
  expect(await page.evaluate<string>('globalThis.__boiteTest.workspace.active.openThread.id')).toBe(open);
  expect(await page.evaluate<string>(`globalThis.__boiteTest.workspace.active.client.coreSubscribers.join(',')`)).toBe(open);
  // Background lookups such as the sidebar's pull requests may run meanwhile.
  expect(await page.evaluate<string[]>(`window.__calls.filter(call => /^threads\\.(get|subscribe|unsubscribe) ${other}$/.test(call))`)).toEqual([`threads.get ${other}`, `threads.unsubscribe ${other}`]);
}, 60_000);
