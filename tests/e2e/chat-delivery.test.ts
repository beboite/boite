import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function update(code: string) {
  await page.evaluate(`(async () => { const store = globalThis.__boiteTest.workspace.active; const thread = store.openThread; ${code} })()`);
}
async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1300, height: 850 } });
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
  await page.click('[data-thread-id="t-trace"]');
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15000);

test('commands stay folded while live text remains visible during parallel activity', async () => {
  await update(`
    thread.memoryEvents = []; thread.status = 'running';
    thread.turns[0].status = 'running'; thread.turns[0].finishedAt = null;
    const message = thread.messages.at(-1); message.state = 'streaming';
    message.parts = [
      { type:'text', text:'I will check the repository.\\n\\nThis paragraph is unfinished' },
      { type:'tool', toolId:'first', name:'Bash', input:{}, inputText:'{"command":"gi', output:null, status:'running' },
      { type:'thinking', text:'Checking files' }
    ];
  `);
  // The call and the reasoning after it are one folded line that names the running call.
  await page.waitFor(`document.querySelector('${id('tool-group')}[data-live=true]')`);
  await page.evaluate(`window.__deliveryParagraph = document.querySelector('${id('paragraph')}')`);
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    expect(await page.evaluate(`document.querySelector('${id('tool-group-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
    expect(await page.evaluate(`document.querySelector('${id('tool-input')}') === null`)).toBe(true);
    expect(await page.text(id('tool-group-label'))).toBe('Running a command');
    expect(await page.text(id('paragraph-pending'))).toBe('This paragraph is unfinished');
    expect(await page.evaluate(`document.querySelector('${id('typing-indicator')}') === null`)).toBe(true);
    await capture(`chat-delivery-stream-${width < 720 ? 'phone' : 'desktop'}`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }
  await update(`thread.messages.at(-1).parts[1].inputText += 't status --short'; thread.messages.at(-1).parts[0].text += ' and still growing';`);
  expect(await page.text(id('tool-group-label'))).toBe('Running a command');
  expect(await page.text(id('paragraph-pending'))).toBe('This paragraph is unfinished and still growing');
  expect(await page.evaluate(`document.querySelector('${id('paragraph')}') === window.__deliveryParagraph`)).toBe(true);
  await update(`const message = thread.messages.at(-1); message.parts[0].text += '.\\n\\n'; message.parts[1].inputText = null; message.parts[1].input = {command:'git status --short'}; message.parts[1].status = 'done'; message.state = 'complete'; thread.status = 'idle'; thread.turns[0].status = 'done';`);
  await page.waitFor(`document.querySelectorAll('${id('paragraph')}').length === 2`);
  expect(await page.evaluate(`document.querySelector('${id('paragraph-pending')}') === null`)).toBe(true);
  expect(await page.text(id('tool-group-label'))).toBe('Ran 1 command');
});

test('a reasoning without text shows no empty fold and leaves once the agent moves on', async () => {
  await update(`
    thread.status = 'running'; thread.turns[0].status = 'running'; thread.turns[0].finishedAt = null;
    const message = thread.messages.at(-1); message.state = 'streaming';
    message.parts = [{ type:'thinking', text:'' }];
  `);
  await page.waitFor(`document.querySelector('${id('thinking-part')}')`);
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    await page.click(id('thinking-toggle'));
    expect(await page.evaluate(`document.querySelector('${id('thinking-toggle')} .caret') === null`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('${id('thinking-part')} .fold').classList.contains('open')`)).toBe(false);
    await capture(`chat-delivery-empty-thinking-${width < 720 ? 'phone' : 'desktop'}`);
  }
  await update(`thread.messages.at(-1).parts.push({ type:'tool', toolId:'second', name:'Bash', input:{command:'timeout 5 true'}, output:null, status:'running' });`);
  await page.waitFor(`!document.querySelector('${id('thinking-part')}') && document.querySelector('${id('tool-card')}')`);
  await capture('chat-delivery-empty-thinking-gone');
  await update(`const message = thread.messages.at(-1); message.parts[1].status = 'done'; message.state = 'complete'; thread.status = 'idle'; thread.turns[0].status = 'done';`);
});

