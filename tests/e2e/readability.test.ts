import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui.ts';
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
  server = await startDevUi(port);
  page = await BrowserPage.launch({url:`http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`,windowSize:{width:1300,height:850}});
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
  await page.click('[data-thread-id="t-trace"]');
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('connecting another machine keeps thread rows at their single-machine height', async () => {
  await page.waitFor(`document.querySelectorAll('${id('thread-pr')}').length === 2`);
  const height = () => page.evaluate<number>(`document.querySelector('[data-thread-id="t-descriptors"]').getBoundingClientRect().height`);
  await page.evaluate(`window.__machines = globalThis.__boiteTest.workspace.machines; globalThis.__boiteTest.workspace.machines = window.__machines.slice(0, 1)`);
  let single: number;
  try {
    await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 4`);
    single = await height();
  } finally {
    await page.evaluate(`globalThis.__boiteTest.workspace.machines = window.__machines`);
  }
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 8`);
  await capture('readability-thread-density');
  expect(await height()).toBeCloseTo(single, 1);
  // In Projects the header names the machine; a row repeating it would only take room from the title.
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('thread-row')}')).every(e => !e.querySelector('.machine'))`)).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('project-row')}')).every(e => e.querySelector('${id('project-host')}[title][aria-label]'))`)).toBe(true);
  await page.click(id('view-recent'));
  await page.waitFor(`Array.from(document.querySelectorAll('${id('thread-row')}')).every(e => e.querySelector('.headline .machine[title][aria-label]'))`);
  await page.click(id('project-filter'));
  await page.evaluate(`Array.from(document.querySelectorAll('${id('project-filter-menu')} [data-value]')).find(e => e.dataset.value === JSON.stringify(['http://builder.test', 'p-notes'])).click()`);
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 1`);
  expect(await height()).toBeCloseTo(single, 1);
  await capture('readability-thread-filtered');
  await page.click(id('project-filter'));
  await page.click(`${id('project-filter-menu')} [data-value=all]`);
  await page.click(id('view-projects'));
  await page.evaluate(`globalThis.__boiteTest.workspace.active.setSidebarWidth(208)`);
  await page.waitFor(`document.querySelector('${id('sidebar')}').getBoundingClientRect().width <= 210`);
  await capture('readability-thread-narrow');
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('thread-row')} .headline')).every(e => e.scrollWidth <= e.clientWidth)`)).toBe(true);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.setSidebarWidth(280)`);
  await page.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
  await page.click(id('mobile-conversations'));
  await page.waitFor(`document.querySelector('${id('mobile-list')} .thread')`);
  await capture('readability-thread-phone');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.click(`${id('mobile-list')} .thread`);
  await page.send('Emulation.setDeviceMetricsOverride', { width:1300, height:850, deviceScaleFactor:1, mobile:false });
  await page.click('[data-thread-id="t-trace"]');
}, 30_000);

test('thread metadata, message identity and expandable trace fit a narrow panel', async () => {
  await page.waitFor(`document.querySelectorAll('${id('thread-pr')}').length === 2`);
  expect(await page.evaluate(`document.querySelector('${id('usage-pill')}') === null`)).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('.metadata')).every(e => !e.textContent.includes('No PR') && !e.textContent.includes('My computer') && !e.textContent.includes('Builder'))`)).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('thread-pr')}')).every(e => (e.closest('.thread').querySelector('.machine') || e.closest('${id('project')}')?.querySelector('${id('project-host')}')) && getComputedStyle(e).textDecorationLine.includes('underline'))`)).toBe(true);
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
  expect(await page.evaluate(`document.querySelector('${id('thinking-toggle')}').textContent`)).toContain('Thinking');
  await page.click(id('thinking-toggle'));
  await page.waitFor(`document.querySelector('${id('thinking-text')}')?.textContent.includes('Checking results')`);
  await page.click(id('thinking-toggle'));
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

