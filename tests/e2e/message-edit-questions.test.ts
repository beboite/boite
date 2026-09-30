import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const input = '[data-testid=composer-input]';
const send = '[data-testid=composer-send]';
const captures = process.env.BOITE_E2E_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts');

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])');
  await page.screenshot(join(captures, name));
}

test('desktop and paired phone replace an edited message and silently skip a question', async () => {
  ensureProductionUi();
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    await client.call('settings.set', { asyncQuestions: false });
    const cwd = join(core.dataDir, 'workspace');
    await mkdir(cwd);
    await writeFile(join(cwd, 'app.ts'), 'keep this code');
    const project = await client.call('projects.add', { path: cwd, name: 'Workspace' });
    const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    for (const mobile of [false, true]) {
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Review changes' });
      await client.call('threads.subscribe', { threadId: thread.id });
      const run = async (prompt: string) => {
        const finished = client.next('turn.finished', turn => turn.threadId === thread.id);
        await client.call('turns.start', { threadId: thread.id, prompt });
        await finished;
      };
      await run('Keep this request');
      const kept = (await client.call('threads.get', { threadId: thread.id })).messages.map(message => message.id);
      await run('Original request');
      await run('Later request');
      const old = await client.call('threads.get', { threadId: thread.id });
      page = await BrowserPage.launch({ url: mobile ? await mintPairing(core) : pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page.click(`[data-thread-id="${thread.id}"]`);
      await page.waitFor('document.querySelectorAll("[data-testid=message-edit]").length === 3');
      if (mobile) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
      await page.evaluate('Array.from(document.querySelectorAll("[data-role=user]")).find(row => row.querySelector("[data-testid=text-part]")?.textContent === "Original request").querySelector("[data-testid=message-edit]").click()');
      await page.waitFor('document.querySelector("[data-testid=composer-editing]") && document.querySelector("[data-testid=composer-input]").value === "Original request"');
      await page.evaluate('document.querySelector("[data-testid=composer-input]").focus(); document.querySelector("[data-testid=composer-input]").select()');
      await page.send('Input.insertText', { text: 'Changed request' });
      await page.waitFor('document.querySelector("[data-testid=composer-input]").value === "Changed request"');
      await capture(page, `message-edit-${mobile ? 'phone' : 'desktop'}.png`);
      const finished = client.next('turn.finished', turn => turn.threadId === thread.id);
      await page.click(send);
      await finished;
      await page.waitFor('!document.querySelector("[data-testid=composer-editing]") && document.querySelector("[data-testid=composer-input]").value === ""');
      const replaced = await client.call('threads.get', { threadId: thread.id });
      expect(replaced.messages.slice(0, kept.length).map(message => message.id)).toEqual(kept);
      expect(replaced.turns).toHaveLength(2);
      expect(replaced.messages.slice(kept.length).some(message => old.messages.some(previous => previous.id === message.id))).toBe(false);
      expect(replaced.messages.filter(message => message.role === 'user').at(-1)?.parts).toEqual([{ type: 'text', text: 'Changed request' }]);
      const reply = replaced.messages.filter(message => message.role === 'assistant').at(-1)!.parts.filter(part => part.type === 'text').map(part => part.text).join('');
      expect(reply).toContain('Changed request');
      expect(reply).not.toContain('Original request');
      expect(reply).not.toContain('Later request');
      await capture(page, `message-replaced-${mobile ? 'phone' : 'desktop'}.png`);

      await client.call('questions.ask', { threadId: thread.id, text: 'Which file should be checked first?', options: ['Parser', 'Renderer'] });
      await page.waitFor('document.querySelector("[data-testid=question-skip]")');
      expect(await page.evaluate('document.querySelector("[data-testid=question-skip]").disabled')).toBe(false);
      await capture(page, `question-skip-${mobile ? 'phone' : 'desktop'}.png`);
      await page.click('[data-testid=question-skip]');
      await page.waitFor('!document.querySelector("[data-testid=activity-question]")');
      expect(await client.call('questions.list', { threadId: thread.id })).toEqual([]);
      const skipped = await client.call('threads.get', { threadId: thread.id });
      expect(skipped.status).toBe('idle');
      expect(skipped.turns).toEqual(replaced.turns);
      expect(skipped.messages.filter(message => message.role === 'user')).toEqual(replaced.messages.filter(message => message.role === 'user'));
      expect(page.errors()).toEqual([]);
      await page.close(); page = undefined;
    }
  } finally {
    try { await page?.close(); } finally { client.close(); await core.stop(); }
  }
}, 120_000);
