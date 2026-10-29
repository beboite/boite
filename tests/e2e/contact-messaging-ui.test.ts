import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let url: string;
beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = await startDevUi(port);
}, 60_000);
afterAll(async () => { await server?.close(); }, 30_000);

test('a contact reached through another machine shows the outgoing letter and reply in the original chat', async () => {
  const page = await BrowserPage.launch({ url: `${url}/?fake=1&open=recent`, windowSize: { width: 1440, height: 900 } });
  try {
    await page.waitFor(`document.querySelector('[data-testid="chat"]')`);
    await page.evaluate(`(async () => {
      const { FakeClient } = await import('/src/lib/fake-client.ts');
      const store = globalThis.__boiteTest.workspace.active;
      const source = store.client;
      const gateway = new FakeClient({ delayMs: 0, coreId: 'core-gateway', coreName: 'Gateway' });
      const outside = new FakeClient({ delayMs: 0, coreId: 'core-outside', coreName: 'Contact' });
      globalThis.__contactFixture = [gateway, outside];
      await Promise.all([gateway.connect(), outside.connect()]);
      if (!await source.call('group.get', {})) await source.call('group.create', { name: 'Work' });
      await gateway.call('group.join', { invite: (await source.call('group.invite', {})).invite });
      await outside.call('contacts.join', { link: (await gateway.call('contacts.invite', { share: false })).link });
      for (const client of [source, gateway, outside]) await client.call('contacts.settings', { settings: { minTier: 2 } });
      await outside.call('contacts.grant', { coreId: 'core-gateway', projectId: 'p-boite' });
      await outside.call('threads.update', { threadId: 't-trace', title: 'Contact deployment agent' });
      await store.open('t-trace');
      globalThis.__boiteTest.setTheme('dark');
      await source.call('collaboration.send', { threadId: 't-trace', to: { coreId: 'core-outside', threadId: 't-trace' }, text: 'Which port is available for the preview?', requestId: 'contact-question' });
    })()`);
    const row = '[data-testid="agent-discussion-row"][data-peer="core-outside/t-trace"]';
    await page.waitFor(`document.querySelector('${row}[data-count="1"]')`);
    expect(await page.text(row)).toContain('Sent to');
    await page.evaluate(`(async () => {
      const outside = globalThis.__contactFixture[1];
      const incoming = (await outside.call('collaboration.get', { threadId: 't-trace' })).messages.find(letter => letter.id === 'contact-question');
      await outside.call('collaboration.send', { threadId: 't-trace', to: incoming.from, text: 'Port 8080 is available.', replyTo: incoming.id, requestId: 'contact-answer' });
    })()`);
    await page.waitFor(`document.querySelector('${row}[data-count="2"]')`);
    expect(await page.text(row)).toContain('Exchange with');
    await page.evaluate(`document.querySelector('${row}').scrollIntoView({ block: 'center' })`);
    await page.click(row);
    await page.waitFor(`document.querySelectorAll('[data-testid="agent-discussion-message"]').length === 2`);
    expect(await page.text('[data-testid="agent-discussion-view"]')).toContain('Which port is available for the preview?');
    expect(await page.text('[data-testid="agent-discussion-view"]')).toContain('Port 8080 is available.');
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts/contact-exchange-desktop.png'));
    expect(page.errors()).toEqual([]);
  } finally {
    await page.evaluate(`globalThis.__contactFixture?.forEach(client => client.close())`).catch(() => {});
    await page.close();
  }
}, 45_000);
