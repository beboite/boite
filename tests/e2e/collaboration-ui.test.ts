import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let uiUrl: string;

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('[data-testid="chat"]')`);
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);
  await page.evaluate(`(async () => {
    const [{ workspace }, { FakeClient }] = await Promise.all([import('/src/lib/workspace.svelte.ts'), import('/src/lib/fake-client.ts')]);
    const local = workspace.active.client;
    await workspace.active.open('t-trace');
    const remote = new FakeClient({ delayMs: 0, coreId: 'core-build-pc', coreName: 'Build PC', publicUrl: 'https://build.example.test' });
    window.__coordinationRemote = remote;
    await remote.connect();
    await remote.call('threads.update', { threadId: 't-bench', title: 'Deployment agent' });
    const team = { mode: 'team', resources: 'Owns deployment and restart sequencing', remote: true, paused: false };
    await local.call('collaboration.configure', { threadId: 't-trace', config: team });
    await remote.call('collaboration.configure', { threadId: 't-bench', config: team });
    const [localIdentity, remoteIdentity] = await Promise.all([local.call('collaboration.identity', {}), remote.call('collaboration.identity', {})]);
    await local.call('collaboration.trust', { peer: remoteIdentity });
    await remote.call('collaboration.trust', { peer: localIdentity });
    const incoming = await remote.call('collaboration.send', {
      threadId: 't-bench', to: { coreId: localIdentity.coreId, threadId: 't-trace' },
      text: 'Wait before restart. The deployment is still using the build machine.', requestId: 'incoming-deployment'
    });
    await local.call('collaboration.send', {
      threadId: 't-trace', to: { coreId: remoteIdentity.coreId, threadId: 't-bench' },
      text: 'Restart postponed until deployment confirms it is clear.', replyTo: incoming.id, requestId: 'outgoing-reply'
    });
  })()`);
  await page.waitFor(`document.querySelectorAll('[data-testid="forwarded-agent-message"]').length === 2`);
  await page.waitFor(`document.querySelector('[data-testid="thread-menu-trigger"]')`);
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('forwarded agent messages sit in the conversation at desktop and phone widths', async () => {
  await settled();
  expect(await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]')?.textContent ?? ''`)).toContain('Deployment agent');
  expect(await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]')?.textContent ?? ''`)).toContain('Build PC');
  expect(await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]')?.textContent ?? ''`)).toContain('Wait before restart');
  expect(await page.evaluate(`document.querySelector('[data-letter-id="outgoing-reply"]')?.dataset.direction`)).toBe('outgoing');
  const checkDirection = async () => {
    const bubbles = await page.evaluate<any>(`(() => {
      const incoming = document.querySelector('[data-letter-id="incoming-deployment"]');
      const outgoing = document.querySelector('[data-letter-id="outgoing-reply"]');
      return { incoming: incoming.textContent, outgoing: outgoing.textContent,
        incomingLeft: incoming.getBoundingClientRect().left, outgoingLeft: outgoing.getBoundingClientRect().left,
        incomingRight: incoming.getBoundingClientRect().right, outgoingRight: outgoing.getBoundingClientRect().right,
        incomingColor: getComputedStyle(incoming).backgroundColor, outgoingColor: getComputedStyle(outgoing).backgroundColor };
    })()`);
    expect(bubbles.incoming).toContain('Received from');
    expect(bubbles.outgoing).toContain('Your agent sent to');
    expect(bubbles.outgoing).toContain('Deployment agent');
    expect(bubbles.outgoingLeft).toBeGreaterThan(bubbles.incomingLeft);
    expect(bubbles.outgoingRight).toBeGreaterThan(bubbles.incomingRight);
    expect(bubbles.outgoingColor).not.toBe(bubbles.incomingColor);
  };
  await checkDirection();
  expect(await page.evaluate(`document.querySelector('[data-testid="timeline"]')?.textContent ?? ''`)).not.toContain('Boite agent coordination');
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-panel"]') === null`)).toBe(true);
  await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]').scrollIntoView({ block: 'center' })`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-desktop.png'));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]').scrollIntoView({ block: 'center' })`);
  await settled();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await checkDirection();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-phone.png'));

  // The same title menu exposes settings on phones and desktops.
  await page.click('[data-testid="thread-menu-trigger"]');
  await page.click('[data-value="coordination"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]')?.open`);
  await settled();
  expect(await page.evaluate(`document.activeElement.closest('[data-testid="coordination-dialog"]') !== null`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-settings-phone.png'));
  await page.click('.options > summary');
  const budget = await page.evaluate<string>(`document.querySelector('[data-testid="coordination-budget"]')?.textContent ?? ''`);
  expect(budget).toContain('sent this hour');
  expect(budget).not.toContain(' of ');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="coordination-contact"]').length`)).toBeGreaterThan(0);
  await page.click('[data-testid="coordination-mode-off"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-mode-off"]').getAttribute('aria-checked') === 'true'`);
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]') === null`);
  expect(await page.evaluate(`document.activeElement.dataset.testid`)).toBe('thread-menu-trigger');

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="thread-menu-trigger"]');
  await page.click('[data-value="coordination"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]')?.open`);
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-mode-off"]').getAttribute('aria-checked')`)).toBe('true');
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-settings-desktop.png'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]') === null`);
  expect(await page.evaluate(`document.activeElement.dataset.testid`)).toBe('thread-menu-trigger');

  await page.click('[data-testid="thread-menu-trigger"]');
  await page.click('[data-value="coordination"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]')?.open`);
  await page.evaluate(`window.__boiteTest.workspace.active.open('t-bench')`);
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]') === null`);
}, 30_000);
