import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
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
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('${id('new-thread')}')`);
  await size(false);
}, 60_000);

test('commands are colored with aligned wrapping and three permission choices', async () => {
  for (const phone of [false, true]) {
    await size(phone);
    const prompt = '/loop 2 Check the queued prompts and verify every interaction. '.repeat(2) + '\n' + 'A long follow-up line. '.repeat(45);
    await page.type(id('composer-input'), prompt);
    await page.waitFor(`document.querySelector('${id('composer-highlight')} .command-token')?.textContent === '/loop'`);
    expect(await page.evaluate(`(() => { const field = document.querySelector('${id('composer-input')}'); const paint = document.querySelector('.input-paint'); return Math.abs(field.clientWidth - paint.getBoundingClientRect().width) < 1 && getComputedStyle(field).lineHeight === getComputedStyle(paint).lineHeight; })()`)).toBe(true);
    await page.evaluate(`document.querySelector('${id('composer-input')}').scrollTop = 60`);
    await page.waitFor(`(() => { const field = document.querySelector('${id('composer-input')}'); return field.scrollTop > 0 && Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.input-paint')).transform).m42 + field.scrollTop) < 1; })()`);
    await capture(phone ? 'commands-scroll-phone' : 'commands-scroll-desktop');
    await page.type(id('composer-input'), '/goal Verify the composer');
    await page.click(id('composer-mode'));
    await page.waitFor(`document.querySelector('${id('composer-mode-menu')}')`);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('composer-mode-menu')} .label')).map(el => el.textContent.trim())`)).toEqual(['Auto', 'Edit freely', 'Ask']);
    expect(await page.evaluate(`(() => { const r=document.querySelector('${id('composer-mode-menu')}').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`)).toBe(true);
    await capture(phone ? 'commands-permissions-phone' : 'commands-permissions-desktop');
    await page.evaluate(`document.querySelector('${id('composer-mode-menu')}').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await page.waitFor(`!document.querySelector('${id('composer-mode-menu')}')`);
    await page.type(id('composer-input'), '/unknown');
    await page.waitFor(`!document.querySelector('${id('composer-highlight')}')`);
  }
  await page.type(id('composer-input'), '');
  for (const [mode, label] of [['plan', 'Plan'], ['dontAsk', 'Auto-deny']]) {
    await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.permissionMode = '${mode}'; })`);
    await page.waitFor(`document.querySelector('${id('composer-mode')}').textContent.trim() === '${label}'`);
    await page.click(id('composer-mode'));
    await page.waitFor(`document.querySelector('${id('composer-mode-menu')}')`);
    expect(await page.evaluate(`document.querySelectorAll('${id('composer-mode-menu')} [data-row]').length`)).toBe(3);
    expect(await page.evaluate(`document.querySelectorAll('${id('composer-mode-menu')} .active').length`)).toBe(0);
    await page.evaluate(`document.querySelector('${id('composer-mode-menu')}').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await page.waitFor(`!document.querySelector('${id('composer-mode-menu')}')`);
  }
  await size(false);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the draft sentence follows worktree, permissions, model and effort on desktop and phone', async () => {
  await page.click(id('new-thread'));
  await page.waitFor(`document.querySelector('${id('draft-sentence')}')?.textContent.includes('Opus 5')`);
  await page.click(id('composer-worktree'));
  await page.click(id('composer-mode'));
  await page.click(`${id('composer-mode-menu')} [data-value="bypassPermissions"]`);
  await page.click(id('composer-picker'));
  await page.click(`${id('composer-picker-menu')} [data-model="claude-sonnet-5"]`);
  await page.waitFor(`document.querySelector('${id('draft-sentence')}').textContent.includes('Sonnet 5')`);
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
  expect(sentence).toContain('Opus 5');
  expect(sentence).toContain('High effort');
  await capture('composer-draft-desktop');
  await size(true);
  await capture('composer-draft-phone');
  await page.click(id('composer-worktree'));
  expect(await page.evaluate(`document.querySelector('${id('draft-sentence')}').textContent`)).not.toContain('in a worktree');
  await size(false);
}, 30_000);

test('default models can be changed on each provider row in Providers', async () => {
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-accounts'));
  // Each connected provider keeps its default model behind its row's chevron.
  for (const provider of ['claude', 'codex', 'grok']) {
    const toggle = `${id('provider-settings')}[data-provider-id="${provider}"] ${id('provider-details-toggle')}`;
    await page.click(toggle);
    await page.waitFor(`document.querySelector('[data-default-provider="${provider}"]')`);
  }
  expect(await page.evaluate(`document.querySelector('${id('model-defaults-settings')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-default-provider="codex"]').textContent`)).toContain('GPT 5.6 Sol');
  expect(await page.evaluate(`document.querySelector('[data-default-provider="codex"]').textContent`)).toContain('medium');
  expect(await page.evaluate(`document.querySelector('[data-default-provider="grok"]').textContent`)).toContain('Grok 4.6');
  expect(await page.evaluate(`document.querySelector('[data-default-provider="grok"]').textContent`)).toContain('high');
  const row = '[data-default-provider="claude"]';
  await page.click(`${row} ${id('composer-picker')}`);
  // A provider's default is one of its own models: the picker opens on them, with no other provider to switch to.
  await page.waitFor(`document.querySelector('${id('composer-picker-menu')} [data-model]')`);
  expect(await page.evaluate(`document.querySelector('${id('composer-picker-menu')} .rail') === null`)).toBe(true);
  expect(await page.evaluate(`[...document.querySelectorAll('${id('composer-picker-menu')} [data-model]')].every(entry => entry.dataset.model.startsWith('claude-'))`)).toBe(true);
  // With no composer around it, the menu opens under its own button.
  expect(await page.evaluate(`document.querySelector('${id('composer-picker-menu')}').getBoundingClientRect().top >= document.querySelector('${row} ${id('composer-picker')}').getBoundingClientRect().bottom`)).toBe(true);
  await capture('model-default-single');
  await page.click(`${id('composer-picker-menu')} [data-model="claude-sonnet-5"]`);
  await page.waitFor(`document.querySelector('${row} ${id('composer-picker')}').textContent.includes('Sonnet 5')`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.model-defaults:v1')).claude.model`)).toBe('claude-sonnet-5');
  await page.waitFor(`!document.querySelector('${id('composer-picker-menu')}')`);
  await page.click(`${row} ${id('composer-picker')}`);
  await page.click(`${id('composer-picker-menu')} [data-model="claude-opus-5"]`);
  await capture('model-defaults-desktop');
  // Put the rows back the way the page opens, for the tests that follow.
  for (const provider of ['claude', 'codex', 'grok']) await page.click(`${id('provider-settings')}[data-provider-id="${provider}"] ${id('provider-details-toggle')}`);
  await page.click(id('settings-back'));
}, 30_000);

