import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

test('signed agent mail opens from a compact summary and survives reload in its messages tab', async () => {
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
      const project = await client.call('projects.add', { path: cores[index]!.dataDir, name: index === 0 ? 'Infrastructure' : 'Release tools' });
      const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: index === 0 ? 'Maintenance agent' : 'Deployment agent preparing the release before the restart' });
      const { config } = await client.call('collaboration.get', { threadId: thread.id });
      expect(config).toEqual({ mode: 'brief', remote: true, resources: '', paused: false });
      if (index === 0) await client.call('collaboration.configure', { threadId: thread.id, config: { ...config, paused: true } });
      threads.push(thread);
    }
    const [recipient, sender] = clients as [CoreClient, CoreClient];
    const recipientCard = await recipient.call('collaboration.identity', {});
    const senderCard = await sender.call('collaboration.identity', {});
    await recipient.call('collaboration.trust', { peer: { ...senderCard, name: 'Build PC' } });
    await sender.call('collaboration.trust', { peer: recipientCard });
    await sender.call('settings.set', { browserOrigins: [cores[0]!.url] });
    const senderDevice = await sender.call('pairing.grant', {});
    const senderSession = await connect(cores[1]!.url, '', { grant: senderDevice.grant });
    clients.push(senderSession);
    const deviceToken = senderSession.session!.token;
    page = await BrowserPage.launch({ url: pairingUrlOf(cores[0]!) });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.click(`[data-testid="thread-row"][data-thread-id="${threads[0]!.id}"]`);
    await page.waitFor('document.querySelector("[data-testid=thread-menu-trigger]")');
    await page.evaluate(`localStorage.setItem('boite.envs', JSON.stringify([...JSON.parse(localStorage.getItem('boite.envs') || '[]'), ${JSON.stringify({ url: cores[1]!.url, token: deviceToken, label: 'Build PC', paired: true })}]))`);
    await page.reload();
    await page.click(`[data-testid="thread-row"][data-thread-id="${threads[0]!.id}"]`);
    await page.click('[data-testid=machine-status]');
    await page.waitFor('document.querySelectorAll("[data-testid=machine-status-menu] .status-dot[data-tone=success]").length === 2');
    await page.click('[data-testid=machine-status-menu] [data-value=all]');
    await page.waitFor(`document.querySelector('[data-testid="thread-row"][data-thread-id="${threads[1]!.id}"]')`);
    const letter = await sender.call('collaboration.send', {
      threadId: threads[1]!.id,
      to: { coreId: recipientCard.coreId, threadId: threads[0]!.id },
      text: 'Please wait before restarting. The deployment is still running.',
      requestId: 'browser-forwarded-message',
    });
    const selector = `[data-testid="forwarded-agent-message"][data-letter-id="${letter.id}"]`;
    const summary = '[data-testid=agent-message-summary][data-direction=incoming]';
    await page.waitFor(`document.querySelector(${JSON.stringify(summary)})`, 15000);
    expect(await page.text(summary)).toContain('Received 1 message');
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}) === null`)).toBe(true);
    await page.click(summary);
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 15000);
    const checkBubble = async () => {
      const text = await page!.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).textContent`);
      expect(text).toContain('Deployment agent');
      expect(text).toContain('Build PC');
      expect(text).toContain('Release tools');
      expect(await page!.evaluate(`!!document.querySelector(${JSON.stringify(selector + ' [data-testid=agent-letter-status] svg.lucide-check-check')})`)).toBe(true);
      expect(text).toContain('Please wait before restarting.');
      expect(await page!.evaluate(`(() => { const header = document.querySelector(${JSON.stringify(selector + ' [data-testid=agent-letter-open]')}); const icon = header.querySelector('.forward-icon'); return Math.abs(header.getBoundingClientRect().left - icon.getBoundingClientRect().left) < 2; })()`)).toBe(true);
      expect(await page!.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(text).not.toContain('Boite agent coordination.');
      expect(await page!.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)).toBe(1);
      expect(await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('[data-testid="agent-messages-surface"]') !== null`)).toBe(true);
    };
    await checkBubble();
    await page.click('[data-testid=panel-close]');
    await page.waitFor('!document.querySelector("[data-testid=right-panel]")');
    await page.click('[data-testid=thread-menu-trigger]');
    await page.click('[data-value=coordination]');
    await page.waitFor('document.querySelector("[data-testid=coordination-mode-on]").getAttribute("aria-checked") === "true"');
    await page.waitFor('document.querySelector("[data-testid=coordination-dialog]").open');
    await page.click('[data-testid=coordination-close]');
    await page.click(summary);
    await page.evaluate("document.documentElement.dataset.theme = 'dark'");
    await page.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-real-cores.png'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await checkBubble();
    await page.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-real-cores-phone.png'));
    await page.click(`${selector} [data-testid=agent-letter-open]`);
    await page.waitFor('document.querySelector("[data-testid=agent-message-summary][data-direction=outgoing]")');
    await page.waitFor('!document.querySelector("[data-testid=right-panel]")');
    await page.click('[data-testid=agent-message-summary][data-direction=outgoing]');
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})?.dataset.direction === 'outgoing'`);
    expect(await page.text(`${selector} [data-testid=agent-letter-project]`)).toBe('Infrastructure');
    expect(await page.text(selector)).toContain('Maintenance agent');
    await page.evaluate('document.fonts.ready');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-outgoing-phone.png'));
    await page.click(`${selector} [data-testid=agent-letter-open]`);
    await page.waitFor(`document.querySelector(${JSON.stringify(summary)})`);
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})?.dataset.direction === 'incoming'`);
    await checkBubble();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.reload', {});
    await page.click(`[data-testid="thread-row"][data-thread-id="${threads[0]!.id}"]`);
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 15000);
    await checkBubble();
    expect(await page.evaluate('document.querySelectorAll("[data-testid=panel-tab][data-kind=messages]").length')).toBe(1);
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    for (const client of clients) client.close();
    for (const core of cores.reverse()) await core.stop();
  }
}, 45000);
