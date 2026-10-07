import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

let core: RunningCore;
let client: CoreClient;
let page: BrowserPage | undefined;
let threadId: string;
let state: string;
const selector = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page!.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page!.screenshot(join(import.meta.dir, '.artifacts', name));
}
const desktop = () => page!.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
const phone = () => page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
const until = async (check: () => Promise<boolean>, ms = 20_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 50));
  }
};

beforeAll(async () => {
  core = await startCore();
  client = await connect(core.url, core.token);
  // An agent whose turns run on the echo driver and whose updater waits for a file, so the pause can be watched.
  state = join(core.dataDir, 'fake-version.txt');
  writeFileSync(state, '1.0.0');
  const fixture = resolve('packages/core/test/fixtures/update-agent.ts');
  const profile = {
    detect: {}, executable: [{ kind: 'path', value: 'bun' }], isolation: {},
    update: { versionArgs: [fixture, state, '--version'], latestArgs: [fixture, state, 'check'], args: [fixture, state, 'update-gated'] },
  };
  mkdirSync(join(core.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(core.dataDir, 'providers', 'update-fake.json'), JSON.stringify({
    id: 'update-fake', schemaVersion: 1, name: 'Fake Agent', shortName: 'Fake', protocol: 'echo',
    roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' }, models: [{ id: 'default', name: 'Agent default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  }));
  await client.call('providers.reload', {});
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'update-fake')!;
  const project = await client.call('projects.add', { path: core.dataDir, name: 'Agent update' });
  threadId = (await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'Long build' })).id;
}, 60_000);

afterAll(async () => {
  await page?.close();
  client?.close();
  await core?.stop();
}, 30_000);

test('a running turn pauses after its tool call while its agent updates, then goes on in the same turn', async () => {
  expect((await client.call('providers.updates', { refresh: true }))[0]?.latest).toBe('1.2.0');
  const turn = await client.call('turns.start', { threadId, prompt: 'Build the release. [tool:1500][sleep:30000]' });
  await until(async () => (await client.call('threads.get', { threadId })).messages.some((message) => message.parts.some((part) => part.type === 'tool' && part.status === 'running')));
  expect((await client.call('providers.update', { providerId: 'update-fake' })).waitingFor).toBe(1);
  await until(async () => existsSync(`${state}.running`));

  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await desktop();
  await page.click(`[data-thread-id="${threadId}"]`);
  await page.waitFor(`document.body.innerText.includes('Paused while Fake Agent updates')`);
  await capture('agent-update-paused-desktop.png');
  await phone();
  await page.waitFor(`document.body.innerText.includes('Paused while Fake Agent updates')`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await capture('agent-update-paused-phone.png');

  writeFileSync(`${state}.go`, '');
  await until(async () => (await client.call('threads.get', { threadId })).turns.find((entry) => entry.id === turn.id)?.status === 'done');
  await page.waitFor(`document.body.innerText.includes('Resumed after the Fake Agent 1.2.0 update')`);
  await capture('agent-update-resumed-phone.png');
  await desktop();
  await capture('agent-update-resumed-desktop.png');
  const thread = await client.call('threads.get', { threadId });
  expect(thread.turns.map((entry) => entry.id)).toEqual([turn.id]);
}, 60_000);
