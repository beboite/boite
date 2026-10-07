import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';
import { mobileAction } from './lib/mobile.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const SHOTS = join(import.meta.dir, '.artifacts');
const READY = 'document.querySelector("[data-testid=inline-view]")?.dataset.ready === "true"';
// A headless browser reports the pointer of the machine it runs on, a mouse on one runner and none on another: each run is told which it has.
const DESKTOP_POINTER = '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4';
const PHONE_POINTER = '--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2';
const SETTLED = 'Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])';

test('a view published during a turn is drawn at the end of the finished answer, on desktop and paired phone', async () => {
  ensureProductionUi();
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Physics notes' });
    const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    mkdirSync(join(core.dataDir, '.boite', 'views'), { recursive: true });
    copyFileSync(join(import.meta.dir, 'fixtures', 'views', 'pendulum.html'), join(core.dataDir, '.boite', 'views', 'pendulum.html'));
    for (const mobile of [false, true]) {
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, permissionMode: 'default', title: 'How a pendulum swings' });
      page = await BrowserPage.launch({ url: mobile ? await mintPairing(core) : pairingUrlOf(core), windowSize: { width: 1280, height: 900 }, args: [mobile ? PHONE_POINTER : DESKTOP_POINTER] });
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      if (mobile) await mobileAction(page, 'mobile-conversations');
      await page.click(mobile ? `[data-testid="mobile-thread-${thread.id}"]` : `[data-thread-id="${thread.id}"]`);
      await client.call('turns.start', { threadId: thread.id, prompt: 'A pendulum trades height for speed and back.\n\n[permission]Its period depends on its length, not on how far it swings: drag the sliders to see it.' });
      await page.waitFor('document.querySelector("[data-testid=permission-card]")');

      // Published in the middle of the turn, the way an agent runs `boite view` before its final text.
      const published = await client.call('artifacts.view', { threadId: thread.id, path: '.boite/views/pendulum.html' });
      const part = published.message.parts[0]!;
      expect(part).toMatchObject({ type: 'artifact', view: { title: 'Pendulum', source: '.boite/views/pendulum.html' } });
      // While the answer is still being written the thread ends on it, not on the page.
      await page.waitFor('document.querySelector("[data-testid=permission-card]")');
      expect(await page.evaluate('document.querySelector("[data-testid=inline-view]") === null && document.querySelector("[data-testid=chat-file]") === null')).toBe(true);

      const [permission] = await client.call('permissions.list', { threadId: thread.id });
      await client.call('permissions.answer', { requestId: permission!.id, decision: 'allow' });
      await page.waitFor(READY);
      const order = await page.evaluate<{ last: boolean; before: string }>(`(() => {
        const messages = Array.from(document.querySelectorAll('[data-testid=message]'));
        return { last: !!messages.at(-1)?.querySelector('[data-testid=inline-view]'), before: messages.at(-2)?.textContent ?? '' };
      })()`);
      expect(order.last).toBe(true);
      expect(order.before).toContain('Its period depends on its length');
      // Publishing did not cut the answer in two: one prompt, one answer, one page.
      const snapshot = await client.call('threads.get', { threadId: thread.id });
      expect(snapshot.turns.at(-1)?.status).toBe('done');
      expect(snapshot.messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant']);
      expect(snapshot.messages.some(message => message.id === published.message.id)).toBe(true);

      // The frame takes the page's own height: nothing scrolls inside it, nothing is wider than the screen.
      await page.waitFor(`(() => { const box = document.querySelector('[data-testid=inline-view-stage]'); const frame = box?.querySelector('iframe'); return !!frame && Math.abs(frame.getBoundingClientRect().height - parseFloat(box.style.height)) < 1 && parseFloat(box.style.height) > 150; })()`);
      // The app's own faces are read once and handed to the page, which can fetch nothing.
      await page.waitFor('performance.getEntriesByType("resource").filter(entry => entry.initiatorType === "fetch" && /\\/fonts\\/(Inter-latin|GeistMono)/.test(entry.name)).length >= 2');
      // On a desktop the actions wait for the pointer; on a phone they sit under the page, clear of it.
      const tools = await page.evaluate<{ opacity: string; below: boolean }>(`(() => {
        const tools = document.querySelector('[data-testid=inline-view] .tools');
        const stage = document.querySelector('[data-testid=inline-view-stage]');
        return { opacity: getComputedStyle(tools).opacity, below: tools.getBoundingClientRect().top >= stage.getBoundingClientRect().bottom - 1 };
      })()`);
      expect(tools).toEqual(mobile ? { opacity: '1', below: true } : { opacity: '0', below: false });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(await page.evaluate('document.querySelector("[data-testid=inline-view] iframe").getAttribute("sandbox")')).toBe('allow-scripts');
      expect(await page.evaluate('document.querySelector("[data-testid=timeline]").textContent.includes("pendulum.html")')).toBe(false);
      await page.evaluate('document.querySelector("[data-testid=inline-view]").scrollIntoView({ block: "center" })');
      await page.evaluate(SETTLED);
      await Bun.sleep(400);
      await page.screenshot(join(SHOTS, `inline-view-${mobile ? 'phone' : 'desktop'}.png`));

      if (!mobile) {
        // The page follows the app's theme without being loaded again.
        const address = await page.evaluate<string>('document.querySelector("[data-testid=inline-view] iframe").src');
        const before = await page.evaluate<string>('document.documentElement.dataset.theme ?? "dark"');
        const other = before === 'light' ? 'dark' : 'light';
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(other)}`);
        await page.waitFor(`document.querySelector("[data-testid=inline-view] iframe").style.colorScheme === ${JSON.stringify(other)}`);
        await Bun.sleep(400);
        expect(await page.evaluate<string>('document.querySelector("[data-testid=inline-view] iframe").src')).toBe(address);
        await page.screenshot(join(SHOTS, `inline-view-desktop-${other}.png`));
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(before)}`);

        await page.evaluate('document.querySelector("[data-testid=inline-view-expand]").click()');
        await page.waitFor('document.querySelector("[data-testid=inline-view] .stage").matches(":popover-open")');
        expect(await page.evaluate<string>('document.querySelector("[data-testid=inline-view] iframe").src')).toBe(address);
        await Bun.sleep(300);
        await page.screenshot(join(SHOTS, 'inline-view-desktop-full.png'));
        await page.evaluate('document.querySelector("[data-testid=inline-view-collapse]").click()');
        await page.waitFor('!document.querySelector("[data-testid=inline-view] .stage").matches(":popover-open")');

        // Play again loads the page afresh, on an address of its own.
        await page.evaluate('document.querySelector("[data-testid=inline-view-replay]").click()');
        await page.waitFor(`${READY} && document.querySelector("[data-testid=inline-view] iframe").src.split("#")[0] !== ${JSON.stringify(address.split('#')[0])}`);
      }

      await page.send('Page.reload', {});
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      if (mobile) await mobileAction(page, 'mobile-conversations');
      await page.click(mobile ? `[data-testid="mobile-thread-${thread.id}"]` : `[data-thread-id="${thread.id}"]`);
      await page.waitFor(READY);
      expect(await page.evaluate('!!Array.from(document.querySelectorAll("[data-testid=message]")).at(-1)?.querySelector("[data-testid=inline-view]")')).toBe(true);
      expect(page.errors()).toEqual([]);
      await page.close(); page = undefined;
    }
  } finally { await page?.close(); client.close(); await core.stop(); }
}, 120_000);

