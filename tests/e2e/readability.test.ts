import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
const req = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(req.resolve('vite'));
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(import.meta.dir,'.artifacts',`${name}.png`));
}
async function update(code: string) {
  await page.evaluate(`(async () => { const { workspace } = await import('/src/lib/workspace.svelte.ts'); const store = workspace.active; const thread = store.openThread; ${code} })()`);
}
beforeAll(async () => {
  const port = await freePort();
  const vite = await createServer({root:join(import.meta.dir,'../../packages/ui'),server:{host:'127.0.0.1',port,strictPort:true}});
  server = vite; await vite.listen();
  page = await BrowserPage.launch({url:`http://127.0.0.1:${port}/?fake=1&machines=1`,windowSize:{width:1300,height:850}});
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
  await page.click('[data-thread-id="t-trace"]');
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); });

test('thread metadata, message identity and expandable trace fit a narrow panel', async () => {
  await page.waitFor(`document.querySelectorAll('${id('thread-pr')}').length === 2`);
  expect(await page.evaluate(`document.querySelector('${id('usage-pill')}') === null`)).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('.metadata')).every(e => !e.textContent.includes('No PR') && !e.textContent.includes('My computer') && !e.textContent.includes('Builder'))`)).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('thread-pr')}')).every(e => e.nextElementSibling?.classList.contains('machine') && getComputedStyle(e).textDecorationLine.includes('underline'))`)).toBe(true);
  await page.evaluate(`window.__openedPr = null; window.open = (url) => { window.__openedPr = url; return null; }`);
  const prUrl = await page.evaluate<string>(`document.querySelector('${id('thread-pr')}').href`);
  await page.click(id('thread-pr'));
  expect(await page.evaluate(`window.__openedPr`)).toBe(prUrl);
  await page.click(id('panel-toggle'));
  await page.waitFor(`document.querySelector('${id('launch-trace')}') || document.querySelector('${id('trace-panel')}')`);
  await page.evaluate(`document.querySelector('${id('launch-trace')}')?.click()`);
  await page.waitFor(`document.querySelectorAll('${id('trace-row')}').length === 3`);
  await page.click(`${id('trace-row')}[data-pid="21140"] summary`);
  await capture('readability-desktop');
  expect(await page.evaluate(`document.querySelector('${id('trace-row')}[data-pid="21140"]').open`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('trace-panel')}').scrollWidth <= document.querySelector('${id('trace-panel')}').clientWidth`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('turn-summary')}').getAttribute('aria-label')`)).toBe('Done');
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await capture('readability-trace-phone');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride',{width:1300,height:850,deviceScaleFactor:1,mobile:false});
  await page.click(id('panel-toggle'));
});

test('paragraphs arrive whole, keep previous nodes and flush when stopped; reasoning replaces itself', async () => {
  await update(`const turn = thread.turns[0]; turn.status = 'running'; turn.usage = null; turn.finishedAt = null; turn.startedAt = Date.now(); thread.status = 'running'; const m = thread.messages.at(-1); m.state = 'streaming'; m.parts = [{type:'thinking',text:'**Inspecting files**'}, {type:'text',text:'First complete paragraph.\\n\\nAn unfinished'}];`);
  await page.waitFor(`document.querySelector('${id('paragraph')}')?.textContent.includes('First complete paragraph.')`);
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('An unfinished')`)).toBe(false);
  await page.evaluate(`window.__firstParagraph = document.querySelector('${id('paragraph')}')`);
  await update(`thread.messages.at(-1).parts[1].text += ' paragraph.\\n\\n'; thread.messages.at(-1).parts.push({type:'thinking',text:'**Checking results**'});`);
  await page.waitFor(`document.querySelectorAll('${id('paragraph')}').length === 2`);
  expect(await page.evaluate(`document.querySelector('${id('paragraph')}') === window.__firstParagraph`)).toBe(true);
  expect(await page.evaluate(`document.querySelectorAll('${id('thinking-part')}').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('${id('thinking-toggle')}').textContent`)).toContain('Checking results');
  await capture('readability-working');
  await update(`thread.messages.at(-1).parts.push({type:'text',text:'Last partial paragraph'});`);
  await page.waitFor(`document.querySelector('${id('turn-summary')}').dataset.status === 'running'`);
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('Last partial paragraph')`)).toBe(false);
  await update(`thread.turns[0].status = 'stopped'; thread.turns[0].finishedAt = Date.now(); thread.messages.at(-1).state = 'complete'; thread.status = 'idle';`);
  await page.waitFor(`document.querySelector('${id('timeline')}').textContent.includes('Last partial paragraph')`);
  expect(await page.evaluate(`document.querySelector('${id('turn-summary')}').getAttribute('aria-label')`)).toBe('Stopped');
});

test('goal prompts and markers stay readable and recognized commands are accented while typing', async () => {
  await update(`thread.messages[0].parts = [{type:'text',text:'Internal instructions for the agent',displayText:'/goal Verify two tasks'}]; thread.messages.at(-1).parts = [{type:'text',text:'Two tasks verified.\\n\\n[BOITE_GOAL_COMPLETE]'}]; thread.turns[0].status = 'done';`);
  await page.waitFor(`document.querySelector('.user-text .command')?.textContent === '/goal'`);
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('Internal instructions')`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('[BOITE_GOAL_COMPLETE]')`)).toBe(false);
  for (const command of ['/goal', '/loop', '/model', '/effort']) {
    await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = '${command} sample'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await page.waitFor(`document.querySelector('${id('command-highlight')}')?.textContent === '${command}'`);
  }
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = '/unknown sample'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await page.waitFor(`!document.querySelector('${id('command-highlight')}')`);
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = '/goal Verify another task'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = '/goal ' + 'Check a long prompt that wraps over several lines. '.repeat(40); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await page.waitFor(`document.querySelector('${id('composer-input')}').scrollHeight > document.querySelector('${id('composer-input')}').clientHeight`);
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.scrollTop = input.scrollHeight; input.dispatchEvent(new Event('scroll')); })()`);
  await page.waitFor(`document.querySelector('.input-mirror').style.transform === 'translateY(-' + document.querySelector('${id('composer-input')}').scrollTop + 'px)'`);
  // ResizeObserver updates the mirrored width after the textarea gains its scrollbar.
  await page.waitFor(`Math.abs(document.querySelector('.input-mirror').getBoundingClientRect().width - document.querySelector('${id('composer-input')}').clientWidth) < 1`);
  await capture('readability-composer-long');
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = '/goal Verify another task'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await capture('readability-goal');
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await capture('readability-chat-phone');
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = '/goal ' + 'Check a long prompt that wraps over several lines. '.repeat(8); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await page.waitFor(`Math.abs(document.querySelector('.input-mirror').getBoundingClientRect().width - document.querySelector('${id('composer-input')}').clientWidth) < 1`);
  const phoneText = await page.evaluate<{ inputFont: string[]; mirrorFont: string[]; inputHeight: number; mirrorHeight: number }>(`(() => {
    const input = document.querySelector('${id('composer-input')}');
    const mirror = document.querySelector('.input-mirror');
    const typography = element => {
      const style = getComputedStyle(element);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight, style.letterSpacing];
    };
    return { inputFont: typography(input), mirrorFont: typography(mirror), inputHeight: input.scrollHeight, mirrorHeight: mirror.scrollHeight };
  })()`);
  expect(phoneText.mirrorFont).toEqual(phoneText.inputFont);
  expect(Math.abs(phoneText.mirrorHeight - phoneText.inputHeight)).toBeLessThan(2);
  await capture('readability-composer-phone');
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('readability-chat-light');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
});
