import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { createBrowserLabEngineTransportFix } from './browser-lab-transport-fix.ts';
import { useDirectCapture } from './browser-lab-capture.ts';

async function prepareHelium(url: string, events: any[]) {
  const socket = new WebSocket(url), pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let next = 0;
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    if (/^(Target\.|Inspector\.)/.test(value.method ?? '')) events.push({ at: Date.now(), ...value });
    const item = pending.get(value.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    if (value.error) item.reject(new Error(JSON.stringify(value.error))); else item.resolve(value.result);
  });
  const close = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Helium readiness CDP closed.')); } pending.clear(); socket.close(); };
  socket.addEventListener('close', () => events.push({ at: Date.now(), type: 'cdp-close' }));
  socket.addEventListener('error', () => events.push({ at: Date.now(), type: 'cdp-error' }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error('Helium readiness CDP connection timeout.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Helium readiness CDP connection error.')); }, { once: true });
    });
    const send = (method: string, params: any, sessionId?: string) => new Promise<any>((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Helium readiness ' + method + ' timeout.')); }, 5000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    await send('Target.setDiscoverTargets', { discover: true });
    const started = performance.now(), deadline = started + 60_000;
    let sessionId: string | undefined;
    while (performance.now() < deadline) {
      if (!sessionId) {
        const targets = await send('Target.getTargets', {});
        const block = targets.targetInfos.find((target: any) => target.url.startsWith('chrome-extension://blockjmkbacgjkknlgpkjjiijinjdanf/'));
        if (block) sessionId = (await send('Target.attachToTarget', { targetId: block.targetId, flatten: true })).sessionId;
      }
      if (sessionId) {
        const ready = await send('Runtime.evaluate', { expression: 'typeof µBlock !== "undefined" && µBlock.readyToFilter === true', returnByValue: true }, sessionId);
        if (ready.result?.value === true) return { close, readyToFilter: true, readinessMs: performance.now() - started };
      }
      // Condition polling, not a fixed delay before navigation.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Helium uBlock.readyToFilter was not true within 60000ms.');
  } catch (error) { close(); throw error; }
}

// A deterministic access diagnostic, never an autonomous task success or timing sample.
async function main() {
  if (process.env.BOITE_BENCH_BOOKING_PROBE !== '1') throw new Error('Live Booking diagnostic is opt-in.');
  const output = resolve(process.env.BOITE_BENCH_OUTPUT ?? '');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY, modulePath = process.env.BOITE_BENCH_PLAYWRIGHT_MODULE;
  if (!process.env.BOITE_BENCH_OUTPUT || existsSync(output) || !binary || !modulePath) throw new Error('Fresh output and browser/Playwright paths required.');
  mkdirSync(output, { recursive: true });
  const harness = await startTestCore(), log: any[] = [], steps: any[] = [], cdpEvents: any[] = [];
  let engine: Awaited<ReturnType<typeof createBrowserLabEngineTransportFix>> | undefined, browser: any;
  let helium: Awaited<ReturnType<typeof prepareHelium>> | undefined;
  let capture: ((name: string) => Promise<void>) | undefined;
  const summary: any = { kind: 'deterministic public search diagnostic; not agent evaluation' };
  try {
    engine = await createBrowserLabEngineTransportFix('playwright', { core: harness.core, taskId: 'booking-access-probe', binary, executablePath: findBrowser() });
    await useDirectCapture(engine, () => {});
    const pw = await import(pathToFileURL(modulePath).href);
    browser = await pw.chromium.connectOverCDP(engine.cdpUrl);
    if (/helium/i.test(findBrowser())) {
      helium = await prepareHelium(engine.cdpUrl, cdpEvents);
      summary.helium = { readyToFilter: helium.readyToFilter, readinessMs: helium.readinessMs };
    }
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(10000);
    page.on('response', (response: any) => {
      if (response.request().resourceType() === 'document') log.push({ type: 'document', url: response.url(), status: response.status() });
    });
    page.on('requestfailed', (request: any) => log.push({ type: 'failed', resource: request.resourceType(), url: request.url(), failure: request.failure() }));
    capture = async (name: string) => {
      const state = { name, url: page.url(), snapshot: await page.locator('body').ariaSnapshot(), forms: await page.evaluate(() => Array.from(document.forms).map(form => ({ action: form.action, method: form.method, fields: Array.from(form.elements).filter(element => /^(ss|dest_id|checkin|checkout|group_adults|group_children|no_rooms)$/.test((element as HTMLInputElement).name)).map(element => ({ name: (element as HTMLInputElement).name, value: (element as HTMLInputElement).value })) }))) };
      steps.push(state); writeFileSync(join(output, name + '.json'), JSON.stringify(state, null, 2));
      await engine!.command('screenshot', { path: join(output, name + '.png') });
    };
    await engine.command('viewport', { width: 1280, height: 800 });
    await engine.command('navigate', { url: 'https://www.booking.com/', waitUntil: 'domcontentloaded' });
    await page.getByRole('combobox', { name: 'Indiquez la destination', exact: true }).waitFor();
    for (const name of ['Refuser', 'Ignorer les infos relatives à la connexion']) {
      const button = page.getByRole('button', { name, exact: true });
      await page.addLocatorHandler(button, async () => { await button.click(); });
    }
    await capture('01-home');
    const destination = page.getByRole('combobox', { name: 'Indiquez la destination', exact: true });
    const paris = page.getByRole('option', { name: /^Paris.*France/s }).first();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await destination.click();
      await destination.fill('Paris');
      try { await paris.waitFor({ timeout: 2000 }); break; }
      catch (error) { steps.push({ attempt, suggestionWait: String(error) }); }
    }
    await capture('02-suggestions');
    await paris.click();
    await page.getByRole('gridcell', { name: 'lundi 12 octobre 2026', exact: true }).click();
    await page.getByRole('gridcell', { name: 'jeudi 15 octobre 2026', exact: true }).click();
    await capture('02-ready');
    await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
    await page.waitForURL((url: URL) => url.pathname !== '/index.fr.html' && url.pathname !== '/', { waitUntil: 'domcontentloaded' }).catch((error: Error) => { summary.navigationWait = error.message; });
    await page.locator('body').waitFor();
    await capture('03-submitted');
    summary.finalUrl = page.url(); summary.engine = engine.metadata;
  } catch (error) { summary.error = String(error); try { await capture?.('error'); } catch (captureError) { summary.captureError = String(captureError); } }
  finally {
    try { helium?.close(); await browser?.close(); } finally {
      try { await engine?.close(); } finally {
        summary.processesAfter = harness.core.procs.liveCount('browser:booking-access-probe');
        try { await harness.stop(); } finally { writeFileSync(join(output, 'network.json'), JSON.stringify(log, null, 2)); writeFileSync(join(output, 'cdp-events.json'), JSON.stringify(cdpEvents, null, 2)); writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2)); }
      }
    }
  }
  console.log(JSON.stringify(summary));
}
if (import.meta.main) await main();