test('tasks stay folded until requested and never move the reading position', async () => {
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({store}) => { await store.open('t-trace'); })`);
  await page.waitFor(`document.querySelector('${id('timeline')}')`);
  // History navigation requires overflow: a short thread at scrollTop 0 is still pinned.
  await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread.messages.at(-1).parts.push({ type: 'text', text: 'Earlier conversation context.\\n'.repeat(80) })`);
  // Opening the thread schedules layout measurements and scroll restoration.
  // Finish those before choosing the reading position this test must preserve.
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop = 0`);
  await page.waitFor(`document.querySelector('[data-testid="jump-to-latest"]')`);
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const before = await page.evaluate<{ top: number; height: number; scroll: number }>(`(() => { const el = document.querySelector('${id('timeline')}'); const r = el.getBoundingClientRect(); return {top:r.top,height:r.height,scroll:el.scrollTop}; })()`);
  expect(before.scroll).toBe(0);
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity = {goal:{objective:'Verify queued prompts',status:'paused',iterations:1,error:null},loop:null,tasks:[
    {id:'check-input',text:'Check queued input and attachments',status:'completed'},
    {id:'test-stop',text:'Verify Escape sends queued prompts',status:'in_progress'},
    {id:'capture-phone',text:'Capture the phone layout',status:'pending'}
  ]}; })`);
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}')`);
  expect(await page.evaluate(`(() => { const panel = document.querySelector('${id('thread-activity')}').getBoundingClientRect(); const composer = document.querySelector('.composer').getBoundingClientRect(); return composer.top - panel.bottom; })()`)).toBeLessThanOrEqual(4);
  await page.evaluate(`document.querySelector('${id('thread-activity')}').dispatchEvent(new PointerEvent('pointerenter'))`);
  expect(await page.evaluate(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
  expect(await page.evaluate(`document.querySelector('${id('activity-tasks-toggle')}').textContent`)).toContain('Verify Escape sends queued prompts');
  expect(await page.evaluate(`document.querySelector('${id('thread-activity')} progress').value`)).toBe(1);
  await capture('composer-activity-desktop');
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity.tasks[1].status = 'completed'; store.openThread.activity.tasks[2].status = 'in_progress'; })`);
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}').textContent.includes('Capture the phone layout')`);
  await page.click(id('activity-tasks-toggle'));
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'true'`);
  await capture('composer-activity-expanded-desktop');
  expect(await page.evaluate(`(() => { const el = document.querySelector('${id('timeline')}'); const r = el.getBoundingClientRect(); return {top:r.top,height:r.height,scroll:el.scrollTop}; })()`)).toEqual(before);
  await size(true);
  await capture('composer-activity-phone');
  await page.click(id('activity-tasks-toggle'));
  await capture('composer-activity-collapsed-phone');
  await size(false);
}, 30_000);

test('counted loops finish after two iterations and disclose the results', async () => {
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity = null; })`);
  await command('/loop 2 pong');
  await page.waitFor(`document.querySelector('${id('activity-loop')}')?.textContent.includes('Complete')`);
  expect(await page.evaluate(`document.querySelector('${id('activity-loop')}').textContent`)).toContain('Iteration 2 of 2');
  expect(await page.evaluate(`document.querySelector('${id('thread-activity')}').textContent`)).not.toContain('Every');
  await page.click(id('activity-tasks-toggle'));
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'true'`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('thread-activity')} .history li p')).map(el => el.textContent)`)).toEqual(['pong', 'pong']);
  await capture('loop-results-desktop');
  await size(true);
  await capture('loop-results-phone');
  await page.click(`${id('activity-loop')} [aria-label="Remove"]`);
  await page.waitFor(`!document.querySelector('${id('activity-loop')}')`);
  await size(false);
}, 30_000);

