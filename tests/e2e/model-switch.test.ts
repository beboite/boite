import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

let core: RunningCore;
let client: CoreClient;
let page: BrowserPage;
let threadId: string;
let accountId: string;
const selector = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

beforeAll(async () => {
  core = await startCore();
  client = await connect(core.url, core.token);
  const profile = {
    detect: {}, executable: [{ kind: 'path', value: 'bun' }], isolation: {},
    launch: { args: [resolve('packages/core/test/fixtures/acp-agent.ts')] },
  };
  mkdirSync(join(core.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(core.dataDir, 'providers', 'switch-acp.json'), JSON.stringify({
    id: 'switch-acp', schemaVersion: 1, name: 'Switch ACP', shortName: 'ACP', protocol: 'acp',
    roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' }, models: [{ id: 'default', name: 'Agent default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
  }));
  await client.call('providers.reload', {});
  const account = await client.call('accounts.add', { providerId: 'switch-acp', label: 'Test account', useDefaultLocation: true });
  accountId = account.id;
  const echo = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
  const project = await client.call('projects.add', { path: core.dataDir, name: 'Model continuity' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: echo.id, title: 'One conversation' });
  threadId = thread.id;
  const done = new Promise<void>((resolve) => {
    const off = client.on('turn.finished', (turn) => { if (turn.threadId === threadId) { off(); resolve(); } });
  });
  await client.call('turns.start', { threadId, prompt: 'The release code is azure-42.' });
  await done;
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await page.waitFor(`document.querySelector('${selector('composer-picker')}')`);
}, 30_000);

afterAll(async () => { await page?.close(); client?.close(); await core?.stop(); });

test('the picker changes native protocols in one conversation and carries history over real RPC and stdio', async () => {
  await page.click(selector('composer-picker'));
  const tile = '[data-testid="composer-picker-menu"] [data-provider="switch-acp"]';
  await page.waitFor(`document.querySelector('${tile}') && !document.querySelector('${tile}').disabled`);
  await page.click(tile);
  await page.waitFor(`document.querySelector('[data-model="default"]') && !document.querySelector('[data-model="default"]').disabled`);
  await capture('model-switch-picker.png');
  await page.click('[data-model="default"]');
  await page.waitFor(`document.querySelector('${selector('composer-picker')}')?.textContent.includes('Agent default')`);
  expect((await client.call('threads.get', { threadId })).accountId).toBe(accountId);
  await page.type(selector('composer-input'), 'Continue using the release code.');
  await page.click(selector('composer-send'));
  await page.waitFor(`document.querySelectorAll('[data-testid="message"][data-role="assistant"]').length === 2`);
  await page.waitFor(`Array.from(document.querySelectorAll('[data-testid="message"][data-role="assistant"]')).at(-1)?.textContent.includes('azure-42')`);
  const thread = await client.call('threads.get', { threadId });
  expect(thread.messages.filter((message) => message.role === 'user').at(-1)?.parts).toEqual([{ type: 'text', text: 'Continue using the release code.' }]);
  expect((await client.call('threads.list', {}))).toHaveLength(1);
  await page.evaluate('document.fonts.ready');
  await capture('model-switch-conversation.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click(selector('composer-picker'));
  await page.waitFor(`document.querySelector('${tile}')`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await capture('model-switch-phone.png');
}, 60_000);
