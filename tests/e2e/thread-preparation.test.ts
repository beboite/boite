import { mobileAction } from './lib/mobile.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { freshDataDir, pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

let core: RunningCore;
let client: CoreClient;
let page: BrowserPage;
let threadId: string;
let logFile: string;

function sessionsOpened(): number {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(line => line.startsWith('thread/start ')).length : 0;
}

async function prepared(count: number): Promise<void> {
  const until = Date.now() + 10_000;
  while (sessionsOpened() < count && Date.now() < until) await Bun.sleep(20);
  expect(sessionsOpened()).toBe(count);
}

beforeAll(async () => {
  const dataDir = freshDataDir();
  logFile = join(dataDir, 'prepared-agent.log');
  core = await startCore({ dataDir, env: { CODEX_FAKE_LOG: logFile } });
  client = await connect(core.url, core.token);
  const profile = {
    detect: {}, executable: [{ kind: 'path', value: 'bun' }], isolation: {},
    launch: { args: [resolve('packages/core/test/fixtures/codex-server.ts')] },
  };
  mkdirSync(join(dataDir, 'providers'), { recursive: true });
  writeFileSync(join(dataDir, 'providers', 'prepared-codex.json'), JSON.stringify({
    id: 'prepared-codex', schemaVersion: 1, name: 'Prepared agent', shortName: 'Prepared', protocol: 'codex-appserver',
    roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' }, models: [{ id: 'fake-codex', name: 'Scripted model', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
  }));
  await client.call('providers.reload', {});
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'prepared-codex')!;
  const project = await client.call('projects.add', { path: dataDir, name: 'Preparation' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: account.providerId, accountId: account.id, title: 'Ready before typing' });
  threadId = thread.id;
  await client.call('threads.update', { threadId, title: thread.title });
  await client.call('threads.subscribe', { threadId });
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
  await page.click(`[data-thread-id="${threadId}"]`);
  await page.waitFor(`document.querySelector('[data-testid="composer-input"]')`);
}, 30_000);

afterAll(async () => { await page?.close(); client?.close(); await core?.stop(); }, 15_000);

test('opening the production conversation prepares the agent before the first prompt', async () => {
  await prepared(1);
  const before = await client.call('threads.get', { threadId });
  expect(before.turns).toHaveLength(0);
  expect(before.messages).toHaveLength(0);
  expect(readFileSync(logFile, 'utf8')).not.toContain('turn/start');
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  await page.type('[data-testid="composer-input"]', 'Ready now');
  await page.click('[data-testid="composer-send"]');
  expect((await finished).status).toBe('done');
  expect(sessionsOpened()).toBe(1);
  await page.waitFor(`document.querySelector('[data-testid="text-part"]')?.textContent.includes('Ready now')`);
});

test('a phone navigation round trip reuses the prepared session without sending work', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`document.querySelector('[data-testid="mobile-list"]')`);
  await page.click(`[data-testid="mobile-thread-${threadId}"]`);
  await page.waitFor(`!document.querySelector('.body.mobile-covered')`);
  expect(sessionsOpened()).toBe(1);
  expect((await client.call('threads.get', { threadId })).turns).toHaveLength(1);
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  await page.type('[data-testid="composer-input"]', 'Phone reuse');
  await page.click('[data-testid="composer-send"]');
  expect((await finished).status).toBe('done');
  expect(sessionsOpened()).toBe(1);
});
