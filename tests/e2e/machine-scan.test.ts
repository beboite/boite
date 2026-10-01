import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrMatrix } from '../../packages/ui/src/lib/qr.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

/**
 * A phone adds a machine by pointing its camera at the code the machine draws.
 * The camera here is Chromium's fake one, playing a one-frame video of the code
 * of a real pairing link, so the whole path runs: the stream, the decoder, the
 * grant exchange, and the name the new machine arrives with.
 */

let server: { close(): Promise<void> };
let page: BrowserPage | undefined;
let url: string;
const cores: RunningCore[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'boite-e2e-scan-'));
const id = (name: string) => `[data-testid="${name}"]`;

/** One frame of raw YUV 4:2:0 video, the QR code black on white in its middle. */
function codeVideo(text: string, width = 640, height = 480): Uint8Array {
  const modules = qrMatrix(text);
  const scale = Math.floor((height * 0.8) / modules.length);
  const left = Math.floor((width - modules.length * scale) / 2), top = Math.floor((height - modules.length * scale) / 2);
  const luma = new Uint8Array(width * height).fill(235);
  modules.forEach((line, row) => line.forEach((dark, column) => {
    if (!dark) return;
    for (let y = 0; y < scale; y += 1) luma.fill(16, (top + row * scale + y) * width + left + column * scale, (top + row * scale + y) * width + left + (column + 1) * scale);
  }));
  const chroma = new Uint8Array((width * height) / 2).fill(128);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\nFRAME\n`), luma, chroma]);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}`;
}, 30_000);
afterAll(async () => {
  await page?.close();
  await server?.close();
  for (const core of cores) await core.stop();
  rmSync(scratch, { recursive: true, force: true });
}, 15_000);

test('a phone scans the pairing code of another machine, which arrives under its own name', async () => {
  const first = await startCore(), second = await startCore();
  cores.push(first, second);
  const a = await connect(first.url, first.token), b = await connect(second.url, second.token);
  try {
    await Promise.all([a.call('settings.set', { browserOrigins: [url] }), b.call('settings.set', { browserOrigins: [url] })]);
    const grant = await b.call('pairing.grant', {});
    const video = join(scratch, 'code.y4m');
    // The camera first shows a code that is no pairing link, then the real one.
    writeFileSync(video, codeVideo('https://example.com/not-a-pairing-link'));
    page = await BrowserPage.launch({
      url: `${url}/?core=${encodeURIComponent(first.url)}&token=${encodeURIComponent(first.token)}`,
      windowSize: { width: 390, height: 844 },
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`]
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    await page.waitFor(`document.querySelector('${id('mobile-tabs')}')`);
    await page.click(id('mobile-settings'));
    await page.click(id('settings-tab-machines'));
    await page.waitFor(`document.querySelector('${id('machine-scan')}')`);
    // The form asks for a link and nothing else: the machine names itself.
    expect(await page.evaluate(`document.querySelector('${id('machine-name')}') === null`)).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'phone-machines-scan-button.png'));
    // Both ways in span the page: a thumb reaches them from either side.
    expect(await page.evaluate(`[...document.querySelectorAll('${id('machine-scan')}, ${id('machine-add-open')}')].every(button => button.getBoundingClientRect().width >= 340)`)).toBe(true);
    await page.click(id('machine-scan'));
    await page.waitFor(`document.querySelector('${id('qr-scanner')} video.live')`);
    // A code that is not a pairing link leaves the camera open and adds nothing.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await page.evaluate(`!!document.querySelector('${id('qr-scanner')}') && document.querySelectorAll('${id('machine-card')}').length === 1`)).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'phone-machines-scanner.png'));
    // Closing it stops the camera: no track of the stream is left live.
    await page.evaluate(`globalThis.__scanStream = document.querySelector('${id('qr-scanner')} video').srcObject`);
    await page.click(id('qr-scanner-close'));
    await page.waitFor(`!document.querySelector('${id('qr-scanner')}')`);
    expect(await page.evaluate(`globalThis.__scanStream.getTracks().every(track => track.readyState === 'ended')`)).toBe(true);
    writeFileSync(video, codeVideo(grant.url));
    await page.click(id('machine-scan'));
    await page.waitFor(`document.querySelector('${id('qr-scanner')}')`);
    await page.waitFor(`document.querySelectorAll('${id('machine-card')}').length === 2 && !document.querySelector('${id('qr-scanner')}')`);
    // The card is drawn under its address while the grant is exchanged, then takes the name the core reports.
    await page.waitFor(`globalThis.__boiteTest.workspace.machines[1]?.store.connection === 'ready' && !document.querySelector('${id('machine-add')}').textContent.includes('Connecting')`);
    await page.waitFor(`document.querySelectorAll('${id('machine-rename')}')[1]?.value === ${JSON.stringify(hostname())}`);
    expect(await page.evaluate(`document.querySelector('${id('machine-add-card')} [role=alert]') === null`)).toBe(true);
    expect((await b.call('sessions.list', {})).length).toBe(1);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'phone-machines-scanned.png'));
    // The name is the card's to change afterwards.
    await page.type(`${id('machine-card')}:nth-of-type(2) ${id('machine-rename')}`, 'Build host');
    await page.evaluate(`(() => { const input = document.querySelectorAll('${id('machine-rename')}')[1]; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.waitFor(`globalThis.__boiteTest.workspace.machines[1]?.label === 'Build host'`);
  } finally {
    a.close();
    b.close();
  }
}, 90_000);
