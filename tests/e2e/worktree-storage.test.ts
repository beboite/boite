import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const state = 'globalThis.__boiteTest.workspace.active';
const captures = process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts');

async function capture(name: string) {
  await page.evaluate(`document.querySelector('${id('worktree-storage')}').scrollIntoView({ block: 'center' })`);
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(captures, name));
}

async function mode(value: string) {
  await page.click(id('worktree-storage-mode'));
  const choice = `${id('worktree-storage-mode-menu')} [data-value="${value}"]`;
  await page.waitFor(`document.querySelector('${choice}')`);
  await page.click(choice);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1360, height: 960 } });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('owners choose storage in desktop and phone settings, with validation and existing paths preserved', async () => {
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-general'));
  await page.waitFor(`document.querySelector('${id('worktree-storage')}')`);
  expect(await page.evaluate(`${state}.settings.worktreeStorage.mode`)).toBe('project');
  await capture('worktree-storage-project.png');
  await mode('shared');
  await page.type(id('worktree-storage-directory'), 'relative/path');
  await page.click(id('worktree-storage-save'));
  await page.waitFor(`document.querySelector('${id('worktree-storage')} [role=alert]')`);
  expect(await page.evaluate(`${state}.settings.worktreeStorage.mode`)).toBe('project');
  await page.type(id('worktree-storage-directory'), 'D:\\Worktrees');
  await page.click(id('worktree-storage-save'));
  await page.waitFor(`${state}.settings.worktreeStorage.mode === 'shared' && document.querySelector('${id('worktree-storage-save')}').disabled`);
  await capture('worktree-storage-shared.png');
  // Leave and reopen the form to read the saved setting, not its draft.
  await page.click(id('settings-tab-appearance'));
  await page.click(id('settings-tab-general'));
  await page.waitFor(`document.querySelector('${id('worktree-storage-directory')}')?.value === 'D:\\\\Worktrees'`);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  await page.click(id('mobile-settings-worktrees'));
  await page.waitFor(`document.querySelector('${id('worktree-storage-directory')}')`);
  await capture('worktree-storage-phone.png');
  await mode('project');
  await page.click(id('worktree-storage-save'));
  await page.waitFor(`${state}.settings.worktreeStorage.mode === 'project'`);
  await capture('worktree-storage-phone-project.png');
  expect(await page.evaluate(`${state}.threads.find(t => t.id === 't-scheduler').cwd`)).toContain('.boite-worktrees');
  await page.click(id('mobile-settings-back'));
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  await page.evaluate(`${state}.principal = 'session'; ${state}.client.becomes('session')`);
  await page.waitFor(`!document.querySelector('${id('mobile-settings-worktrees')}')`);
  expect(page.errors()).toEqual([]);
}, 60_000);
