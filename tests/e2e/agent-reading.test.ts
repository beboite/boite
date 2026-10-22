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
    for (let i = 0; i < 85; i++) add('reply-' + i, scope, mira.id, start + i * 1000, 'Update ' + (i + 1) + '\\n\\nThe preview is ready. The conversation keeps your reading position so you can catch up in order.');
    for (let i = 0; i < 3; i++) add('group-' + i, { kind: 'group', id: group.id }, atlas.id, start + i * 1000, 'Studio update ' + (i + 1) + '\\n\\n' + 'The team has reviewed the next changes. '.repeat(40));
    fake.save('work', { value: { agentId: atlas.id, scope: { kind: 'agent', id: atlas.id }, taskId: null, taskGeneration: null, messageId: null, episodeId: 'old-error', prompt: 'A previous task', status: 'interrupted', error: 'Stopped earlier', runId: null, notBefore: 0 } });
    const c = store.client, call = c.call.bind(c);
    c.call = (method, params, ...rest) => method.startsWith('agents.') ? Promise.resolve(fake.call(method, params)) : call(method, params, ...rest);
    await view.refresh();
    view.markRead('profile:' + mira.id, start + 9000);
    window.__reading = { view, fake, add, mira, atlas, group, scope, start };
    store.showAgents(atlas.id);
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"] [data-testid="agent-unread-count"]')?.textContent === '75'`);
  expect(await page.evaluate(`document.querySelector('.agents-rail').textContent.includes('Needs you')`)).toBe(false);
  expect(await page.evaluate(`!!document.querySelector('.agent-chat [data-testid="composer-picker"]')`)).toBe(false);
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-missed-list-desktop.png'));

  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__reading.mira.id + '"]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-unread-divider"]')?.textContent.includes('75 missed messages') && !document.querySelector('.agent-reading-status')`);
  await page.settleAnimations();
  expect(await page.evaluate(firstVisible)).toBe('reply-10');
  expect(await page.evaluate(`document.querySelectorAll('[data-message-id]').length`)).toBe(85);
  const initialRead = await page.evaluate<number>(`window.__reading.view.readAt['profile:' + window.__reading.mira.id]`);
  expect(initialRead).toBeGreaterThanOrEqual(await page.evaluate<number>(`window.__reading.start + 10000`));
  expect(initialRead).toBeLessThan(await page.evaluate<number>(`window.__reading.start + 84000`));
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-missed-conversation-desktop.png'));

  await page.evaluate(`${box}.scrollTop = 0; ${box}.dispatchEvent(new Event('scroll'))`);
  await page.evaluate(`(async () => { const f = window.__reading; f.add('reply-new', f.scope, f.mira.id, f.start + 85000, 'One more update while you read older messages.'); await f.view.refresh(); })()`);
  await page.waitFor(`document.querySelector('[data-message-id="reply-new"]')`);
  expect(await page.evaluate(`${box}.scrollTop`)).toBe(0);
  expect(await page.evaluate(`window.__reading.view.readAt['profile:' + window.__reading.mira.id]`)).toBe(initialRead);
  await page.click('[data-testid="agent-jump-unread"]');
  await page.waitFor(`${box}.scrollTop > 0`);
  const expected = `(() => { const f = window.__reading; return f.view.seen.messages.find(m => m.scope.id === f.mira.id && m.createdAt > ${initialRead}).id; })()`;
  expect(await page.evaluate(firstVisible)).toBe(await page.evaluate(expected));
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
}, 60_000);
