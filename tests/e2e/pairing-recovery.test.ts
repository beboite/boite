import { mobileAction } from './lib/mobile.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage } from './lib/cdp.ts';
import { startCore, type RunningCore } from './lib/core.ts';
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
}, 30_000);

test('a phone with no key is added again from Machines with a pasted link and sees its threads', async () => {
  await page.waitFor(`document.querySelector('${id('mobile-header')}')`);
  await mobileAction(page, 'mobile-settings');
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  await page.click(id('mobile-settings-connection'));
  await page.waitFor(`document.querySelector('${id('machine-card')}')`);
  // Refused, and named by its address: it is not this phone, and it never answered.
  await page.waitFor(`document.querySelector('${id('machine-card')} .status')?.textContent === 'Add this app to your group'`);
  expect(await page.evaluate(`!!document.querySelector('${id('machine-repair')}') && !!document.querySelector('${id('machine-card')} .pair-hint')`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('machine-card')} .status.ready') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('machine-rename')}').value`)).toBe(new URL(core.url).host);
  expect(await page.evaluate(`document.querySelector('${id('machine-remove')}') === null`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-refused-phone.png'));

  // A phone that reaches no machine is offered its two ways in at the top of the page: the link of Add a device, pasted.
  const owner = await connect(core.url, core.token);
  const added = await owner.call('group.addDevice', {});
  owner.close();
  await page.click(id('machine-paste-open'));
  await page.waitFor(`document.querySelector('${id('machine-paste-form')} ${id('machine-link')}')`);
  await page.type(id('machine-link'), added.url);
  await page.click(id('machine-add'));
  await page.waitFor(`document.querySelector('${id('machine-card')} .status.ready')`, 20_000);
  // Added: the ways in fold away, and the machine and this phone are in one group card.
  await page.waitFor(`!document.querySelector('${id('machine-paste-open')}') && !!document.querySelector('${id('group-device')}')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('machine-card')}').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('${id('machine-card')} .error') === null`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-paired-phone.png'));

  await page.click(id('mobile-settings-back'));
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`[...document.querySelectorAll('${id('mobile-list')} .thread')].some(row => row.textContent.includes('Seen once paired'))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pairing-recovery-threads-phone.png'));

  // The device key is this phone's own: a reload needs no link.
  await page.reload();
  await page.waitFor(`document.querySelector('${id('mobile-header')}')`);
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`[...document.querySelectorAll('${id('mobile-list')} .thread')].some(row => row.textContent.includes('Seen once paired'))`);
}, 60_000);
