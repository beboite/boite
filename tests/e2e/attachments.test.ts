import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';

test('desktop and paired phone upload files, preserve bytes and show downloadable history', async () => {
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Documents' });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Review attachments' });
    for (const mobile of [false, true]) {
      page = await BrowserPage.launch({ url: mobile ? await mintPairing(core) : pairingUrlOf(core) });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page.click(`[data-thread-id="${thread.id}"]`);
      // The app opens on a draft with its own composer; wait for the thread's.
      await page.waitFor('document.querySelector("[data-testid=thread-status]")');
      await page.waitFor('document.querySelector("[data-testid=composer-file]")');
      if (mobile) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.click('[data-testid=composer-options]');
        await page.waitFor('document.querySelector("[data-testid=composer-options-attach]")');
        expect(await page.text('[data-testid=composer-options-attach]')).toContain('Attach files');
        await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
        await page.click('[data-testid=composer-options-attach]');
        await page.waitFor('!document.querySelector("[data-testid=composer-options-sheet]")');
      }
      const name = mobile ? 'project-notes.md' : 'requirements.pdf';
      const body = mobile ? '# Project notes\nReview the attached requirements.' : '%PDF-test\nRequirements document';
      await page.evaluate(`(() => {
        const picker = document.querySelector('[data-testid=composer-file]');
        const transfer = new DataTransfer();
        transfer.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}, {type: ${JSON.stringify(mobile ? 'text/markdown' : 'application/pdf')}}));
        picker.files = transfer.files;
        picker.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      await page.waitFor('document.querySelector("[data-testid=composer-attachment]")');
      expect(await page.text('[data-testid=composer-attachment]')).toContain(name);
      expect(await page.evaluate('document.querySelector("[data-testid=composer-file]").accept')).toBe('');
      await page.type('[data-testid=composer-input]', 'Summarize the attached file');
      await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
      await page.screenshot(join(import.meta.dir, '.artifacts', `files-${mobile ? 'phone' : 'desktop'}-draft.png`));
      await page.click('[data-testid=composer-send]');
      await page.waitFor(`Array.from(document.querySelectorAll('[data-testid=file-part]')).some(el => el.textContent.includes(${JSON.stringify(name)}))`);
      await page.waitFor('document.querySelector("[data-testid=thread-status]")?.dataset.status === "idle"');
      const updated = await client.call('threads.get', { threadId: thread.id });
      const user = updated.messages.filter(m => m.role === 'user').at(-1)!;
      const file = user.parts.find(p => p.type === 'file')!;
      expect(file.type === 'file' && Buffer.from(file.data, 'base64').toString()).toBe(body);
      const reply = updated.messages.filter(m => m.role === 'assistant').at(-1)!.parts.filter(p => p.type === 'text').map(p => p.text).join('');
      const reference = JSON.parse(reply.slice(reply.indexOf('{"name":')).trim());
      expect(readFileSync(reference.path).toString()).toBe(body);
      const download = await page.evaluate<string>(`Array.from(document.querySelectorAll('[data-testid=file-part]')).find(el => el.download === ${JSON.stringify(name)}).href`);
      expect(Buffer.from(download.split(',')[1]!, 'base64').toString()).toBe(body);
      await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
      await page.screenshot(join(import.meta.dir, '.artifacts', `files-${mobile ? 'phone' : 'desktop'}-sent.png`));
      await page.close();
      page = undefined;
    }
  } finally {
    try { await page?.close(); } finally { client.close(); await core.stop(); }
  }
}, 120_000);