test('tool activity keeps failures visible and answered questions compact at desktop and phone widths', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width:1300, height:850, deviceScaleFactor:1, mobile:false });
  await page.evaluate(`(() => { const input = document.querySelector('${id('composer-input')}'); input.value = ''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await update(`
    const turn = thread.turns[0]; turn.status = 'running'; turn.usage = null; turn.finishedAt = null; turn.startedAt = Date.now() - 120000;
    thread.status = 'running'; thread.memoryEvents = [];
    thread.messages[0].parts = [{type:'text',text:'Keep the archive branch and publish the project.'}];
    const m = thread.messages.at(-1); m.state = 'streaming';
    m.parts = [
      { type:'thinking', text:'**Inspecting project files**\\nCheck the repository before publishing.' },
      { type:'text', text:'I will keep the archived version on its branch, then publish both branches.\\n\\n' },
      { type:'tool', toolId:'readability-check', name:'exec_command', input:{cmd:'git status --short\\ngit branch -vv\\ngit remote -v'}, output:'warning: progress on stderr\\nerror: quoted documentation', status:'done', exitCode:0 },
      { type:'question', questionId:'readability-question', text:'Which remote should receive the branches?', options:[{id:'private',label:'Private repository'}], allowText:true, multiple:false, async:true, answer:{optionIds:['private'],text:'Create it on GitHub.'} },
      { type:'tool', toolId:'readability-read', name:'Read', input:{file_path:'README.md'}, output:'Project documentation', status:'done' },
      { type:'tool', toolId:'readability-failed', name:'Bash', input:{command:'git remote get-url origin'}, output:'Earlier successful output\\nerror: No such remote origin', status:'error', exitCode:128 },
      { type:'tool', toolId:'readability-failed-test', name:'Bash', input:{command:'bun test tests/e2e/example.test.ts'}, output:'bun test v1.4.2\\n(pass) first case\\n(fail) reload keeps messages\\n 1 pass\\n 1 fail', status:'error', exitCode:1 },
      { type:'tool', toolId:'readability-failed-rebase', name:'Bash', input:{command:'git rebase origin/main'}, output:'Rebasing (1/1)\\rAuto-merging docs/example.md\\nCONFLICT (content): Merge conflict in docs/example.md', status:'error', exitCode:1 },
      { type:'tool', toolId:'readability-hidden-error', name:'Bash', input:{command:'git status 2>/dev/null'}, output:'Earlier successful output', status:'error', exitCode:128 },
      { type:'tool', toolId:'readability-search', name:'Grep', input:{pattern:'repository'}, output:'README.md:3', status:'done' },
      { type:'text', text:'I will create the private repository and publish the branches.\\n\\n' },
      { type:'tool', toolId:'readability-live', name:'Bash', input:{command:'gh repo create sample-project --private --source=. --remote=origin'}, output:null, status:'running', startedAt:Date.now()-2000 }
    ];
  `);
  await page.waitFor(`document.querySelector('${id('question-card')}[data-state=answered]')`);
  await page.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await capture('activity-desktop');
  expect(await page.evaluate(`document.querySelector('${id('tool-card')} .line').textContent`)).toBe('Ran 1 command');
  expect(await page.evaluate(`document.querySelector('${id('tool-card')}[data-status=error]').getBoundingClientRect().height > 0`)).toBe(true);
  expect(await page.text(id('tool-error-preview'))).toBe('error: No such remote origin');
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('tool-error-preview')}')).map(e => e.textContent)`)).toEqual([
    'error: No such remote origin', '(fail) reload keeps messages',
    'CONFLICT (content): Merge conflict in docs/example.md',
    'Command reported failure. Expand to read the full output.'
  ]);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('tool-exit-code')}')).map(e => e.textContent)`)).toEqual(['Exit code 128', 'Exit code 1', 'Exit code 1', 'Exit code 128']);
  expect(await page.evaluate(`document.querySelector('${id('question-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
  expect(await page.evaluate(`document.querySelector('${id('tool-card')}[data-status=running] .line').textContent`)).toBe('Running gh');
  expect(await page.evaluate(`document.querySelector('${id('turn-summary')}') === null`)).toBe(true);
  for (const width of [1300,390]) {
    await page.send('Emulation.setDeviceMetricsOverride', {width,height:850,deviceScaleFactor:1,mobile:width<720});
    await page.click(id('question-toggle'));
    await page.waitFor(`document.querySelector('${id('question-toggle')}').getAttribute('aria-expanded') === 'true'`);
    expect(await page.text(id('question-text'))).toBe('Which remote should receive the branches?');
    await page.evaluate(`document.querySelector('${id('question-toggle')}').scrollIntoView({block:'center'})`);
    await capture(width<720 ? 'activity-phone-expanded' : 'activity-desktop-expanded');
    await page.click(id('question-toggle'));
    await page.waitFor(`document.querySelector('${id('question-toggle')}').getAttribute('aria-expanded') === 'false'`);
    await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop = 0`);
    await capture(width<720 ? 'activity-phone' : 'activity-desktop');
    if (width < 720) {
      await page.evaluate(`document.querySelectorAll('${id('tool-card')}[data-status=error]')[2].scrollIntoView({block:'center'})`);
      await capture('activity-phone-errors');
    }
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    const rows = await page.evaluate<number[]>(`Array.from(document.querySelectorAll('${id('question-toggle')}, ${id('tool-toggle')}, ${id('thinking-toggle')}')).filter(e=>!e.closest('[inert]')).map(e=>e.getBoundingClientRect().height)`);
    expect(rows.every(height => height >= (width<720 ? 44 : 30))).toBe(true);
  }
  await update(`thread.messages.at(-1).parts.at(-1).status = 'done';`);
  await page.waitFor(`document.querySelector('${id('turn-summary')}[data-status=running]')`);
}, 30_000);

