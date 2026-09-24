import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { createBrowserLabEngineTransportFix } from './browser-lab-transport-fix.ts';
import { useDirectCapture } from './browser-lab-capture.ts';

// A deterministic access diagnostic, never an autonomous task success or timing sample.
async function main() {
  if (process.env.BOITE_BENCH_BOOKING_PROBE !== '1') throw new Error('Live Booking diagnostic is opt-in.');
  const output = resolve(process.env.BOITE_BENCH_OUTPUT ?? '');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY, modulePath = process.env.BOITE_BENCH_PLAYWRIGHT_MODULE;
  if (!process.env.BOITE_BENCH_OUTPUT || existsSync(output) || !binary || !modulePath) throw new Error('Fresh output and browser/Playwright paths required.');
  mkdirSync(output, { recursive: true });
  const harness = await startTestCore(), log: any[] = [], steps: any[] = [];
  let engine: Awaited<ReturnType<typeof createBrowserLabEngineTransportFix>> | undefined, browser: any;
  let capture: ((name: string) => Promise<void>) | undefined;
  const summary: any = { kind: 'deterministic public search diagnostic; not agent evaluation' };
  try {
    engine = await createBrowserLabEngineTransportFix('playwright', { core: harness.core, taskId: 'booking-access-probe', binary, executablePath: findBrowser() });
    await useDirectCapture(engine, () => {});
    const pw = await import(pathToFileURL(modulePath).href);
    browser = await pw.chromium.connectOverCDP(engine.cdpUrl);
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
    try { await browser?.close(); } finally {
      try { await engine?.close(); } finally {
        summary.processesAfter = harness.core.procs.liveCount('browser:booking-access-probe');
        try { await harness.stop(); } finally { writeFileSync(join(output, 'network.json'), JSON.stringify(log, null, 2)); writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2)); }
      }
    }
  }
  console.log(JSON.stringify(summary));
}
if (import.meta.main) await main();
