import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '../../packages/contracts/src/index.ts';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

const RULES = 'Review as a stranger: no house style.';
let core: RunningCore;
let page: BrowserPage;
let owner: CoreClient;
let threadId: string;

const settledAnimations = 'document.getAnimations().every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)';

beforeAll(async () => {
  core = await startCore(); owner = await connect(core.url, core.token);
  const project = await owner.call('projects.add', { path: core.dataDir, name: 'Context modes' });
  const account = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const thread = await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, model: 'echo', title: 'Benchmark the parser' });
  threadId = thread.id;
  await owner.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await page.click(`[data-testid="thread-row"][data-thread-id="${threadId}"]`);
}, 60_000);
afterAll(async () => { await page?.close(); owner?.close(); await core?.stop(); }, 30_000);

test('an agent starts a light child with rules through the CLI, and the list and its conversation say so', async () => {
  // The parent's agent runs the real `boite` command, the way a model would from its shell.
  const done = owner.next('turn.finished', turn => turn.threadId === threadId, 30_000);
  await owner.call('threads.subscribe', { threadId });
  await owner.call('turns.start', { threadId, prompt: `[spawn:boite delegate spawn "Count the parser lines" --context light --rules "${RULES}" --title "Light count"] [spawn:boite delegate spawn "Count again" --title "Plain count"]` });
  expect((await done).status).toBe('done');
  const view = await owner.call('delegation.get', { threadId });
  const light = view.agents.find(agent => agent.thread.title === 'Light count')!;
  const plain = view.agents.find(agent => agent.thread.title === 'Plain count')!;
  expect(light.thread.contextMode).toMatchObject({ label: 'light', guides: false, rules: RULES });
  expect(plain.thread.contextMode).toBeUndefined();

  // The echo child answers with what it was given: the rules first, no team guide.
  await owner.call('delegation.wait', { threadId, timeoutMs: 15_000 });
  const lightText = (await owner.call('threads.get', { threadId: light.thread.id })).messages.filter(m => m.role === 'assistant').flatMap(m => m.parts).map(p => p.type === 'text' ? p.text : '').join('');
  expect(lightText).toContain(`Rules for this conversation`);
  expect(lightText).toContain(RULES);
  expect(lightText).not.toContain('You are a Boite subagent of');
  const plainText = (await owner.call('threads.get', { threadId: plain.thread.id })).messages.filter(m => m.role === 'assistant').flatMap(m => m.parts).map(p => p.type === 'text' ? p.text : '').join('');
  expect(plainText).toContain('You are a Boite subagent of');

  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('document.querySelectorAll("[data-testid=delegation-member]").length === 2');
  const badges = await page.evaluate(`[...document.querySelectorAll('[data-testid=delegation-member]')].map(row => [row.querySelector('.title')?.textContent.trim(), row.querySelector('[data-testid=delegation-member-context]')?.dataset.mode ?? null, row.querySelector('[data-testid=delegation-member-context]')?.textContent.trim() ?? null])`) as [string, string | null, string | null][];
  expect(badges).toContainEqual(['Light count', 'light', 'Light + rules']);
  expect(badges).toContainEqual(['Plain count', null, null]);
  expect(await page.evaluate(`document.querySelector('[data-testid=delegation-member-context]').title`)).toContain('Started without: instruction files, Boite and brain guides, MCP servers.');
  await page.waitFor(settledAnimations);
  await page.screenshot(join(import.meta.dir, '.artifacts/context-mode-subagents-desktop.png'));

  // Its own conversation carries the same badge in the header.
  await page.evaluate(`[...document.querySelectorAll('[data-testid=delegation-member]')].find(row => row.textContent.includes('Light count')).click()`);
  await page.click('[data-testid="delegation-open-thread"]');
  await page.waitFor('!!document.querySelector("[data-testid=thread-context-mode]")');
  expect(await page.evaluate('document.querySelector("[data-testid=thread-context-mode]").dataset.mode')).toBe('light');
  expect(await page.evaluate('document.querySelector("[data-testid=thread-context-mode]").title')).toContain(`Its rules: ${RULES}`);
  await page.waitFor(settledAnimations);
  await page.screenshot(join(import.meta.dir, '.artifacts/context-mode-thread-desktop.png'));
  expect(page.errors()).toEqual([]);
}, 60_000);

test('the phone shows the badge in the child header and the Subagents list without overflowing', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('innerWidth === 390');
  await page.waitFor('!!document.querySelector("[data-testid=thread-context-mode]")');
  const chip = await page.evaluate('(() => { const r = document.querySelector("[data-testid=thread-context-mode]").getBoundingClientRect(); return { width: r.width, right: r.right, visible: r.width > 0 && r.height > 0 }; })()') as { width: number; right: number; visible: boolean };
  expect(chip.visible).toBe(true);
  expect(chip.right).toBeLessThanOrEqual(390);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.waitFor(settledAnimations);
  await page.screenshot(join(import.meta.dir, '.artifacts/context-mode-thread-phone.png'));
  await page.evaluate(`document.querySelector('[data-testid=delegation-back-parent]').click()`);
  await page.waitFor(`!document.querySelector("[data-testid=thread-context-mode]")`);
  await page.click('[data-testid="delegation-activity"]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-member-context]")');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.waitFor(settledAnimations);
  await page.screenshot(join(import.meta.dir, '.artifacts/context-mode-subagents-phone.png'));
  expect(page.errors()).toEqual([]);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}, 30_000);
