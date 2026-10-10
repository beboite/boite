// One client in one namespace: a phone opening a pairing link, or a desktop
// shell joining the server's group with an invitation. Prints one JSON line of results.
//   bun client.ts phone <label> <outDir> <threadId> <pairingUrl>
//   bun client.ts desktop <label> <outDir> <threadId> <localCoreUrl> <localToken> <groupInvite>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage } from '../e2e/lib/cdp.ts';

const [mode, label, outDir, title, ...rest] = process.argv.slice(2) as [string, string, string, string, ...string[]];
mkdirSync(outDir, { recursive: true });
const steps: { step: string; ok: boolean; ms: number; detail?: string }[] = [];
const log: string[] = [];
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const WIN10_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

let page: BrowserPage | null = null;
async function step(name: string, run: () => Promise<string | void>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await run();
    steps.push({ step: name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    return true;
  } catch (error) {
    const body = await page?.evaluate<string>(`(() => { const i = document.querySelector('[data-testid=composer-input]'); const b = document.querySelector('[data-testid=composer-send]'); return JSON.stringify({ input: i && [i.tagName, i.value ?? i.textContent, i.disabled, i.readOnly], send: b && b.disabled, booted: !!window.__boiteBooted, res: performance.getEntriesByType('resource').filter(r => r.responseStatus !== 200 || r.duration > 2000).map(r => [r.name.slice(-60), r.responseStatus, Math.round(r.duration)]), body: document.body?.innerText.slice(0, 400) }); })()`).catch(() => '');
    steps.push({ step: name, ok: false, ms: Date.now() - started, detail: `${(error as Error).message.split('\n')[0]} | page: ${JSON.stringify(body)}` });
    await page?.screenshot(join(outDir, `${label}-fail-${name}.png`)).catch(() => undefined);
    return false;
  }
}

/** A real press at the element's centre: a JavaScript click() never moves the focus. */
async function tap(selector: string): Promise<void> {
  const point = await page!.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page!.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
}

const desktop = mode === 'desktop';
const size = desktop ? { width: 1280, height: 860 } : { width: 412, height: 915 };
try {
  page = await BrowserPage.launch({ url: 'about:blank', executable: join(import.meta.dir, 'chrome.sh'), windowSize: size });
  await page.send('Log.enable', {}).catch(() => undefined);
  await page.send('Emulation.setUserAgentOverride', { userAgent: desktop ? WIN10_UA : ANDROID_UA, platform: desktop ? 'Win32' : 'Linux armv8l' });
  if (!desktop) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  const threadVisible = desktop
    ? `!!document.querySelector('[data-testid=thread-row][data-thread-id="${title}"]')`
    // The list sits behind the back arrow of a draft, or under the Conversations tab.
    : `(document.querySelector('[data-testid="mobile-thread-${title}"]') || (document.querySelector('[data-testid=mobile-back]') ?? document.querySelector('[data-testid=mobile-conversations]'))?.click(), !!document.querySelector('[data-testid="mobile-thread-${title}"]'))`;

  if (desktop) {
    const [localUrl, localToken, invite] = rest as [string, string, string];
    // The shell's own Content-Security-Policy, read from its config: WebView2
    // enforces it on every page of the desktop app, Chrome here through a meta tag.
    const conf = JSON.parse(await Bun.file(join(import.meta.dir, '../../apps/shell/src-tauri/tauri.conf.json')).text());
    const csp = conf.app.security.csp as string;
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      document.addEventListener('DOMContentLoaded', () => {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'Content-Security-Policy';
        meta.content = ${JSON.stringify(csp)};
        document.head.prepend(meta);
      });
    ` });
    await step('open-local', async () => {
      await page!.navigate(`${localUrl}/?token=${encodeURIComponent(localToken)}`);
      await page!.waitFor(`document.querySelector('[data-testid=nav-settings]')`, 30_000);
    });
    await step('join-group', async () => {
      // The server made a group and an invitation; this computer joins it, as Settings, Machines does.
      await page!.click('[data-testid=nav-settings]');
      await page!.click('[data-testid=settings-tab-machines]');
      await page!.type('[data-testid=group-join-input]', invite);
      await page!.click('[data-testid=group-join]');
      await page!.waitFor(`document.querySelectorAll('[data-testid=machine-card][data-group-member=true]').length >= 2 && document.querySelectorAll('[data-testid=machine-card] .status.ready').length >= 2`, 45_000);
      await page!.screenshot(join(outDir, `${label}-machines.png`));
      return await page!.evaluate<string>(`[...document.querySelectorAll('[data-testid=machine-card]')].map(c => c.innerText.replace(/\\s+/g, ' ')).join(' || ')`);
    });
    await step('remote-thread-listed', async () => {
      await page!.click('[data-testid=settings-back]');
      await page!.waitFor(threadVisible, 30_000);
    });
    await step('open-thread', async () => {
      await page!.click(`[data-testid=thread-row][data-thread-id="${title}"]`);
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]')?.placeholder.startsWith('Message Echo')`, 15_000);
    });
    await step('remote-image', async () => {
      // The thread's agent shows a picture of its folder, as `boite show` does.
      await Bun.write(`/run/bench-watching-${label}`, '');
      await page!.waitFor(`document.querySelector('[data-testid=file-image]')?.complete && document.querySelector('[data-testid=file-image]').naturalWidth > 0 || window.__csp.length > 0`, 20_000);
      const violations = await page!.evaluate<string[]>('window.__csp');
      await page!.screenshot(join(outDir, `${label}-remote-image.png`));
      if (violations.length > 0) throw new Error(`blocked by the shell's CSP: ${violations.join(', ')}`);
    });
  } else {
    const [pairingUrl] = rest as [string];
    await step('open-pairing-link', async () => {
      await page!.navigate(pairingUrl);
      await page!.waitFor(threadVisible, 30_000);
      await page!.screenshot(join(outDir, `${label}-list.png`));
    });
    await step('open-thread', async () => {
      await page!.click(`[data-testid="mobile-thread-${title}"]`);
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]')?.placeholder.startsWith('Message Echo')`, 15_000);
    });
  }

  const prompt = `ping from ${label}`;
  await step('send-and-receive', async () => {
    // Tapped, then typed as a keyboard does, so the composer's own input handling runs.
    await tap('[data-testid=composer-input]');
    await page!.waitFor(`document.activeElement?.dataset.testid === 'composer-input'`, 5_000);
    await page!.send('Input.insertText', { text: prompt });
    await page!.waitFor(`document.querySelector('[data-testid=composer-send]') && !document.querySelector('[data-testid=composer-send]').disabled`, 15_000);
    await page!.click('[data-testid=composer-send]');
    await page!.waitFor(`[...document.querySelectorAll('[data-testid=message][data-role=assistant]')].some(m => m.textContent.includes(${JSON.stringify(prompt)}))`, 30_000);
    await page!.screenshot(join(outDir, `${label}-chat.png`));
  });
  await step('reload-keeps-session', async () => {
    await page!.reload();
    if (desktop) {
      await page!.waitFor(threadVisible, 30_000);
    } else {
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]') || document.querySelector('[data-testid=mobile-list]')`, 30_000);
      await page!.waitFor(threadVisible, 30_000);
    }
    await page!.screenshot(join(outDir, `${label}-after-reload.png`));
  });
  if (desktop && process.env.BENCH_SWITCH === '1') {
    await step('network-switch', async () => {
      // The laptop leaves the network the server answered on first: Wi-Fi off away from
      // home, or Tailscale off at home. The server stays reachable on the other one.
      const machines = `[...document.querySelectorAll('[data-testid=machine-card]')].map(c => c.dataset.machineId + ':' + (c.querySelector('.status')?.textContent ?? '')).join(' ')`;
      await page!.click('[data-testid=nav-settings]');
      await page!.click('[data-testid=settings-tab-machines]');
      await page!.waitFor(`document.querySelectorAll('[data-testid=machine-card] .status.ready').length >= 2`, 30_000);
      const before = await page!.evaluate<string>(machines);
      const viaTailnet = before.includes('100.80.1.10');
      const dropped = viaTailnet ? 'tailscale0' : 'eth0';
      const other = viaTailnet ? '192.168.50.10' : '100.80.1.10';
      await page!.click('[data-testid=settings-back]');
      await page!.waitFor(threadVisible, 30_000);
      await page!.click(`[data-testid=thread-row][data-thread-id="${title}"]`);
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]')`, 15_000);
      // Reading the thread when the network goes; the next prompt is typed a few seconds later.
      Bun.spawnSync(['ip', 'link', 'set', dropped, 'down']);
      const started = Date.now();
      await Bun.sleep(5_000);
      const again = `${prompt} after leaving ${dropped}`;
      await tap('[data-testid=composer-input]');
      await page!.waitFor(`document.activeElement?.dataset.testid === 'composer-input'`, 5_000);
      await page!.send('Input.insertText', { text: again });
      await page!.waitFor(`!document.querySelector('[data-testid=composer-send]').disabled`, 15_000);
      await page!.click('[data-testid=composer-send]');
      try {
        await page!.waitFor(`[...document.querySelectorAll('[data-testid=message][data-role=assistant]')].some(m => m.textContent.includes(${JSON.stringify(again)}))`, 180_000);
      } finally {
        await page!.screenshot(join(outDir, `${label}-switched.png`));
      }
      const answered = Date.now() - started;
      await page!.click('[data-testid=nav-settings]');
      await page!.click('[data-testid=settings-tab-machines]');
      const after = await page!.evaluate<string>(machines);
      await page!.click('[data-testid=settings-back]');
      Bun.spawnSync(['ip', 'link', 'set', dropped, 'up']);
      if (dropped === 'tailscale0') Bun.spawnSync(['ip', 'route', 'replace', '100.64.0.0/10', 'dev', dropped]);
      if (!after.includes(other)) throw new Error(`answered, but not through ${other}: ${after}`);
      return `${dropped} down, answered through ${other} ${answered} ms later`;
    });
  }
  const dev = process.env.BENCH_DEV;
  if (dev) {
    if (!desktop) await step('outage-on-list', async () => {
      // The phone sits on its conversation list when the Wi-Fi drops, then the user taps a thread.
      await page!.waitFor(threadVisible, 30_000);
      Bun.spawnSync(['ip', 'link', 'set', dev, 'down']);
      await Bun.sleep(20_000);
      Bun.spawnSync(['ip', 'link', 'set', dev, 'up']);
      if (dev === 'tailscale0') Bun.spawnSync(['ip', 'route', 'replace', '100.64.0.0/10', 'dev', dev]);
      await page!.screenshot(join(outDir, `${label}-list-back.png`));
      await page!.click(`[data-testid="mobile-thread-${title}"]`);
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]')?.placeholder.startsWith('Message Echo')`, 15_000);
      await page!.waitFor(threadVisible, 15_000);
    });
    await step('link-outage', async () => {
      // The user reads the thread when the Wi-Fi drops for 20 s, then comes back.
      if (desktop) await page!.click(`[data-testid=thread-row][data-thread-id="${title}"]`);
      else {
        await page!.waitFor(threadVisible, 30_000);
        await page!.click(`[data-testid="mobile-thread-${title}"]`);
      }
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]')?.placeholder.startsWith('Message Echo')`, 15_000);
      Bun.spawnSync(['ip', 'link', 'set', dev, 'down']);
      await Bun.sleep(20_000);
      const during = await page!.evaluate<string>(`document.querySelector('[data-testid=composer-input]')?.placeholder ?? '(no composer)'`);
      Bun.spawnSync(['ip', 'link', 'set', dev, 'up']);
      if (dev === 'tailscale0') Bun.spawnSync(['ip', 'route', 'replace', '100.64.0.0/10', 'dev', dev]);
      const started = Date.now();
      await Bun.sleep(1000);
      const after = await page!.evaluate<string>(`document.querySelector('[data-testid=composer-input]')?.placeholder ?? '(no composer)'`);
      console.error(`[client] ${label} composer while offline: ${JSON.stringify(during)}, back: ${JSON.stringify(after)}`);
      await page!.screenshot(join(outDir, `${label}-outage-back.png`));
      await page!.waitFor(`document.querySelector('[data-testid=composer-input]')?.placeholder.startsWith('Message Echo')`, 15_000);
      const again = `${prompt} after outage`;
      await tap('[data-testid=composer-input]');
      await page!.waitFor(`document.activeElement?.dataset.testid === 'composer-input'`, 5_000);
      await page!.send('Input.insertText', { text: again });
      await page!.waitFor(`!document.querySelector('[data-testid=composer-send]').disabled`, 45_000);
      await page!.click('[data-testid=composer-send]');
      await page!.waitFor(`[...document.querySelectorAll('[data-testid=message][data-role=assistant]')].some(m => m.textContent.includes(${JSON.stringify(again)}))`, 45_000);
      await page!.screenshot(join(outDir, `${label}-after-outage.png`));
      return `answered ${Date.now() - started} ms after the link came back`;
    });
  }
  log.push(...page.errors());
} catch (error) {
  steps.push({ step: 'launch', ok: false, ms: 0, detail: (error as Error).message });
} finally {
  await page?.close().catch(() => undefined);
}
console.log(JSON.stringify({ label, ok: steps.every((s) => s.ok), steps, pageErrors: log }));
