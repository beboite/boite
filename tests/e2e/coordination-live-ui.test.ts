import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

test('a signed message from another core appears as a forwarded bubble and survives reload', async () => {
  const cores: RunningCore[] = [];
  const clients: CoreClient[] = [];
  let page: BrowserPage | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const core = await startCore();
      cores.push(core);
      clients.push(await connect(core.url, core.token));
    }
    const threads = [];
    for (const [index, client] of clients.entries()) {
      const project = await client.call('projects.add', { path: cores[index]!.dataDir, name: 'Shared deployment' });
      const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: index === 0 ? 'Maintenance agent' : 'Deployment agent' });
      await client.call('collaboration.configure', { threadId: thread.id, config: { mode: 'brief', remote: true, resources: 'Staging VM', paused: index === 0 } });
      threads.push(thread);
    }
    const [recipient, sender] = clients as [CoreClient, CoreClient];
    const recipientCard = await recipient.call('collaboration.identity', {});
    const senderCard = await sender.call('collaboration.identity', {});
    await recipient.call('collaboration.trust', { peer: { ...senderCard, name: 'Build PC' } });
    await sender.call('collaboration.trust', { peer: recipientCard });
    page = await BrowserPage.launch({ url: pairingUrlOf(cores[0]!) });
    await page.click(`[data-testid="thread-row"][data-thread-id="${threads[0]!.id}"]`);
    await page.waitFor('document.querySelector("[data-testid=coordination-panel]")');
    const letter = await sender.call('collaboration.send', {
      threadId: threads[1]!.id,
      to: { coreId: recipientCard.coreId, threadId: threads[0]!.id },
      text: 'Please wait before restarting. The deployment is still running.',
      requestId: 'browser-forwarded-message',
    });
    const selector = `[data-testid="forwarded-agent-message"][data-letter-id="${letter.id}"]`;
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 15000);
    const checkBubble = async () => {
      const text = await page!.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).textContent`);
      expect(text).toContain('Deployment agent');
      expect(text).toContain('Build PC');
      expect(text).toContain('Please wait before restarting.');
      expect(text).not.toContain('Boite agent coordination.');
      expect(await page!.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)).toBe(1);
      expect(await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('[data-role="user"]') === null`)).toBe(true);
    };
    await checkBubble();
    await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-real-cores.png'));
    await page.send('Page.reload', {});
    await page.click(`[data-testid="thread-row"][data-thread-id="${threads[0]!.id}"]`);
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 15000);
    await checkBubble();
  } finally {
    await page?.close();
    for (const client of clients) client.close();
    for (const core of cores.reverse()) await core.stop();
  }
}, 45000);
