import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestCore } from '../../packages/core/test/harness.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, mintPairing } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

test('OpenCode 2 tools stay folded while queued and immediate messages reach its running turn on desktop and phone', async () => {
  ensureProductionUi();
  const inheritedUi = process.env['BOITE_UI_DIR'];
  process.env['BOITE_UI_DIR'] = resolve('packages/ui/dist');
  const core = await startTestCore();
  const client = await core.connect();
  let page: BrowserPage | undefined;
  try {
    const profile = { executable: [{ kind: 'file' as const, value: process.execPath }], detect: {}, isolation: {},
      launch: { args: [resolve('packages/core/test/fixtures/opencode2-server.ts'), 'acp'] }, env: { OPENCODE_FIXTURE_TOOL_GATE: join(core.dataDir, 'tool-ready') } };
    Object.assign(core.core.providers.require('opencode-v2'), { auth: { kind: 'none' }, env: {}, profiles: { windows: profile, linux: profile, macos: profile } });
    await client.call('providers.setEnabled', { providerId: 'opencode-v2', enabled: true });
    const account = await client.call('accounts.add', { providerId: 'opencode-v2', label: 'Fixture' });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Workspace' });
    for (const mobile of [false, true]) {
      const gate = join(core.dataDir, `tool-ready-${mobile}`);
      profile.env.OPENCODE_FIXTURE_TOOL_GATE = gate;
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'opencode-v2', accountId: account.id, title: 'Review changes' });
      page = await BrowserPage.launch({ url: mobile ? await mintPairing(core) : pairingUrlOf(core), windowSize: { width: 1440, height: 900 } });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page.click(`[data-thread-id="${thread.id}"]`);
      await page.waitFor('document.querySelector("[data-testid=thread-header][data-status]")');
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'Review the workspace [slow]' });
      await page.waitFor('document.querySelector("[data-testid=thread-header]")?.dataset.status === "running"');
      await page.type('[data-testid=composer-input]', 'Check the parser first');
      await page.click('[data-testid=composer-send]');
      await page.waitFor('document.querySelector("[data-testid=composer-queued]")');
      await page.screenshot(join(import.meta.dir, '.artifacts', `opencode2-${mobile ? 'phone' : 'desktop'}-queued.png`));
      writeFileSync(gate, 'ready');
      await page.waitFor('!document.querySelector("[data-testid=composer-queued]") && document.body.textContent.includes("Received: Check the parser first")');
      await page.type('[data-testid=composer-input]', 'Then check the error message');
      await page.click('[data-testid=composer-send]');
      await page.waitFor('document.querySelector("[data-testid=composer-send-now]")');
      await page.click('[data-testid=composer-send-now]');
      await page.waitFor('!document.querySelector("[data-testid=composer-queued]") && document.body.textContent.includes("Received: Then check the error message")');
      const current = await client.call('threads.get', { threadId: thread.id });
      expect(current.status).toBe('running');
      expect(current.turns).toHaveLength(1);
      expect(current.messages.filter(message => message.role === 'user')).toHaveLength(3);
      expect(current.messages.filter(message => message.role === 'user').every(message => message.turnId === turn.id)).toBe(true);
      const tool = '[data-testid=tool-card]';
      await page.waitFor(`document.querySelector('${tool}[data-family=command][data-status=done]')`);
      expect(await page.evaluate(`document.querySelector('${tool} [data-testid=tool-toggle]')?.getAttribute('aria-expanded')`)).toBe('false');
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mobile ? 200 : 850, y: 400, deltaX: 0, deltaY: -650 });
      await page.evaluate(`document.querySelector('${tool}')?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await page.waitFor(`(() => { const rect = document.querySelector('${tool}').getBoundingClientRect(); return rect.top > 50 && rect.bottom < innerHeight - 180; })()`);
      await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await page.waitFor(`document.querySelector('${tool}').getBoundingClientRect().top > 50`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `opencode2-${mobile ? 'phone' : 'desktop'}-sent.png`));
      await page.click(`${tool} [data-testid=tool-toggle]`);
      await page.waitFor('document.body.textContent.includes("working tree clean")');
      expect(page.errors()).toEqual([]);
      await client.call('turns.stop', { threadId: thread.id });
      await page.close(); page = undefined;
    }
  } finally {
    await page?.close();
    await core.stop();
    if (inheritedUi === undefined) delete process.env['BOITE_UI_DIR']; else process.env['BOITE_UI_DIR'] = inheritedUi;
  }
}, 120_000);
