import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';

const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function size(phone: boolean) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone
  });
}
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
}
async function command(text: string) {
  await page.type(id('composer-input'), text);
  await page.evaluate(`document.querySelector('${id('composer-input')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
}
beforeAll(async () => {
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1` });
  await page.waitFor(`document.querySelector('${id('new-thread')}')`);
  await size(false);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the draft sentence follows worktree, permissions, model and effort on desktop and phone', async () => {
  await page.click(id('new-thread'));
  await page.waitFor(`document.querySelector('${id('draft-sentence')}')?.textContent.includes('Claude Opus 5')`);
  await page.click(id('composer-worktree'));
  await page.click(id('composer-mode'));
  await page.click(`${id('composer-mode-menu')} [data-value="bypassPermissions"]`);
  await page.click(id('composer-picker'));
  await page.click(`${id('composer-picker-menu')} [data-model="claude-sonnet-5"]`);
  await page.waitFor(`document.querySelector('${id('draft-sentence')}').textContent.includes('Claude Sonnet 5')`);
  await page.waitFor(`!document.querySelector('${id('composer-picker-menu')}')`);
  await page.click(id('composer-picker'));
  await page.click(`${id('composer-picker-menu')} [data-model="claude-opus-5"]`);
  await page.waitFor(`!document.querySelector('${id('composer-picker-menu')}')`);
  await page.click(id('composer-effort'));
  await page.click(`${id('composer-effort-menu')} [data-value="medium"]`);
  await page.waitFor(`document.querySelector('${id('draft-sentence')}').textContent.includes('Medium effort')`);
  await page.click(`${id('composer-effort-menu')} [data-value="high"]`);
  await page.evaluate(`document.querySelector('${id('composer-effort-menu')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await page.waitFor(`!document.querySelector('${id('composer-effort-menu')}')`);
  const sentence = await page.evaluate<string>(`document.querySelector('${id('draft-sentence')}').textContent`);
  expect(sentence).toContain('in a worktree');
  expect(sentence).toContain('with all permissions');
  expect(sentence).toContain('Claude Opus 5');
  expect(sentence).toContain('High effort');
  await capture('composer-draft-desktop');
  await size(true);
  await capture('composer-draft-phone');
  await page.click(id('composer-worktree'));
  expect(await page.evaluate(`document.querySelector('${id('draft-sentence')}').textContent`)).not.toContain('in a worktree');
  await size(false);
}, 30_000);

test('default models can be changed in General on desktop and phone', async () => {
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-general'));
  await page.waitFor(`document.querySelector('${id('model-defaults-settings')}')`);
  expect(await page.evaluate(`document.querySelector('[data-default-provider="codex"]').textContent`)).toContain('GPT 5.6 Sol');
  expect(await page.evaluate(`document.querySelector('[data-default-provider="codex"]').textContent`)).toContain('medium');
  expect(await page.evaluate(`document.querySelector('[data-default-provider="grok"]').textContent`)).toContain('Grok 4.6');
  expect(await page.evaluate(`document.querySelector('[data-default-provider="grok"]').textContent`)).toContain('high');
  const row = '[data-default-provider="claude"]';
  await page.click(`${row} ${id('composer-picker')}`);
  await page.click(`${id('composer-picker-menu')} [data-model="claude-sonnet-5"]`);
  await page.waitFor(`document.querySelector('${row} ${id('composer-picker')}').textContent.includes('Sonnet 5')`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.model-defaults:v1')).claude.model`)).toBe('claude-sonnet-5');
  await page.waitFor(`!document.querySelector('${id('composer-picker-menu')}')`);
  await page.click(`${row} ${id('composer-picker')}`);
  await page.click(`${id('composer-picker-menu')} [data-model="claude-opus-5"]`);
  await capture('model-defaults-desktop');
  await size(true);
  await capture('model-defaults-phone');
  await size(false);
  await page.click(id('settings-back'));
}, 30_000);

test('goal and loop commands share the activity panel with disclosed tasks and reversible controls', async () => {
  await command('/goal Review the queued prompts and verify every interaction');
  await page.waitFor(`document.querySelector('${id('activity-goal')}')`);
  await page.waitFor(`document.querySelector('.user-text .command')?.textContent === '/goal'`);
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('Continue until the objective')`)).toBe(false);
  await page.click(`${id('activity-goal')} [aria-label="Pause"]`);
  await page.waitFor(`document.querySelector('${id('activity-goal')}').textContent.includes('Paused')`);
  await page.waitFor(`!document.querySelector('${id('composer-stop')}')`);
  await page.click(`${id('activity-goal')} [aria-label="Resume"]`);
  await page.waitFor(`document.querySelector('${id('activity-goal')} [aria-label="Pause"]')`);
  await page.click(`${id('activity-goal')} [aria-label="Pause"]`);
  await page.waitFor(`!document.querySelector('${id('composer-stop')}')`);
  await command('/loop 5m Check the build and report failures');
  await page.waitFor(`document.querySelector('${id('activity-loop')}')`);
  await page.click(`${id('activity-loop')} [aria-label="Pause"]`);
  await page.waitFor(`document.querySelector('${id('activity-loop')}').textContent.includes('Paused')`);
  await page.click(`${id('activity-loop')} [aria-label="Resume"]`);
  await page.waitFor(`document.querySelector('${id('activity-loop')} [aria-label="Pause"]')`);
  await page.click(`${id('activity-loop')} [aria-label="Pause"]`);
  await page.waitFor(`!document.querySelector('${id('composer-stop')}')`);
  // Only the agent-owned task fixture enters through the dev module. Commands and controls use the UI.
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity.tasks = [
    {id:'check-input',text:'Check queued input and attachments',status:'completed'},
    {id:'test-stop',text:'Verify Escape sends queued prompts',status:'in_progress'},
    {id:'capture-phone',text:'Capture the phone layout',status:'pending'}
  ]; })`);
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}')`);
  await page.evaluate(`document.querySelector('${id('thread-activity')}').dispatchEvent(new PointerEvent('pointerenter'))`);
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'true'`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('.activity-action')).every(button => button.getBoundingClientRect().width >= 36 && button.getBoundingClientRect().height >= 36)`)).toBe(true);
  await capture('composer-activity-desktop');
  await page.evaluate(`document.querySelector('${id('thread-activity')}').dispatchEvent(new PointerEvent('pointerleave'))`);
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'false'`);
  await size(true);
  await page.click(id('activity-tasks-toggle'));
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'true'`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('.activity-action')).every(button => button.getBoundingClientRect().width >= 40 && button.getBoundingClientRect().height >= 40)`)).toBe(true);
  await capture('composer-activity-phone');
  await page.click(`${id('activity-goal')} [aria-label="Remove"]`);
  await page.waitFor(`!document.querySelector('${id('activity-goal')}')`);
  await page.click(`${id('activity-loop')} [aria-label="Remove"]`);
  await page.waitFor(`!document.querySelector('${id('activity-loop')}')`);
}, 30_000);
