import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let page: BrowserPage;
let server: { close(): Promise<void> };
beforeAll(async () => {
  const port = await freePort();
  // This scenario imports the real view and fake repository to seed retained history.
  server = await startUi(port, { development: true });
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, experiments: ['resident-agents'] });
  await page.waitFor(`window.__boiteTest?.workspace.active.connection === 'ready'`);
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 60_000);

const box = `document.querySelector('.agent-chat-scroll')`;
const firstVisible = `(() => { const box = ${box}; const top = box.getBoundingClientRect().top; return [...box.querySelectorAll('[data-message-id]')].find(m => m.getBoundingClientRect().bottom > top)?.dataset.messageId; })()`;

test('missed messages open at their first unread reply, stay unread off screen and survive a return visit', async () => {
  await page.evaluate(`(async () => {
    const { FakeAgents } = await import('/src/lib/fake-agents.ts');
    const { AgentsView } = await import('/src/lib/agents.svelte.ts');
    const store = window.__boiteTest.workspace.active;
    const view = AgentsView.of(store);
    const fake = new FakeAgents(() => { void view.refresh(); });
    const account = store.accounts.find(a => a.providerId === 'echo');
    const profile = name => fake.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
    const mira = profile('Mira'), atlas = profile('Atlas');
    const scope = { kind: 'agent', id: mira.id };
    const group = fake.call('agents.group.save', { value: { name: 'Studio', memberIds: [mira.id, atlas.id], mode: 'round', maxTurns: 3, maxTurnsPerAgent: 2, paused: false } });
    const start = Date.now() - 3600000;
    const add = (id, scope, senderId, at, text) => {
      const m = fake.save('message', { value: { scope, senderId, text, recipientIds: [], replyTo: null, episodeId: 'reading', sourceRunId: null } });
      fake.rows.delete('message:' + m.id);
      fake.rows.set('message:' + id, { ...m, id, createdAt: at, updatedAt: at });
    };
    for (let i = 0; i < 850; i++) add('reply-' + i, scope, mira.id, start + i * 1000, 'Update ' + (i + 1) + '\\n\\nThe preview is ready. The conversation keeps your reading position so you can catch up in order.');
    for (let i = 0; i < 3; i++) add('group-' + i, { kind: 'group', id: group.id }, atlas.id, start + i * 1000, 'Studio update ' + (i + 1) + '\\n\\n' + 'The team has reviewed the next changes. '.repeat(40));
    fake.save('work', { value: { agentId: atlas.id, scope: { kind: 'agent', id: atlas.id }, taskId: null, taskGeneration: null, messageId: null, episodeId: 'old-error', prompt: 'A previous task', status: 'interrupted', error: 'Stopped earlier', runId: null, notBefore: 0 } });
    const calls = [];
    const c = store.client, call = c.call.bind(c);
    c.call = (method, params, ...rest) => method.startsWith('agents.') ? (['agents.history', 'agents.messages'].includes(method) && calls.push(method), Promise.resolve(fake.call(method, params))) : call(method, params, ...rest);
    await view.refresh();
    view.markRead('profile:' + mira.id, start + 9000);
    window.__reading = { view, fake, add, mira, atlas, group, scope, start, calls };
    store.showAgents(atlas.id);
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"] [data-testid="agent-unread-count"]')?.textContent === '840'`);
  await page.waitFor(`document.querySelector('.agent-chat') && !document.querySelector('.agent-reading-status')`);
  expect(await page.evaluate(`document.querySelector('.agents-rail').textContent.includes('Needs you')`)).toBe(false);
  expect(await page.evaluate(`!!document.querySelector('.agent-chat [data-testid="composer-picker"]')`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-unread-count"]')?.getAttribute('role')`)).toBe('img');
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-missed-list-desktop.png'));

  await page.evaluate(`window.__reading.calls.length = 0; document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-unread-divider"]')?.textContent.includes('840 missed messages') && !document.querySelector('.agent-reading-status')`);
  await page.settleAnimations();
  expect(await page.evaluate(firstVisible)).toBe('reply-10');
  expect(await page.evaluate(`document.querySelectorAll('[data-message-id]').length`)).toBeLessThanOrEqual(50);
  expect(await page.evaluate(`window.__reading.calls.length`)).toBe(1);
  let initialRead = await page.evaluate<number>(`window.__reading.view.readAt['profile:' + window.__reading.mira.id]`);
  expect(initialRead).toBeGreaterThanOrEqual(await page.evaluate<number>(`window.__reading.start + 10000`));
  expect(initialRead).toBeLessThan(await page.evaluate<number>(`window.__reading.start + 849000`));
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-missed-conversation-desktop.png'));

  // Sending shows the user's message without reading the history skipped to reach it.
  await page.evaluate(`window.__reading.fake.limits.paused = true`);
  await page.type('.agent-chat [data-testid="composer-input"]', 'I will catch up after sending this.');
  await page.click('.agent-chat [data-testid="composer-send"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-user-message"]')?.textContent.includes('I will catch up after sending this.') && document.querySelector('[data-testid="composer-input"]').value === ''`);
  expect(await page.evaluate(`window.__reading.view.readAt['profile:' + window.__reading.mira.id]`)).toBe(initialRead);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-unread-divider"]')`)).toBe(false);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-jump-unread"]')`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-sent-with-missed-desktop.png'));
  await page.click('[data-testid="agent-jump-unread"]');
  const afterSendFirst = await page.evaluate<string>(`'reply-' + (((${initialRead} - window.__reading.start) / 1000) + 1)`);
  await page.waitFor(`${firstVisible} === ${JSON.stringify(afterSendFirst)}`);
  initialRead = await page.evaluate<number>(`window.__reading.view.readAt['profile:' + window.__reading.mira.id]`);

  await page.evaluate(`(async () => {
    const f = window.__reading;
    const work = f.fake.save('work', { value: { agentId: f.mira.id, scope: f.scope, taskId: null, taskGeneration: null, messageId: null, episodeId: 'question-direct', prompt: 'Review', status: 'waiting', error: null, runId: null, notBefore: 0 } });
    const decision = f.fake.save('decision', { value: { scope: f.scope, workId: work.id, agentId: f.mira.id, prompt: 'Publish these changes?', options: ['Publish', 'Keep reviewing'], status: 'pending', answer: null } });
    f.question = { work, decision }; await f.view.refresh();
  })()`);
  await page.waitFor(`document.querySelector('.agents-identity [data-status="waiting"]')`);
  expect(await page.evaluate(`!!document.querySelector('.agents-identity [data-tone="waiting"]')`)).toBe(true);
  await page.evaluate(`(async () => { const f = window.__reading; f.fake.rows.delete('work:' + f.question.work.id); f.fake.rows.delete('decision:' + f.question.decision.id); await f.view.refresh(); })()`);

  await page.evaluate(`${box}.scrollTop = 0; ${box}.dispatchEvent(new Event('scroll'))`);
  await page.evaluate(`(async () => { const f = window.__reading; f.add('reply-new', f.scope, f.mira.id, f.start + 850000, 'One more update while you read older messages.'); await f.view.refresh(); })()`);
  await page.waitFor(`window.__reading.view.seen.messages.some(m => m.id === 'reply-new')`);
  expect(await page.evaluate(`!!document.querySelector('[data-message-id="reply-new"]')`)).toBe(false);
  expect(await page.evaluate(`${box}.scrollTop`)).toBe(0);
  expect(await page.evaluate(`window.__reading.view.readAt['profile:' + window.__reading.mira.id]`)).toBe(initialRead);
  await page.click('[data-testid="agent-jump-unread"]');
  await page.waitFor(`${box}.scrollTop > 0`);
  const expected = `(() => { const f = window.__reading; return f.view.seen.messages.find(m => m.scope.id === f.mira.id && m.createdAt > ${initialRead}).id; })()`;
  expect(await page.evaluate(firstVisible)).toBe(await page.evaluate(expected));
  // Read each loaded page, rather than skipping the retained gap to the newest snapshot.
  for (let i = 0; i < 20; i++) {
    const more = await page.evaluate(`!!document.querySelector('[data-testid="agent-messages-newer"]')`);
    if (!more) break;
    const count = await page.evaluate<number>(`document.querySelectorAll('[data-message-id]').length`);
    await page.evaluate(`${box}.scrollTop = ${box}.scrollHeight; ${box}.dispatchEvent(new Event('scroll'))`);
    await page.waitFor(`document.querySelectorAll('[data-message-id]').length > ${count}`);
  }
  await page.evaluate(`${box}.scrollTop = ${box}.scrollHeight; ${box}.dispatchEvent(new Event('scroll'))`);
  await page.waitFor(`!document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"] [data-testid="agent-unread-count"]')`);
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__reading.atlas.id + '"]').click()`);
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"]').click()`);
  await page.waitFor(`!document.querySelector('.agent-reading-status') && !document.querySelector('[data-testid="agent-unread-divider"]')`);
  expect(await page.evaluate(`${box}.scrollHeight - ${box}.scrollTop - ${box}.clientHeight < 2`)).toBe(true);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click('.agents-main .agent-mobile-back');
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-missed-list-phone.png'));
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__reading.group.id + '"]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-unread-divider"]')?.textContent.includes('3 missed messages')`);
  await page.settleAnimations();
  expect(await page.evaluate(firstVisible)).toBe('group-0');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-missed-conversation-phone.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(async () => {
    const f = window.__reading;
    const mission = f.fake.save('mission', { value: { title: 'Review the next changes', objective: '', expectedResult: '', teamId: null, projectId: null, agentIds: [f.mira.id, f.atlas.id], status: 'waiting', maxTurns: 6, maxDurationMs: 60000, maxTokens: null, resourceIds: [] } });
    const scope = { kind: 'mission', id: mission.id };
    const work = f.fake.save('work', { value: { agentId: f.mira.id, scope, taskId: null, taskGeneration: null, messageId: null, episodeId: 'question', prompt: 'Review', status: 'waiting', error: null, runId: null, notBefore: 0 } });
    f.fake.save('decision', { value: { scope, workId: work.id, agentId: f.mira.id, prompt: 'Publish these changes?', options: ['Publish', 'Keep reviewing'], status: 'pending', answer: null } });
    await f.view.refresh();
  })()`);
  await page.waitFor(`document.querySelector('.agents-identity [data-status="waiting"]')`);
  expect(await page.evaluate(`!!document.querySelector('.agents-identity [data-tone="waiting"]')`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-entry-' + window.__reading.group.id + '"] [data-tone="waiting"]')`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"] [data-tone="waiting"]')`)).toBe(false);
}, 60_000);
