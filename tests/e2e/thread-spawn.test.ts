import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

/* `boite thread new`: a thread's agent starts a real thread in another project, and its first answer comes back. */

let core: RunningCore;
let page: BrowserPage;
let owner: CoreClient;
let callerId: string;
let startedId: string;
beforeAll(async () => {
  core = await startCore(); owner = await connect(core.url, core.token);
  const desk = await owner.call('projects.add', { path: core.dataDir, name: 'Release desk' });
  const sitePath = join(core.dataDir, 'website');
  mkdirSync(sitePath, { recursive: true });
  await owner.call('projects.add', { path: sitePath, name: 'Website' });
  const account = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const caller = await owner.call('threads.create', { projectId: desk.id, providerId: 'echo', accountId: account.id, model: 'echo', title: 'Coordinate the 2.4 release' });
  callerId = caller.id;
  const spawned = await owner.call('agent.spawn', { threadId: callerId, project: 'website', prompt: 'Publish the 2.4 announcement on the blog', title: 'Blog post for 2.4', requestId: 'e2e-spawn' });
  startedId = spawned.thread.id;
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
}, 60_000);
afterAll(async () => { await page?.close(); owner?.close(); await core?.stop(); }, 30_000);

test('the starting thread shows the thread it started and the answer that came back', async () => {
  await page.waitFor(`!!document.querySelector('[data-testid="thread-row"][data-thread-id="${callerId}"]')`);
  await page.click(`[data-testid="thread-row"][data-thread-id="${callerId}"]`);
  await page.waitFor('document.querySelector("[data-testid=spawn-marker][data-direction=to]")?.textContent.includes("Blog post for 2.4")');
  await page.waitFor(`document.querySelector('[data-testid=agent-message-summary][data-direction=incoming]')`, 15_000);
  await page.click('[data-testid=agent-message-summary][data-direction=incoming]');
  await page.waitFor(`[...document.querySelectorAll('[data-testid=forwarded-agent-message][data-direction=incoming]')].some(el => el.textContent.includes('Blog post for 2.4: done'))`, 15_000);
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  expect(await page.text('[data-testid=spawn-marker][data-direction=to]')).toContain('Website');
  await page.waitFor('document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)');
  await page.evaluate('document.querySelector("[data-testid=spawn-marker][data-direction=to]").scrollIntoView({ block: "start" })');
  await page.screenshot(join(import.meta.dir, '.artifacts/thread-spawn-caller-desktop.png'));
  expect(page.errors()).toEqual([]);
}, 30_000);

test('the started thread lives in its own project and says who started it, on desktop and phone', async () => {
  await page.click('[data-testid=spawn-marker-open]');
  await page.waitFor('document.querySelector("[data-testid=spawn-marker][data-direction=from]")?.textContent.includes("Coordinate the 2.4 release")');
  expect(await page.text('[data-testid=spawn-marker][data-direction=from]')).toContain('Release desk');
  expect(await page.evaluate(`!!document.querySelector('[data-testid="thread-row"][data-thread-id="${startedId}"]')`)).toBe(true);
  expect(await page.text('[data-testid=spawn-marker][data-direction=from] ~ .bubble, [data-testid=text-part]')).toContain('Publish the 2.4 announcement on the blog');
  await page.waitFor('document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)');
  await page.evaluate('document.querySelector("[data-testid=spawn-marker][data-direction=from]").scrollIntoView({ block: "start" })');
  await page.screenshot(join(import.meta.dir, '.artifacts/thread-spawn-started-desktop.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=spawn-marker][data-direction=from]")?.getBoundingClientRect().width > 0');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('(() => { const label = document.querySelector("[data-testid=spawn-marker-open]").getBoundingClientRect(); return label.left >= 0 && label.right <= innerWidth; })()')).toBe(true);
  await page.waitFor('document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)');
  await page.evaluate('document.querySelector("[data-testid=spawn-marker][data-direction=from]").scrollIntoView({ block: "start" })');
  await page.screenshot(join(import.meta.dir, '.artifacts/thread-spawn-started-phone.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  expect(page.errors()).toEqual([]);
}, 30_000);
