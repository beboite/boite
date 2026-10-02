import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
const store = 'globalThis.__boiteTest.workspace.active';

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
}, 60_000);
afterAll(async () => { await server?.close(); });

for (const [name, width, height, mobile] of [['desktop', 1280, 900, false], ['phone', 390, 844, true]] as const) {
  test(`agent connection cards can close on ${name}`, async () => {
    const page = await BrowserPage.launch({ url, windowSize: { width, height } });
    const capture = async (state: string) => {
      await page.evaluate('document.fonts.ready');
      await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
      await page.screenshot(join(import.meta.dir, '.artifacts', `agent-connections-${state}-${name}.png`));
    };
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await page.waitFor(`${store}?.connection === 'ready'`);
      await page.evaluate(`${store}.openConnect('claude', 'a-claude-side')`);
      await page.waitFor(`document.querySelector('${id('connect-sign-in')}')`);
      await page.click(id('connect-sign-in'));
      await page.waitFor(`document.querySelector('${id('connect-login-url')}')`);
      await capture('login');
      expect(await page.evaluate(`document.querySelector('${id('connect-login-cancel')}').getBoundingClientRect().bottom <= innerHeight`)).toBe(true);
      await page.click(id('connect-login-cancel'));
      await page.waitFor(`document.querySelector('${id('connect-sign-in')}')`);
      expect(await page.evaluate(`${store}.client.call('accounts.logins', {}).then(rows => rows.length)`)).toBe(0);
      await page.click(id('connect-close'));
      await page.waitFor(`!document.querySelector('${id('connect-dialog')}')`);

      if (!mobile) {
        await page.evaluate(`${store}.showSettings('machines')`);
        await page.waitFor(`document.querySelector('${id('pairing-mint')}')`);
        await page.click(id('pairing-mint'));
        await page.waitFor(`document.querySelector('${id('pairing-link')}')`);
        const first = await page.evaluate(`${store}.pairing.grant`);
        await page.evaluate(`document.querySelector('${id('pairing-card')}').scrollIntoView()`);
        await capture('pairing');
        await page.click(id('pairing-close'));
        await page.waitFor(`!document.querySelector('${id('pairing-link')}') && !document.querySelector('${id('pairing-qr')}')`);
        await page.click(id('pairing-mint'));
        await page.waitFor(`document.querySelector('${id('pairing-link')}')`);
        expect(await page.evaluate(`${store}.pairing.grant`)).not.toBe(first);
        await page.click(id('pairing-close'));

        await page.evaluate(`${store}.showSettings('accounts'); ${store}.logins['a-claude-side'] = { state: 'failed', output: 'Sign-in failed', url: null, exitCode: 1 };`);
        await page.waitFor(`document.querySelector('${id('account-login-dismiss')}')`);
        await capture('failed');
        await page.click(id('account-login-dismiss'));
        await page.waitFor(`!document.querySelector('${id('account-login-row')}')`);
        await page.click('[data-provider-id="claude"] [data-testid="provider-details-toggle"]');
        await page.waitFor('document.querySelector("[data-testid=account-remove][data-account-id=a-claude-side]")');
        await page.click('[data-testid="account-remove"][data-account-id="a-claude-side"]');
        await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
        await page.click(id('confirm-ok'));
        await page.waitFor(`${store}.accounts.every(account => account.id !== 'a-claude-side')`);
      }
      expect(page.errors()).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
}
