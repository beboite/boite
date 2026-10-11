import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { codeVideo } from './lib/qr-video.ts';
import { connect } from '../../packages/core/src/client.ts';

/**
 * A phone is added by pointing its camera at the code "Add a device" draws.
 * The camera here is Chromium's fake one, playing a one-frame video of the
 * code, so the whole path runs: the stream, the decoder, the admission of the
 * phone's key, and the machine it then reaches.
 */

let server: { close(): Promise<void> };
let page: BrowserPage | undefined;
let url: string;
const cores: RunningCore[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'boite-e2e-scan-'));
const id = (name: string) => `[data-testid="${name}"]`;

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

test('a phone scans the code of Add a device: another code leaves the camera open, closing stops it, the real one adds the phone', async () => {
  const machine = await startCore();
  cores.push(machine);
  const owner = await connect(machine.url, machine.token);
  try {
    await owner.call('settings.set', { browserOrigins: [url] });
    const added = await owner.call('group.addDevice', {});
    const video = join(scratch, 'code.y4m');
    // The camera first shows a code that is no link to add a device, then the real one.
    writeFileSync(video, codeVideo('https://example.com/not-a-link-to-add-a-device'));
    page = await BrowserPage.launch({
      url: `${url}/?core=${encodeURIComponent(machine.url)}`,
      windowSize: { width: 390, height: 844 },
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`]
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    // A machine this phone never reached: the page asks before it talks to it.
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    await page.waitFor(`document.querySelector('${id('mobile-connect')} ${id('machine-scan')}')`, 30_000);
    // Both ways in span the page: a thumb reaches them from either side.
    expect(await page.evaluate(`[...document.querySelectorAll('${id('machine-scan')}, ${id('machine-code-open')}')].every(button => button.getBoundingClientRect().width >= 300)`)).toBe(true);
    await page.click(id('machine-scan'));
    await page.waitFor(`document.querySelector('${id('qr-scanner')} video.live')`);
    // A code that is not a link to add a device leaves the camera open and adds nothing.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await page.evaluate(`!!document.querySelector('${id('qr-scanner')}')`)).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'phone-scanner.png'));
    // Closing it stops the camera: no track of the stream is left live.
    await page.evaluate(`globalThis.__scanStream = document.querySelector('${id('qr-scanner')} video').srcObject`);
    await page.click(id('qr-scanner-close'));
    await page.waitFor(`!document.querySelector('${id('qr-scanner')}')`);
    expect(await page.evaluate(`globalThis.__scanStream.getTracks().every(track => track.readyState === 'ended')`)).toBe(true);
    writeFileSync(video, codeVideo(added.url.split('#')[0]!));
    await page.click(id('machine-scan'));
    await page.waitFor(`document.querySelector('${id('qr-scanner')}')`);
    await page.waitFor(`globalThis.__boiteTest.workspace.machines[0]?.store.connection === 'ready' && !document.querySelector('${id('qr-scanner')}')`, 30_000);
    // The phone is a device of the machine's group now, under its own key.
    const group = await owner.call('group.get', {});
    expect(group?.devices).toHaveLength(1);
    expect((await owner.call('sessions.list', {})).length).toBe(1);
  } finally {
    owner.close();
  }
}, 90_000);
