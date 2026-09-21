import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';

const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
let uiUrl: string;

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('[data-testid="coordination-panel"]')`);
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
}, 30_000);

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
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-panel"]')?.hasAttribute('open')`)).toBe(false);
  await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]').scrollIntoView({ block: 'center' })`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-desktop.png'));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]').scrollIntoView({ block: 'center' })`);
  await settled();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await checkDirection();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-phone.png'));

  await page.click('[data-testid="coordination-panel"] > summary');
  await page.waitFor(`document.querySelector('[data-testid="coordination-panel"]')?.hasAttribute('open')`);
  await page.click('.options > summary');
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-budget"]')?.textContent ?? ''`)).toContain('40 sends');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="coordination-contact"]').length`)).toBeGreaterThan(0);
}, 30_000);
