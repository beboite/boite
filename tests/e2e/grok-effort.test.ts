import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { grokEffortOf } from '../../packages/core/src/drivers/grok.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const artifacts = process.env.BOITE_E2E_ARTIFACT_DIR ?? join(import.meta.dir, '.artifacts');
const effort = grokEffortOf({
  reasoningEffort: 'high',
  reasoningEfforts: ['xhigh', 'high', 'medium', 'low'].map(id => ({ id, label: id, default: id === 'high' })),
});

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1` });
  await page.waitFor(`document.querySelector('[data-testid=nav-settings]')`);
  // Feed the real Grok adapter's catalog into the in-memory host's UI store.
  await page.evaluate(`(async () => {
    const s = globalThis.__boiteTest.workspace.active;
    await s.probeModels('grok', 'a-grok');
    const models = [{id:'grok-4.7', name:'Grok 4.7', default:true, effort:${JSON.stringify(effort)}}];
    s.providers = s.providers.map(p => p.id === 'grok' ? {...p, models} : p);
    s.probedModels = {...s.probedModels, 'grok::a-grok':models};
    s.setModelDefault('grok', 'a-grok', 'grok-4.7', 'xhigh');
  })()`);
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-accounts]');
  await page.click('[data-provider-id=grok] [data-testid=provider-details-toggle]');
  await page.click('[data-default-provider=grok] [data-testid=composer-effort]');
  await page.waitFor(`document.querySelector('[data-testid=effort-track]')`);
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(artifacts, name));
}

test('Grok effort increases from left to right without changing the saved effort', async () => {
  await capture('grok-effort-desktop.png');
  expect(await page.evaluate(`[...document.querySelectorAll('[data-dot]')].map(dot => dot.dataset.dot)`)).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(await page.evaluate(`document.querySelector('[data-testid=effort-track]').getAttribute('aria-valuenow')`)).toBe('3');
  await page.evaluate(`document.querySelector('[data-testid=effort-track]').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))`);
  await page.waitFor(`document.querySelector('[data-testid=effort-track]')?.getAttribute('aria-valuetext') === 'Low'`);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.defaultEffortOf('grok', 'a-grok', 'grok-4.7')`)).toBe('low');
  await page.evaluate(`document.querySelector('[data-testid=effort-track]').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}))`);
  await page.waitFor(`document.querySelector('[data-testid=effort-track]')?.getAttribute('aria-valuetext') === 'Xhigh'`);
}, 30_000);

test('phone effort options keep the same ascending Grok scale', async () => {
  await page.evaluate(`(() => {
    const s = globalThis.__boiteTest.workspace.active;
    s.page = 'chat';
    s.draftChoice = {providerId:'grok', accountId:'a-grok', model:'grok-4.7', effort:'xhigh', permissionMode:'default'};
  })()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid=composer-options]');
  await page.waitFor(`document.querySelector('[name=mobile-effort]')`);
  expect(await page.evaluate(`[...document.querySelectorAll('[name=mobile-effort]')].map(input => input.value)`)).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(await page.evaluate(`document.querySelector('[name=mobile-effort]:checked').value`)).toBe('xhigh');
  await capture('grok-effort-phone.png');
}, 30_000);