test('in forced colors a focused text field still shows where the keyboard is', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.send('Emulation.clearDeviceMetricsOverride', {});
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  try {
    await page.navigate(`${origin}/?fake=1&open=recent`);
    await page.waitFor(`document.querySelector('${id('composer-input')}') && document.querySelector('${id('sidebar-search-open')}')`);
    // A key first, so the focus that follows reads as the keyboard's.
    const ring = async (name: string) => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      return page.evaluate<string>(`(() => {
        const element = document.querySelector('${id(name)}');
        element.focus();
        const style = getComputedStyle(element);
        return element.matches(':focus-visible') ? style.outlineStyle + ' ' + style.outlineWidth : 'not focus-visible';
      })()`);
    };
    const composer = await ring('composer-input');
    await page.click(id('sidebar-search-open'));
    await page.waitFor(`document.querySelector('${id('palette-input')}')`);
    const search = await ring('palette-input');
    await capture('readability-forced-focus');
    expect(composer).toMatch(/^solid [1-9]/);
    expect(search).toMatch(/^solid [1-9]/);
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [] });
  }
}, 30_000);

test('PR links belong to a thread branch and disappear after a move to a plain folder', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.send('Emulation.setDeviceMetricsOverride', { width:1300, height:850, deviceScaleFactor:1, mobile:false });
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 4`);
  await page.click('[data-thread-id="t-trace"]');
  await page.waitFor(`document.querySelector('.thread:has([data-thread-id="t-trace"]) ${id('thread-pr')}')`);
  await update(`
    for (const title of ['First shared-folder conversation', 'Second shared-folder conversation']) {
      await store.client.call('threads.create', { projectId: thread.projectId, providerId: thread.providerId, accountId: thread.accountId, model: thread.model, title });
    }
  `);
  await page.waitFor(`Array.from(document.querySelectorAll('${id('thread-row')}')).filter(row => row.textContent.includes('shared-folder conversation')).length === 2`);
  const sharedRowsHaveNoPr = `Array.from(document.querySelectorAll('${id('thread-row')}')).filter(row => row.textContent.includes('shared-folder conversation')).every(row => !row.closest('.thread').querySelector('${id('thread-pr')}'))`;
  expect(await page.evaluate(sharedRowsHaveNoPr)).toBe(true);
  await capture('pr-links-desktop');
  await page.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
  await page.click(id('mobile-conversations'));
  await page.waitFor(`Array.from(document.querySelectorAll('${id('mobile-list')} .thread')).filter(row => row.textContent.includes('shared-folder conversation')).length === 2`);
  expect(await page.evaluate(`document.querySelector('${id('mobile-list')}').textContent.includes('#180')`)).toBe(false);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await capture('pr-links-phone');
  await page.send('Emulation.setDeviceMetricsOverride', { width:1300, height:850, deviceScaleFactor:1, mobile:false });
  await update(`const drafts = await store.client.call('projects.drafts', {}); await store.move('t-trace', drafts.id);`);
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]') && !document.querySelector('.thread:has([data-thread-id="t-trace"]) ${id('thread-pr')}')`);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.threads.find(thread => thread.id === 't-trace').branch`)).toBeNull();
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.pullRequest', { threadId: 't-trace' })`)).toBeNull();
}, 30_000);
