import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

/*
 * The phone's way in on a real core: the Tailscale switch against a fake CLI
 * (never the machine's own), the pairing code, the owner QR code, and the
 * recovery screen a revoked phone gets, narrow and wide. Captures go to
 * `.artifacts`, or to `BOITE_E2E_CAPTURES` when set.
 */

const FAKE_CLI = join(import.meta.dir, '..', '..', 'packages', 'core', 'test', 'fixtures', 'fake-tailscale.ts');
const DNS = 'skoll-test.tail0000.ts.net';
const captures = process.env['BOITE_E2E_CAPTURES'] ?? join(import.meta.dir, '.artifacts');
const id = (name: string) => `[data-testid="${name}"]`;

let core: RunningCore;
let desk: BrowserPage;
let stateDir: string;
let statePath: string;

const DESKTOP = { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

function writeState(serve: Record<string, unknown> = {}): void {
  writeFileSync(statePath, JSON.stringify({
    status: { BackendState: 'Running', Self: { DNSName: `${DNS}.` }, CertDomains: [DNS], CurrentTailnet: { MagicDNSEnabled: true } },
    serve,
  }));
}

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(captures, name));
}

async function scrollTo(page: BrowserPage, selector: string): Promise<void> {
  await page.evaluate(`document.querySelector('${selector}')?.scrollIntoView({ block: 'start' })`);
  await Bun.sleep(150);
}

beforeAll(async () => {
  mkdirSync(captures, { recursive: true });
  stateDir = mkdtempSync(join(tmpdir(), 'boite-e2e-tailscale-'));
  statePath = join(stateDir, 'state.json');
  writeState();
  core = await startCore({ env: { BOITE_TAILSCALE_CLI: FAKE_CLI, FAKE_TAILSCALE_STATE: statePath } });
  desk = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await desk.send('Emulation.setDeviceMetricsOverride', DESKTOP);
}, 60_000);

afterAll(async () => {
  await desk?.close();
  await core?.stop();
}, 15_000);

