import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let url: string;
const store = 'globalThis.__boiteTest.workspace.active';
const summary = '[data-testid="turn-summary"][data-status="done"]';
const stamp = '[data-testid="message-time"]';
const ticks = '[data-testid="message-receipts"].settled [data-testid="receipt-responded"]';
const opacity = (selector: string) => `getComputedStyle([...document.querySelectorAll('${selector}')].at(-1)).opacity`;

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
}, 60_000);
afterAll(async () => { await server?.close(); });

/** Points the mouse at the middle of the last element the selector matches. */
async function hover(page: BrowserPage, selector: string): Promise<void> {
  const at = await page.evaluate<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll('${selector}')].at(-1).closest('.message').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
}

async function settle(page: BrowserPage): Promise<void> {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('new Promise(resolve => setTimeout(resolve, 400))');
}

for (const [name, width, height, touch] of [['desktop', 1280, 900, false], ['phone', 390, 844, true]] as const) {
  test(`a finished turn's summary and a prompt's time and ticks wait for the pointer on ${name}`, async () => {
    // Headless Chrome reports no hover and no pointer: give each layout the input it stands for.
    const input = touch ? 'primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2' : 'primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4';
    const page = await BrowserPage.launch({ url, windowSize: { width, height }, args: [`--blink-settings=${input}`] });
    const capture = (state: string) => page.screenshot(join(import.meta.dir, '.artifacts', `message-meta-${state}-${name}.png`));
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
      expect(await page.evaluate<boolean>(`matchMedia('(hover: hover)').matches`)).toBe(!touch);
      await page.waitFor(`${store}?.connection === 'ready'`);
      await page.waitFor(`document.querySelector('${summary}') && document.querySelector('${stamp}')`);
      // Away from every message.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: height - 1 });
      await settle(page);
      await capture('rest');
      const shown = touch ? '1' : '0';
      expect(await page.evaluate<string>(opacity(summary))).toBe(shown);
      expect(await page.evaluate<string>(opacity(stamp))).toBe(shown);
      expect(await page.evaluate<string>(opacity(ticks))).toBe(shown);
      if (touch) return;
      await hover(page, summary);
      await settle(page);
      await capture('hover-answer');
      expect(await page.evaluate<string>(opacity(summary))).toBe('1');
      await hover(page, stamp);
      await settle(page);
      await capture('hover-prompt');
      expect(await page.evaluate<string>(opacity(stamp))).toBe('1');
      expect(await page.evaluate<string>(opacity(ticks))).toBe('1');
    } finally {
      await page.close();
    }
  }, 60_000);
}