test('a view from another machine loads under the shell content security policy', async () => {
  ensureProductionUi();
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Remote views' });
    const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'A view from a remote machine' });
    copyFileSync(join(import.meta.dir, 'fixtures', 'views', 'pendulum.html'), join(core.dataDir, 'pendulum.html'));
    await client.call('threads.subscribe', { threadId: thread.id });
    const done = client.next('turn.finished');
    await client.call('turns.start', { threadId: thread.id, prompt: 'Here is the pendulum.' });
    await done;
    await client.call('artifacts.view', { threadId: thread.id, path: 'pendulum.html' });
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    // A different hostname gives the real core a remote origin without leaving loopback.
    const remote = core.url.replace('127.0.0.1', 'localhost');
    await page.evaluate(`localStorage.removeItem('boite.envs'); localStorage.setItem('boite.theme', 'dark'); localStorage.setItem('boite.core', ${JSON.stringify(JSON.stringify({ url: remote, token: core.token }))})`);
    await page.navigate(core.url);
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    const config = JSON.parse(readFileSync(join(import.meta.dir, '../../apps/shell/src-tauri/tauri.conf.json'), 'utf8'));
    await page.evaluate(`(() => {
      window.__policyViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__policyViolations.push(event.effectiveDirective));
      const policy = document.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content = ${JSON.stringify(config.app.security.csp)};
      document.head.append(policy);
    })()`);
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor(READY);
    expect(await page.evaluate('window.__policyViolations')).toEqual([]);
    expect(new URL(await page.evaluate<string>('document.querySelector("[data-testid=inline-view] iframe").src')).origin).toBe(remote);
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); client.close(); await core.stop(); }
}, 90_000);
