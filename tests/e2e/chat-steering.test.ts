import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const input = '[data-testid=composer-input]';
const send = '[data-testid=composer-send]';

test('desktop and paired phone deliver queued and immediate follow-ups without ending the turn', async () => {
  ensureProductionUi();
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    await client.call('settings.set', { asyncQuestions: false });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Workspace' });
    const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    for (const mobile of [false, true]) {
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Review changes' });
      page = await BrowserPage.launch({ url: mobile ? await mintPairing(core) : pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page.click(`[data-thread-id="${thread.id}"]`);
      await page.waitFor('document.querySelector("[data-testid=thread-header][data-status]")');
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'Read the files [sleep:1800][tool] Keep working [sleep:2500] Finish' });
      await page.waitFor('document.querySelector("[data-testid=thread-header]")?.dataset.status === "running"');
      await page.type(input, 'Check the parser first');
      await page.click(send);
      await page.waitFor('document.querySelector("[data-testid=composer-queued]")');
      await page.screenshot(join(import.meta.dir, '.artifacts', `steering-${mobile ? 'phone' : 'desktop'}-queued.png`));
      await page.waitFor('!document.querySelector("[data-testid=composer-queued]") && Array.from(document.querySelectorAll("[data-testid=message]")).some(el => el.textContent.includes("Check the parser first"))');
      let updated = await client.call('threads.get', { threadId: thread.id });
      expect(updated.status).toBe('running');
      expect(updated.turns).toHaveLength(1);
      expect(updated.messages.filter(message => message.role === 'user').at(-1)).toMatchObject({ turnId: turn.id });
      // With the only tool already complete, automatic delivery would wait for the end.
      await page.type(input, 'Then check the error message');
      await page.click(send);
      await page.waitFor('document.querySelector("[data-testid=composer-send-now]")');
      await page.click('[data-testid=composer-send-now]');
      await page.waitFor('!document.querySelector("[data-testid=composer-queued]") && Array.from(document.querySelectorAll("[data-testid=message]")).some(el => el.textContent.includes("Then check the error message"))');
      updated = await client.call('threads.get', { threadId: thread.id });
      expect(updated.status).toBe('running');
      expect(updated.turns).toHaveLength(1);
      expect(updated.messages.filter(message => message.role === 'user')).toHaveLength(3);
      await page.screenshot(join(import.meta.dir, '.artifacts', `steering-${mobile ? 'phone' : 'desktop'}-sent.png`));
      await page.waitFor('document.querySelector("[data-testid=thread-header]")?.dataset.status === "idle"');
      updated = await client.call('threads.get', { threadId: thread.id });
      const reply = updated.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('');
      expect(reply).toContain('Check the parser first');
      expect(reply).toContain('Then check the error message');
      expect(updated.turns[0]?.status).toBe('done');
      expect(page.errors()).toEqual([]);
      await page.close(); page = undefined;
    }
  } finally {
    try { await page?.close(); } finally { client.close(); await core.stop(); }
  }
}, 120_000);
