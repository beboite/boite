import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import corePackage from '../../packages/core/package.json';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, removeDirectory, startCore, type RunningCore } from './lib/core.ts';

const TIMEOUT = 60_000;
const ROOT = join(import.meta.dir, '..', '..');
const UI_INDEX = join(ROOT, 'packages', 'ui', 'dist', 'index.html');
const SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui.png');
const RELOAD_SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui-permission-reload.png');

let core: RunningCore;
let page: BrowserPage;
let projectDir: string;

function testid(id: string): string {
  return `[data-testid=${id}]`;
}

function textOf(id: string): string {
  return `document.querySelector('${testid(id)}')?.textContent.replace(/\\s+/g, ' ').trim()`;
}

async function clickWhenEnabled(selector: string): Promise<void> {
  await page.waitFor(`document.querySelector('${selector}') && !document.querySelector('${selector}').disabled`);
  await page.click(selector);
}

beforeAll(async () => {
  if (!existsSync(UI_INDEX)) {
    const built = Bun.spawnSync({
      cmd: ['bun', 'run', '--cwd', 'packages/ui', 'build'],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (!built.success) throw new Error(`the ui did not build:\n${built.stderr.toString()}`);
  }
  core = await startCore();
  projectDir = mkdtempSync(join(tmpdir(), 'boite-e2e-ui-'));
  page = await BrowserPage.launch({ url: pairingUrlOf(core) });
});

afterAll(async () => {
  await page?.close();
  await core?.stop();
  if (projectDir !== undefined) await removeDirectory(projectDir);
});

test(
  'a fresh core opens on the first-run card, connected to the core it was paired with',
  async () => {
    await page.waitFor(`${textOf('status-connection')} === 'Connected'`, 30_000);
    await page.waitFor(`document.querySelector('${testid('first-run')}')`);
    await page.waitFor(`document.querySelector('${testid('sidebar')}')`);
  },
  TIMEOUT,
);

test(
  'opening a folder makes a project and a draft thread, and the first send creates the thread',
  async () => {
    await page.type(testid('project-path'), projectDir);
    await clickWhenEnabled(testid('project-add'));
    await page.waitFor(`${textOf('project-row')}.includes(${JSON.stringify(basename(projectDir))})`);
    await page.waitFor(`document.querySelector('${testid('draft-row')}')`);
    expect(await page.evaluate<number>(`document.querySelectorAll('${testid('thread-row')}').length`)).toBe(0);

    // The picker: the echo account on the left, then its one model on the right, which closes it.
    await page.click(testid('composer-picker'));
    await page.waitFor(`document.querySelector('${testid('composer-picker-menu')}')`);
    await page.click(`${testid('composer-picker-menu')} [data-instance^="echo::"]`);
    await page.waitFor(`${textOf('composer-picker')}.startsWith('Echo')`);
    await page.click(`${testid('composer-picker-menu')} [data-model="echo"]`);
    await page.waitFor(`!document.querySelector('${testid('composer-picker-menu')}')`);

    await page.type(testid('composer-input'), 'browser thread [permission]');
    await clickWhenEnabled(testid('composer-send'));

    await page.waitFor(`${textOf('thread-title')} === 'browser thread [permission]'`, 30_000);
    await page.waitFor(`document.querySelectorAll('${testid('thread-row')}').length === 1`);
    expect(await page.evaluate<boolean>(`!!document.querySelector('${testid('draft-row')}')`)).toBe(false);
  },
  TIMEOUT,
);

test(
  'the turn streams, the permission is allowed inline, and the thread goes back to idle',
  async () => {
    await page.waitFor(`document.querySelector('${testid('permission-card')}')`, 30_000);
    expect(await page.text(testid('permission-input'))).toContain('echo');

    await page.click(testid('permission-allow'));
    await page.waitFor(
      `document.querySelector('${testid('permission-card')}').dataset.decision === 'allow'`,
      30_000,
    );
    await page.waitFor(`document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`, 30_000);

    const assistant = await page.evaluate<string>(
      `Array.from(document.querySelectorAll('${testid('message')}[data-role=assistant] ${testid('text-part')}')).map((node) => node.textContent).join(' ')`,
    );
    expect(assistant).toContain('browser thread');
    expect(assistant).toContain('allowed');

    await page.screenshot(SCREENSHOT);
    expect(existsSync(SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'the trace panel lists what the turn launched, or says it launched nothing',
  async () => {
    await page.click(testid('tab-trace'));
    await page.waitFor(`document.querySelector('${testid('trace-panel')}')`);
    await page.waitFor(
      `document.querySelector('${testid('trace-row')}') || document.querySelector('${testid('trace-empty')}')`,
    );
    await page.click(testid('tab-trace'));
    await page.waitFor(`!document.querySelector('${testid('trace-panel')}')`);
  },
  TIMEOUT,
);

test(
  'settings show the core the UI is connected to',
  async () => {
    await page.click(testid('nav-settings'));
    await page.waitFor(`document.querySelector('${testid('settings-page')}')`);
    const url = await page.evaluate<string>(`document.querySelector('${testid('settings-core-url')}').value`);
    expect(url).toBe(core.url);
    expect(await page.evaluate<string>(textOf('settings-endpoint'))).toBe(`127.0.0.1:${core.port}`);
    expect(await page.evaluate<string>(textOf('settings-version'))).toBe(corePackage.version);

    await page.click(testid('settings-back'));
    await page.waitFor(`document.querySelector('${testid('chat')}')`);
    expect(await page.evaluate<string>(textOf('thread-title'))).toBe('browser thread [permission]');
  },
  TIMEOUT,
);

test(
  'a permission asked before the page existed is still answerable after a fresh load',
  async () => {
    const client = await connect(core.url, core.token);
    try {
      const project = await client.call('projects.add', { path: projectDir });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'echo');
      if (account === undefined) throw new Error('no echo account');
      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'echo',
        accountId: account.id,
        title: 'reloaded permission',
      });

      // Only a subscribed socket is told; that is the whole reason for the method.
      await client.call('threads.subscribe', { threadId: thread.id });
      const requested = client.next<'permission.requested'>(
        'permission.requested',
        (request) => request.threadId === thread.id,
        TIMEOUT,
      );
      const finished = client.next<'turn.finished'>(
        'turn.finished',
        (turn) => turn.threadId === thread.id,
        TIMEOUT,
      );
      await client.call('turns.start', { threadId: thread.id, prompt: 'reloaded [permission]' });
      await requested;

      // The page is thrown away and loaded again only now: `permission.requested`
      // fired before this document existed, so the card can only come from
      // `permissions.list`.
      await page.navigate(pairingUrlOf(core));
      await page.waitFor(`${textOf('thread-title')} === 'reloaded permission'`, 30_000);
      await page.waitFor(`document.querySelector('${testid('permission-card')}')`, 30_000);
      await page.waitFor(`document.querySelector('${testid('permission-input')}')`, 30_000);
      expect(await page.text(testid('permission-input'))).toContain('echo');
      await page.screenshot(RELOAD_SCREENSHOT);

      await page.click(testid('permission-allow'));
      expect((await finished).status).toBe('done');
      await page.waitFor(
        `document.querySelector('${testid('permission-card')}').dataset.decision === 'allow'`,
        30_000,
      );
    } finally {
      client.close();
    }
  },
  TIMEOUT,
);
