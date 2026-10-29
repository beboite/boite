import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

test('an answer keeps emphasis around links and nested inline Markdown on desktop and phone', async () => {
  const port = await freePort();
  const server = await startUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 1000 } });
    await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
    await page.click('[data-thread-id="t-trace"]');
    const text = [
      "Claude utilise **son propre catalogue : [Anthropic Directory](https://example.test/directory)**. C'est celui que tu vois dans leur appli.",
      'Les connecteurs de cet annuaire utilisent MCP. [Documentation **officielle**](https://example.test/docs "Documentation").',
      'Pour Boite, on peut reprendre les **mêmes serveurs MCP publics** proposés par ces services.',
      '__Gras__, _italique_ et **gras avec *italique***. Les caractères \\*échappés\\* restent du texte.',
      'Un lien de fichier en gras : **[source](C:\\Dev\\_generated_\\a.ts:4)**. Le code `**littéral**` garde ses caractères.',
      'Première ligne  \nDeuxième ligne',
      '| Format | Résultat |\n|---|---|\n| **Gras** | [Lien *formaté*](https://example.test/table) |',
    ].join('\n\n');
    await page.evaluate(`(() => {
      const thread = window.__boiteTest.workspace.active.openThread;
      thread.status = 'idle'; thread.memoryEvents = [];
      const message = thread.messages.at(-1);
      thread.messages = [message]; message.state = 'complete';
      message.parts = [{ type: 'text', text: ${JSON.stringify(text)} }];
      window.__boiteTest.setLocaleSetting('fr');
    })()`);
    for (const [name, width, height] of [['desktop', 1280, 1000], ['phone', 390, 1100]] as const) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'phone' });
      await page.waitFor(`document.querySelector('[data-role="assistant"] strong a[href="https://example.test/directory"]')`);
      expect(await page.text('[data-role="assistant"] strong')).toBe('son propre catalogue : Anthropic Directory');
      expect(await page.text('[data-role="assistant"] a[href="https://example.test/docs"] strong')).toBe('officielle');
      expect(await page.text('[data-role="assistant"] strong em')).toBe('italique');
      expect(await page.text('[data-role="assistant"] code')).toBe('**littéral**');
      expect(await page.evaluate(`!!document.querySelector('[data-role="assistant"] strong a[data-file-path="C:/Dev/_generated_/a.ts"][data-file-line="4"]')`)).toBe(true);
      expect(await page.evaluate(`!!document.querySelector('[data-role="assistant"] br')`)).toBe(true);
      expect(await page.evaluate(`(() => {
        const p = document.querySelector('[data-role="assistant"] br').parentElement;
        const first = document.createRange(); first.selectNodeContents(p.firstChild);
        const last = document.createRange(); last.selectNodeContents(p.lastChild);
        return Math.abs(last.getBoundingClientRect().top - first.getBoundingClientRect().top - parseFloat(getComputedStyle(p).lineHeight)) < 1;
      })()`)).toBe(true);
      expect(await page.text('[data-role="assistant"] td a em')).toBe('formaté');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', `markdown-compatibility-${name}.png`));
    }
  } finally {
    await page?.close();
    await server.close();
  }
}, 90_000);
