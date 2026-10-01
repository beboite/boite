import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

let core: RunningCore;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;

beforeAll(async () => {
  core = await startCore();
  const owner = await connect(core.url, core.token);
  try {
    const project = await owner.call('projects.add', { path: core.dataDir, name: 'Paired project' });
    const account = (await owner.call('accounts.list', {})).find((a) => a.providerId === 'echo')!;
    await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Seen once paired' });
  } finally {
    owner.close();
  }
  // The page its own core serves, opened with no key: a phone whose pairing is gone.
  page = await BrowserPage.launch({ url: `${core.url}/` });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
}, 60_000);
afterAll(async () => {
  await page?.close();
  await core?.stop();
}, 15_000);

test('a phone with no key pairs again from Machines and sees its threads', async () => {
  await page.waitFor(`document.querySelector('${id('mobile-tabs')}')`);
  await page.click(id('mobile-settings'));
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('machine-card')}')`);
  // Refused, and named by its address: it is not this phone, and it never answered.
  await page.waitFor(`document.querySelector('${id('machine-card')} .error')?.textContent.includes('holds no key')`);
  expect(await page.evaluate(`document.querySelector('${id('machine-card')} .status.ready') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('machine-rename')}').value`)).toBe(new URL(core.url).host);
  expect(await page.evaluate(`document.querySelector('${id('machine-remove')}') === null`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-refused-phone.png'));

  await page.click(id('machine-add-open'));
  await page.type(id('machine-link'), await mintPairing(core));
  // Before anything connects, the form names the machine the link reaches.
  await page.waitFor(`document.querySelector('${id('machine-link-target')}')?.textContent.includes(${JSON.stringify(new URL(core.url).host)})`);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-link-target-phone.png'));
  await page.click(id('machine-add'));
  await page.waitFor(`document.querySelector('${id('machine-card')} .status.ready')`);
  // The form folds on success; a refused link would have kept it open on its error.
  await page.waitFor(`document.querySelector('${id('machine-add-open')}')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('machine-card')}').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('${id('machine-card')} .error') === null`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-paired-phone.png'));

  await page.click(id('mobile-settings-back'));
  await page.click(id('mobile-conversations'));
  await page.waitFor(`[...document.querySelectorAll('${id('mobile-list')} .thread')].some(row => row.textContent.includes('Seen once paired'))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-threads-phone.png'));

  // The key the link became is this device's own: a reload needs no link.
  await page.reload();
  await page.waitFor(`document.querySelector('${id('mobile-tabs')}')`);
  await page.click(id('mobile-conversations'));
  await page.waitFor(`[...document.querySelectorAll('${id('mobile-list')} .thread')].some(row => row.textContent.includes('Seen once paired'))`);
}, 60_000);
