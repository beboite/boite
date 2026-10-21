import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port: number;
const id = (value: string) => `[data-testid="${value}"]`;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); }, 30_000);

/** Every box inside `selector` that its own button clips: none when the row grows with its text. */
const clipped = (selector: string) => `(() => {
  const row = document.querySelector('${selector}');
  const box = row.getBoundingClientRect();
  return [...row.querySelectorAll('span')].filter(span => {
    const inner = span.getBoundingClientRect();
    return inner.height > 0 && (inner.top < box.top - 0.5 || inner.bottom > box.bottom + 0.5);
  }).map(span => span.textContent);
})()`;

test('the contacts column\'s rows hold their text: the empty row\'s wrapped tip grows it instead of spilling over the title', async () => {
  const page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 900 } });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.setItem('boite.experiments', JSON.stringify(['contacts']));
      localStorage.setItem('boite.contacts-rail-folded', '0');` });
    await page.navigate(`http://127.0.0.1:${port}/?fake=1&open=recent`);
    await page.waitFor(`document.querySelector('${id('rail-contact')}')`);
    expect(await page.evaluate<string[]>(clipped(id('rail-contact')))).toEqual([]);

    await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.client.call('contacts.remove', { coreId: 'core-chris' })`);
    await page.waitFor(`document.querySelector('${id('contacts-rail-empty')}')`);
    expect(await page.evaluate<string[]>(clipped(id('contacts-rail-empty')))).toEqual([]);
    const { head, row } = await page.evaluate<{ head: number; row: number }>(`({ head: document.querySelector('${id('contacts-rail-home')}').getBoundingClientRect().bottom,
      row: document.querySelector('${id('contacts-rail-empty')}').querySelector('.name').getBoundingClientRect().top })`);
    expect(row).toBeGreaterThanOrEqual(head);
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);
