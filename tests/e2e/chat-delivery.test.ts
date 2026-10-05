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

test('commands stay folded and parallel activity cannot reveal an unfinished paragraph', async () => {
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
  await page.waitFor(`document.querySelector('${id('tool-card')}[data-streaming=true]')`);
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    expect(await page.evaluate(`document.querySelector('${id('tool-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
    expect(await page.evaluate(`document.querySelector('${id('tool-input')}') === null`)).toBe(true);
    expect(await page.text(`${id('tool-card')} .line`)).toBe('Running a command');
    expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('unfinished')`)).toBe(false);
    await capture(`chat-delivery-stream-${width < 720 ? 'phone' : 'desktop'}`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }
  await update(`thread.messages.at(-1).parts[1].inputText += 't status --short'; thread.messages.at(-1).parts[0].text += ' and still growing';`);
  expect(await page.text(`${id('tool-card')} .line`)).toBe('Running a command');
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').textContent.includes('unfinished')`)).toBe(false);
  await update(`const message = thread.messages.at(-1); message.parts[0].text += '.\\n\\n'; message.parts[1].inputText = null; message.parts[1].input = {command:'git status --short'}; message.parts[1].status = 'done'; message.state = 'complete'; thread.status = 'idle'; thread.turns[0].status = 'done';`);
  await page.waitFor(`document.querySelectorAll('${id('paragraph')}').length === 2`);
  expect(await page.text(`${id('tool-card')} .line`)).toBe('Ran 1 command');
});

test('answering the docked question shows a queued user bubble, then one sent message', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await update(`await store.client.call('turns.start', {threadId:thread.id, prompt:'Work [permission]'});`);
  await page.waitFor(`document.querySelector('${id('permission-card')}')`);
  await update(`await store.client.call('questions.ask', {threadId:thread.id, text:'Which file should be checked first?', options:['Parser','Renderer']});`);
  await page.waitFor(`document.querySelector('${id('activity-question')}')`);
  await page.click(`${id('activity-question')} ${id('question-option')}`);
  await page.click(`${id('activity-question')} ${id('question-submit')}`);
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

test('a sent or edited prompt shows at once while the core has not answered', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle'`);
  // Every turns.start and threads.rewind waits until the test lets it through.
  const hold = () => update(`
    const client = store.client;
    globalThis.__call ??= client.call.bind(client);
    globalThis.__gate = new Promise(resolve => { globalThis.__open = resolve; });
    client.call = async (method, params) => {
      if (method === 'turns.start' || method === 'threads.rewind') await globalThis.__gate;
      return globalThis.__call(method, params);
    };
  `);
  const bubbles = (text: string) => `Array.from(document.querySelectorAll('[data-role=user] [data-testid=text-part]')).filter(part => part.textContent === ${JSON.stringify(text)}).length`;
  const last = `Array.from(document.querySelectorAll('[data-role=user] [data-testid=text-part]')).at(-1)?.textContent`;

  await hold();
  await page.type(id('composer-input'), 'Show this before the core answers');
  await page.click(id('composer-send'));
  await page.waitFor(`${last} === 'Show this before the core answers'`, 2000);
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('');
    expect(await page.evaluate(`document.querySelector('[data-role=user]:last-of-type ${id('receipt-accepted')}')?.classList.contains('received') ?? false`)).toBe(false);
    await capture(`chat-delivery-sending-${width < 720 ? 'phone' : 'desktop'}`);
  }
  await page.evaluate('globalThis.__open()');
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle' && ${bubbles('Show this before the core answers')} === 1`);
  expect(await page.evaluate<number>(bubbles('Show this before the core answers'))).toBe(1);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await hold();
  await page.evaluate(`(() => { const rows = document.querySelectorAll('[data-role=user]'); rows[rows.length - 1].querySelector('${id('message-edit')}').click(); return null; })()`);
  await page.waitFor(`document.querySelector('${id('composer-input')}').value === 'Show this before the core answers'`);
  await page.type(id('composer-input'), 'Edited before the core rewinds');
  await page.click(id('composer-send'));
  await page.waitFor(`${last} === 'Edited before the core rewinds' && ${bubbles('Show this before the core answers')} === 0`, 2000);
  for (const width of [1300, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 720 });
    await capture(`chat-delivery-editing-${width < 720 ? 'phone' : 'desktop'}`);
  }
  await page.evaluate('globalThis.__open()');
  await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread.status === 'idle' && ${bubbles('Edited before the core rewinds')} === 1`);
  expect(await page.evaluate<number>(bubbles('Show this before the core answers'))).toBe(0);
  await update(`store.client.call = globalThis.__call;`);
  expect(page.errors()).toEqual([]);
}, 45000);