test('the Tailscale switch serves the core, the links follow it, and 443 held by another target is replaced only when confirmed', async () => {
  await desk.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await desk.click(id('nav-settings'));
  await desk.waitFor(`document.querySelector('${id('settings-tab-machines')}')`);
  await desk.click(id('settings-tab-machines'));
  await desk.waitFor(`document.querySelector('${id('tailscale-access')}[data-state="off"]')`);
  await scrollTo(desk, id('tailscale-access'));
  await capture(desk, 'tailscale-off-desktop.png');

  await desk.click(id('tailscale-enable'));
  await desk.waitFor(`document.querySelector('${id('tailscale-access')}[data-state="on"]')`);
  await desk.waitFor(`document.querySelector('${id('pairing-link')}')?.textContent.startsWith('https://${DNS}/?grant=')`);
  expect(await desk.evaluate(`!!document.querySelector('${id('pairing-code')}')`)).toBe(true);
  expect(readFileSync(`${statePath}.log`, 'utf8')).toContain(`serve --bg --https=443 http://127.0.0.1:${core.port}`);
  await scrollTo(desk, id('pairing-card'));
  await capture(desk, 'pairing-code-desktop.png');
  await scrollTo(desk, id('tailscale-access'));
  await capture(desk, 'tailscale-on-desktop.png');

  // Off: nothing served, and the public URL it set goes with it.
  await desk.click(id('tailscale-disable'));
  await desk.waitFor(`document.querySelector('${id('confirm-dialog')}')`);
  await desk.click(id('confirm-ok'));
  await desk.waitFor(`document.querySelector('${id('tailscale-access')}[data-state="off"]')`);
  expect(readFileSync(`${statePath}.log`, 'utf8')).toContain('serve --https=443 off');
  await desk.click(id('pairing-mint'));
  await desk.waitFor(`document.querySelector('${id('pairing-link')}')?.textContent.startsWith(${JSON.stringify(`${core.url}/?grant=`)})`);

  // Something else on 443: named, and replaced only after the dialog.
  writeState({ TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:17338' } } } } });
  await desk.click(id('tailscale-refresh'));
  await desk.waitFor(`document.querySelector('${id('tailscale-access')}[data-state="conflict"]')`);
  expect(await desk.text(id('tailscale-state'))).toContain('http://127.0.0.1:17338');
  await scrollTo(desk, id('tailscale-access'));
  await capture(desk, 'tailscale-conflict-desktop.png');
  await desk.click(id('tailscale-replace'));
  await desk.waitFor(`document.querySelector('${id('confirm-dialog')}')`);
  await capture(desk, 'tailscale-replace-confirm-desktop.png');
  await desk.click(id('confirm-cancel'));
  await desk.waitFor(`!document.querySelector('${id('confirm-dialog')}')`);
  expect(JSON.parse(readFileSync(statePath, 'utf8')).serve.Web[`${DNS}:443`].Handlers['/'].Proxy).toBe('http://127.0.0.1:17338');

  writeState();
  await desk.click(id('tailscale-refresh'));
  await desk.waitFor(`document.querySelector('${id('tailscale-access')}[data-state="off"]')`);
}, 90_000);

test('an owner link is drawn only once confirmed on the computer', async () => {
  await scrollTo(desk, id('pairing-card'));
  await desk.click(id('pairing-owner'));
  await desk.click(id('pairing-mint'));
  await desk.waitFor(`document.querySelector('${id('pairing-owner-qr')}')`);
  expect(await desk.evaluate(`!!document.querySelector('${id('pairing-qr')}')`)).toBe(false);
  await desk.click(id('pairing-owner-qr'));
  await desk.waitFor(`document.querySelector('${id('confirm-dialog')}')`);
  await capture(desk, 'owner-qr-confirm-desktop.png');
  await desk.click(id('confirm-ok'));
  await desk.waitFor(`document.querySelector('${id('pairing-qr')}') && document.querySelector('${id('pairing-code')}')`);
  await scrollTo(desk, id('pairing-card'));
  await capture(desk, 'owner-qr-desktop.png');
  await desk.click(id('pairing-owner'));
  await desk.click(id('pairing-close'));
}, 60_000);

test('the installed phone app pairs from a typed code, and a revoked one gets the recovery screen, narrow and wide', async () => {
  const phone = await BrowserPage.launch({ url: 'about:blank' });
  try {
    await phone.send('Emulation.setDeviceMetricsOverride', PHONE);
    // A home-screen app, as iOS says it: `navigator.standalone`.
    await phone.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })` });
    await phone.navigate(`${core.url}/`);
    await phone.waitFor(`document.querySelector('${id('mobile-connect')}') && document.querySelector('${id('machine-code-open')}')`);
    expect(await phone.text(id('mobile-pair-hint'))).toContain('Camera app');
    await capture(phone, 'pair-installed-phone.png');

    const owner = await connect(core.url, core.token);
    try {
      const minted = await owner.call('pairing.grant', {});
      await phone.click(id('machine-code-open'));
      await phone.waitFor(`document.querySelector('${id('machine-code')}')`);
      await phone.type(id('machine-code'), (minted.code ?? '').toLowerCase());
      await capture(phone, 'pair-code-entry-phone.png');
      await phone.click(id('machine-code-submit'));
      await phone.waitFor(`!document.querySelector('${id('mobile-connect')}')`, 20_000);
      const sessions = await owner.call('sessions.list', {});
      expect(sessions.map((session) => session.role)).toEqual(['device']);

      // Revoked from the computer: the recovery screen, not a stale page.
      await owner.call('sessions.revoke', { sessionId: sessions[0]!.id });
      await phone.waitFor(`document.querySelector('${id('mobile-connect')}')`, 20_000);
      await capture(phone, 'recovery-revoked-phone.png');
      await phone.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
      await phone.waitFor(`document.querySelector('${id('wide-recovery')}') && document.querySelector('${id('machine-scan')}')`);
      await capture(phone, 'recovery-revoked-landscape.png');
      await phone.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await phone.waitFor(`document.querySelector('${id('wide-recovery')}')`);
      await capture(phone, 'recovery-revoked-desktop.png');

      // From the wide screen too, a fresh code pairs again.
      const again = await owner.call('pairing.grant', {});
      await phone.click(id('machine-code-open'));
      await phone.waitFor(`document.querySelector('${id('machine-code')}')`);
      await phone.type(id('machine-code'), again.code ?? '');
      await phone.click(id('machine-code-submit'));
      await phone.waitFor(`!document.querySelector('${id('wide-recovery')}')`, 20_000);
    } finally {
      owner.close();
    }
  } finally {
    await phone.close();
  }
}, 120_000);