test('answering the docked question shows a queued user bubble, then one sent message', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await update(`await store.client.call('turns.start', {threadId:thread.id, prompt:'Work [permission]'});`);
  await page.waitFor(`document.querySelector('${id('permission-card')}')`);
  await update(`await store.client.call('questions.ask', {threadId:thread.id, text:'Which file should be checked first?', options:['Parser','Renderer']});`);
  await page.waitFor(`document.querySelector('${id('activity-question')}')`);
  await page.click(`${id('activity-question')} ${id('question-option')}`);
  await page.click(id('composer-send'));
  await page.waitFor(`document.querySelector('${id('question-queued')}')`);
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    expect(await page.text(id('question-queued'))).toContain('> Which file should be checked first?\n\nParser');
    expect(await page.evaluate(`document.querySelector('${id('question-queued')} .queued-bubble').disabled`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('${id('question-queued')} ${id('composer-send-now')}') === null`)).toBe(true);
    await capture(`chat-delivery-answer-${width < 720 ? 'phone' : 'desktop'}`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }
  await update(`const [request] = await store.client.call('permissions.list',{threadId:thread.id}); await store.client.call('permissions.answer',{requestId:request.id,decision:'allow'});`);
  await page.waitFor(`!document.querySelector('${id('question-queued')}') && Array.from(document.querySelectorAll('[data-role=user]')).some(row => row.textContent.includes('Which file should be checked first?'))`);
  const count = await page.evaluate<number>(`Array.from(document.querySelectorAll('[data-role=user]')).filter(row => row.textContent.includes('Which file should be checked first?')).length`);
  expect(count).toBe(1);
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle'`);
  expect(page.errors()).toEqual([]);
}, 30000);

test('an edited prompt replaces the old one on screen before the core rewinds', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle'`);
  const bubbles = (text: string) => `Array.from(document.querySelectorAll('[data-role=user] ${id('text-part')}')).filter(part => part.textContent === ${JSON.stringify(text)}).length`;
  const last = `Array.from(document.querySelectorAll('[data-role=user] ${id('text-part')}')).at(-1)?.textContent`;
  await page.type(id('composer-input'), 'Edit me afterwards');
  await page.click(id('composer-send'));
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle' && ${bubbles('Edit me afterwards')} === 1 && document.querySelectorAll('${id('message-edit')}').length > 0`);
  // The rewind waits on the test: what the page shows meanwhile is the client's own doing.
  await update(`
    const client = store.client;
    globalThis.__plainCall = client.call;
    const call = client.call.bind(client);
    client.call = async (method, params) => {
      if (method === 'threads.rewind') await new Promise(resolve => { globalThis.__releaseRewind = resolve; });
      return call(method, params);
    };
  `);
  await page.evaluate(`(() => { const rows = document.querySelectorAll('${id('message')}[data-role=user]'); rows[rows.length - 1].querySelector('${id('message-edit')}').click(); return null; })()`);
  await page.waitFor(`document.querySelector('${id('composer-input')}').value === 'Edit me afterwards'`);
  await page.type(id('composer-input'), 'Edited before the core rewinds');
  await page.click(id('composer-send'));
  await page.waitFor(`${last} === 'Edited before the core rewinds' && ${bubbles('Edit me afterwards')} === 0`, 2000);
  expect(await page.evaluate(`typeof globalThis.__releaseRewind`)).toBe('function');
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('');
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    await capture(`chat-delivery-editing-${width < 720 ? 'phone' : 'desktop'}`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }
  await page.evaluate('globalThis.__releaseRewind()');
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle' && ${bubbles('Edited before the core rewinds')} === 1`);
  expect(await page.evaluate<number>(bubbles('Edit me afterwards'))).toBe(0);
  await update(`store.client.call = globalThis.__plainCall;`);
  expect(page.errors()).toEqual([]);
}, 30000);

test('a sent prompt is on screen, unticked, before the core answers, then is one message', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  // The core's answer to `turns.start` waits on the test: what the page shows meanwhile is the client's own doing.
  await update(`
    const client = store.client, call = client.call.bind(client);
    client.call = async (method, params) => {
      if (method === 'turns.start') await new Promise(resolve => { globalThis.__releaseSend = resolve; });
      return call(method, params);
    };
  `);
  const mine = `Array.from(document.querySelectorAll('${id('message')}[data-role=user]')).filter(row => row.textContent.includes('Sent before the core answers'))`;
  await page.type(id('composer-input'), 'Sent before the core answers');
  await page.click(id('composer-send'));
  await page.waitFor(`${mine}.length === 1`);
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('');
  expect(await page.evaluate(`typeof globalThis.__releaseSend`)).toBe('function');
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    expect(await page.evaluate(`${mine}[0].querySelectorAll('.tick.received').length`)).toBe(0);
    await capture(`chat-delivery-sending-${width < 720 ? 'phone' : 'desktop'}`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }
  await page.evaluate('globalThis.__releaseSend()');
  await page.waitFor(`${mine}.length === 1 && ${mine}[0].querySelectorAll('.tick.received').length > 0`);
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle'`);
  expect(await page.evaluate(`${mine}.length`)).toBe(1);
  expect(await page.evaluate(`Object.keys(globalThis.__boiteTest.workspace.active.staged).length`)).toBe(0);
  expect(page.errors()).toEqual([]);
}, 30000);
