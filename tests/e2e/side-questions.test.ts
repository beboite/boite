import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

let core: RunningCore;
let client: CoreClient;
let page: BrowserPage;
let threadId: string;

beforeAll(async () => {
  ensureProductionUi();
  core = await startCore();
  client = await connect(core.url, core.token);
  const project = await client.call('projects.add', { path: core.dataDir, name: 'Side questions' });
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Inspect the configuration' });
  threadId = thread.id;
  await client.call('threads.update', { threadId, title: thread.title });
  page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
  await page.waitFor("document.querySelector('[data-testid=thread-row]')");
  await page.click('[data-testid=thread-row]');
  await page.waitFor("document.querySelector('[data-testid=thread-title]')?.textContent.includes('Inspect the configuration')");
}, 90_000);

afterAll(async () => { await page?.close(); client?.close(); await core?.stop(); });

test('a desktop and paired phone ask /btw while the main turn waits, without queuing or recording the question', async () => {
  await client.call('turns.start', { threadId, prompt: 'Read the configuration [permission]' });
  await page.waitFor("document.querySelector('[data-testid=permission-card]')");
  const before = await client.call('threads.get', { threadId });
  await page.type('[data-testid=composer-input]', '/bt');
  await page.waitFor("document.querySelector('[data-testid=slash-row][data-name=btw]')");
  await page.click('[data-testid=slash-row][data-name=btw]');
  expect(await page.evaluate("document.querySelector('[data-testid=composer-input]').value")).toBe('/btw ');
  await page.type('[data-testid=composer-input]', '/btw Which configuration file?');
  await page.click('[data-testid=composer-send]');
  await page.waitFor("document.querySelector('[data-testid=btw-answer]')?.textContent.includes('Side answer: Which configuration file?')");
  await page.screenshot(join(import.meta.dir, '.artifacts', 'btw-desktop.png'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor("!document.querySelector('[data-testid=btw-answer]')");
  expect((await client.call('threads.get', { threadId })).status).toBe('waiting');

  await page.close();
  page = await BrowserPage.launch({ url: await mintPairing(core), windowSize: { width: 1280, height: 900 } });
  await page.waitFor("document.querySelector('[data-testid=thread-row]')");
  await page.click('[data-testid=thread-row]');
  await page.waitFor("document.querySelector('[data-testid=thread-title]')?.textContent.includes('Inspect the configuration')");
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.type('[data-testid=composer-input]', '/btw A short side answer on the phone');
  await page.click('[data-testid=composer-send]');
  await page.waitFor("document.querySelector('[data-testid=btw-answer]')?.textContent.includes('Side answer: A short side answer on the phone')");
  expect(await page.evaluate("(() => { const r = document.querySelector('[data-testid=btw-answer]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()")).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'btw-phone.png'));
  await page.click('[data-testid=btw-close]');
  await page.waitFor("!document.querySelector('[data-testid=btw-answer]')");
  const after = await client.call('threads.get', { threadId });
  expect(after.messages).toEqual(before.messages);
  expect(after.turns).toEqual(before.turns);
  expect(after.status).toBe('waiting');
  expect(page.errors()).toEqual([]);
}, 60_000);
