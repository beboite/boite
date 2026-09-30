import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

let core: RunningCore;
let client: CoreClient;
let page: BrowserPage;
let threadId: string;
const selector = (name: string) => `[data-testid="${name}"]`;

beforeAll(async () => {
  core = await startCore();
  client = await connect(core.url, core.token);
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  const project = await client.call('projects.add', { path: core.dataDir, name: 'Permissions' });
  const thread = await client.call('threads.create', {
    projectId: project.id, providerId: 'echo', accountId: account.id, title: 'YOLO permissions',
  });
  threadId = thread.id;
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await page.click(`[data-thread-id="${threadId}"]`);
  await page.waitFor(`document.querySelector('${selector('composer-mode')}')`);
}, 30_000);

afterAll(async () => { await page?.close(); client?.close(); await core?.stop(); }, 15_000);

test('desktop and phone can select YOLO, run without a permission card and restore Ask', async () => {
  await page.click(selector('composer-mode'));
  const yolo = `${selector('composer-mode-menu')} [data-value="yolo"]`;
  await page.click(yolo);
  await page.waitFor(`document.querySelector('${selector('composer-mode')}')?.textContent.includes('YOLO')`);
  expect((await client.call('threads.get', { threadId })).permissionMode).toBe('yolo');
  await page.click(selector('composer-mode'));
  await page.screenshot(join(import.meta.dir, '.artifacts/yolo-desktop.png'));
  await page.click(yolo);
  const done = client.next('turn.finished', turn => turn.threadId === threadId, 10000);
  await page.type(selector('composer-input'), '[permission]');
  await page.click(selector('composer-send'));
  expect((await done).status).toBe('done');
  expect(await client.call('permissions.list', { threadId })).toEqual([]);
  await page.waitFor(`document.body.innerText.includes('allowed')`);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click(selector('composer-options'));
  await page.click(`${selector('composer-options-sheet')} input[value="default"]`);
  expect((await client.call('threads.get', { threadId })).permissionMode).toBe('default');
  await page.click(`${selector('composer-options-sheet')} input[value="yolo"]`);
  await page.waitFor(`document.querySelector('${selector('composer-options-sheet')} input[value="yolo"]')?.checked`);
  expect((await client.call('threads.get', { threadId })).permissionMode).toBe('yolo');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts/yolo-phone.png'));
}, 30_000);