test('completed goals and tasks fade after the next prompt and new tasks return', async () => {
  await command('/goal Verify the latest UI');
  await page.waitFor(`document.querySelector('${id('activity-goal')}')?.textContent.includes('Complete')`);
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity.tasks = [{id:'checked',text:'Verify the latest UI',status:'completed'}]; })`);
  await page.waitFor(`document.querySelector('${id('thread-activity')} progress')?.value === 1`);
  expect(await page.evaluate(`document.querySelector('${id('activity-goal')}').textContent.split('Verify the latest UI').length - 1`)).toBe(1);
  await capture('goal-complete-desktop');
  await command('Thanks, continue with the next change');
  await page.waitFor(`document.querySelector('${id('thread-activity')}').classList.contains('hidden')`);
  await capture('goal-dismissed-desktop');
  // The final thread update must arrive before replacing its tasks in the fixture.
  await page.waitFor(`!document.querySelector('${id('composer-stop')}')`);
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity.tasks = [{id:'new-work',text:'Check the next change',status:'in_progress'}]; store.openThread.activity.tasksDismissed = false; })`);
  await page.waitFor(`!document.querySelector('${id('thread-activity')}').classList.contains('hidden')`);
  if (await page.evaluate(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'true'`)) await page.click(id('activity-tasks-toggle'));
  await page.waitFor(`!document.querySelector('${id('composer-stop')}')`);
  await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop = document.querySelector('${id('timeline')}').scrollHeight`);
  await capture('tasks-returned-desktop');
  for (const phone of [false, true]) {
    await size(phone);
    await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop = document.querySelector('${id('timeline')}').scrollHeight`);
    await capture(phone ? 'tasks-latest-visible-phone' : 'tasks-latest-visible-desktop');
    expect(await page.evaluate(`(() => { const messages = document.querySelectorAll('[data-mid]'); const last = messages[messages.length-1].getBoundingClientRect(); const activity = document.querySelector('${id('thread-activity')}').getBoundingClientRect(); return last.bottom <= activity.top; })()`)).toBe(true);
  }
}, 30_000);

test('a question open in the dock keeps the last answer readable above it', async () => {
  await size(false);
  await command('Pick one [ask] for me');
  await page.waitFor(`document.querySelector('${id('activity-question')}:not([hidden])')`);
  await page.waitFor(`!document.querySelector('${id('composer-stop')}')`);
  const lastAboveDock = `(() => { const messages = document.querySelectorAll('[data-mid]'); const last = messages[messages.length-1].getBoundingClientRect(); const activity = document.querySelector('${id('thread-activity')}').getBoundingClientRect(); return last.bottom <= activity.top; })()`;
  for (const phone of [false, true]) {
    await size(phone);
    await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop = document.querySelector('${id('timeline')}').scrollHeight`);
    await capture(phone ? 'question-dock-latest-phone' : 'question-dock-latest-desktop');
    expect(await page.evaluate(lastAboveDock)).toBe(true);
  }
  await size(false);
}, 30_000);
