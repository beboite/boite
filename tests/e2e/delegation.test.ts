import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
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
  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-surface]")');
}, 60_000);
afterAll(async () => { await page?.close(); owner?.close(); await core?.stop(); }, 30_000);

test('inspect and stop a real delegated thread from the panel, which launches nothing itself', async () => {
  // An empty conversation shows the title and nothing to fill in.
  expect(await page.evaluate('document.querySelectorAll("[data-testid=delegation-surface] :is(textarea, input, details, p)").length')).toBe(0);
  await owner.call('delegation.spawn', { threadId, profileId: 'review', task: 'Review parser boundaries [sleep:20000]', requestId: 'first-agent' });
  await page.waitFor('document.querySelector("[data-testid=active-subagents]")?.textContent.includes("1 active subagent")');
  await page.waitFor('document.querySelectorAll("[data-testid=delegation-member]").length === 1');
  const view = await owner.call('delegation.get', { threadId });
  expect(view.agents).toHaveLength(1);
  expect(view.agents[0]!.thread.parentThreadId).toBe(threadId);
  await page.click('[data-testid="panel-close"]');
  await page.waitFor('!document.querySelector("[data-testid=right-panel]")');
  expect(await page.text('[data-testid="delegation-activity"]')).toContain('Started 1 subagent');
  expect(await page.text('[data-testid="delegation-progress"]')).toContain('0/1 completed');
  expect(await page.evaluate('!!document.querySelector("[data-testid=delegation-activity] [data-testid=agent-elapsed]")')).toBe(true);
  await page.click('[data-testid="delegation-activity"]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-member]")');
  expect(await page.text('[data-testid="delegation-member"]')).toContain('echo');
  await page.click('[data-testid="delegation-member"]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-detail]")');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=delegation-surface] :is(textarea, input)").length')).toBe(0);
  await page.click('[data-testid="delegation-stop-all"]');
  await page.waitFor('!document.querySelector("[data-testid=agent-dock]")');
  expect((await owner.call('delegation.get', { threadId })).config.paused).toBe(true);
  await page.waitFor('document.querySelector("[data-testid=delegation-progress]")?.textContent.includes("1 stopped")');
  expect(await page.text('[data-testid="delegation-progress"]')).toContain('1 stopped');
  expect(await page.text('[data-testid="delegation-progress"]')).toContain('0/1 completed');
  expect(page.errors()).toEqual([]);
  await page.waitFor('document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)');
  await page.screenshot(join(import.meta.dir, '.artifacts/delegation-desktop.png'));
}, 40_000);

test('the phone can open the same team and inspect its retained result', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid="panel-close"]');
  await page.click('[data-testid="delegation-activity"]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-member]")');
  await page.click('[data-testid="delegation-member"]');
  await page.waitFor('document.querySelector("[data-testid=delegation-surface]")?.getBoundingClientRect().width > 200');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.text('[data-testid="delegation-surface"]')).toContain('Review parser boundaries');
  await page.waitFor('document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)');
  await page.screenshot(join(import.meta.dir, '.artifacts/delegation-phone.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('innerHeight === 500');
  expect(await page.evaluate('document.querySelector("[data-testid=delegation-open-thread]").getBoundingClientRect().bottom <= innerHeight')).toBe(true);
  expect(page.errors()).toEqual([]);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}, 15_000);

test('completed counts and frozen duration survive reopening the conversation', async () => {
  const view = await owner.call('delegation.get', { threadId });
  await owner.call('delegation.configure', { threadId, config: { ...view.config, paused: false } });
  await owner.call('delegation.spawn', { threadId, profileId: 'review', task: 'Check the final result', requestId: 'completed-agent' });
  await page.waitFor('document.querySelector("[data-testid=delegation-progress]")?.textContent.includes("1/2 completed")');
  await page.waitFor('!document.querySelector("[data-testid=agent-dock]")');
  const elapsed = await page.text('[data-testid="delegation-activity"] [data-testid="agent-elapsed"]');
  await page.reload();
  await page.click(`[data-testid="thread-row"][data-thread-id="${threadId}"]`);
  await page.waitFor('!!document.querySelector("[data-testid=delegation-activity]")');
  expect(await page.text('[data-testid="delegation-progress"]')).toContain('1/2 completed');
  expect(await page.text('[data-testid="delegation-progress"]')).toContain('1 stopped');
  expect(await page.text('[data-testid="delegation-activity"] [data-testid="agent-elapsed"]')).toBe(elapsed);
  expect(page.errors()).toEqual([]);
}, 15_000);

test('a newly started workflow appears above the composer without reopening the conversation', async () => {
  if (await page.evaluate('!!document.querySelector("[data-testid=panel-close]")')) await page.click('[data-testid=panel-close]');
  const run = await owner.call('workflows.start', { threadId, requestId: 'visible-workflow', plan: {
    name: 'Check the workflow indicator', steps: [{ id: 'review', profile: 'review', task: 'Review the workflow indicator [sleep:20000]' }]
  } });
  await page.waitFor('document.querySelector("[data-testid=active-subagents]")?.textContent.includes("1 workflow")');
  expect(await page.text('[data-testid="active-subagents"]')).not.toContain('active subagent');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=agent-dock] button").length')).toBe(1);
  await page.waitFor('document.getAnimations().every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)');
  await page.screenshot(join(import.meta.dir, '.artifacts/workflow-dock-desktop.png'));
  await page.click('[data-testid="active-subagents"]');
  await page.waitFor(`document.querySelector('[data-testid=delegation-run][data-run-id="${run.id}"]')`);
  expect(await page.text('[data-testid="delegation-run"]')).toContain('Check the workflow indicator');
  await page.click('[data-testid="panel-close"]');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('innerWidth === 390');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.waitFor('document.getAnimations().every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)');
  await page.screenshot(join(import.meta.dir, '.artifacts/workflow-dock-phone.png'));
  await page.click('[data-testid="active-subagents"]');
  await page.waitFor(`document.querySelector('[data-testid=delegation-run][data-run-id="${run.id}"]')`);
  await owner.call('workflows.control', { threadId, runId: run.id, action: 'stop' });
  await page.waitFor('!document.querySelector("[data-testid=agent-dock]")');
  expect(page.errors()).toEqual([]);
}, 25_000);
