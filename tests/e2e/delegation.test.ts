import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG } from '../../packages/contracts/src/index.ts';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

let core: RunningCore;
let page: BrowserPage;
let owner: CoreClient;
let threadId: string;
beforeAll(async () => {
  core = await startCore(); owner = await connect(core.url, core.token);
  const project = await owner.call('projects.add', { path: core.dataDir, name: 'Delegation checks' });
  const account = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const thread = await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, model: 'echo', title: 'Coordinate parser review' });
  threadId = thread.id;
  await owner.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'review', name: 'Reviewer', providerId: 'echo', accountId: account.id, model: 'echo', effort: null }] } });
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await page.click(`[data-testid="thread-row"][data-thread-id="${threadId}"]`);
  await page.click('[data-testid="agents-toggle"]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-launch]")');
}, 60_000);
afterAll(async () => { await page?.close(); owner?.close(); await core?.stop(); }, 30_000);

test('launch, inspect, forward and stop a real delegated thread from the panel', async () => {
  await page.type('[data-testid="delegation-task"]', 'Review parser boundaries [sleep:20000]');
  await page.click('[data-testid="delegation-spawn"]');
  await page.waitFor('document.querySelectorAll("[data-testid=agent-dock-member]").length === 1');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-detail]")');
  const view = await owner.call('delegation.get', { threadId });
  expect(view.agents).toHaveLength(1);
  expect(view.agents[0]!.thread.parentThreadId).toBe(threadId);
  await page.type('[data-testid="delegation-message"]', 'Report only file names');
  await page.evaluate('document.querySelector("[data-testid=delegation-message]").closest("form").requestSubmit()');
  await page.waitFor('document.querySelector("[data-testid=delegation-surface]")?.textContent.includes("Report only file names")');
  const sent = await owner.call('delegation.get', { threadId });
  expect(sent.messages.find(m => m.text === 'Report only file names')?.origin).toBe('user');
  await page.click('[data-testid="delegation-stop-all"]');
  await page.waitFor('!document.querySelector("[data-testid=agent-dock]")');
  expect((await owner.call('delegation.get', { threadId })).config.paused).toBe(true);
  expect(page.errors()).toEqual([]);
}, 40_000);

test('the phone can open the same team and inspect its retained result', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=delegation-surface]")?.getBoundingClientRect().width > 200');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.text('[data-testid="delegation-surface"]')).toContain('Review parser boundaries');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('innerHeight === 500');
  expect(await page.evaluate('document.querySelector("[data-testid=delegation-message]").getBoundingClientRect().bottom <= innerHeight')).toBe(true);
  expect(page.errors()).toEqual([]);
}, 15_000);
