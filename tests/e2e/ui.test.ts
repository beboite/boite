import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import corePackage from '../../packages/core/package.json';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, removeDirectory, startCore, type RunningCore } from './lib/core.ts';

const TIMEOUT = 60_000;
const ROOT = join(import.meta.dir, '..', '..');
const UI_INDEX = join(ROOT, 'packages', 'ui', 'dist', 'index.html');
const SCREENSHOT = join(import.meta.dir, '.artifacts', 'ui.png');

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
  'the threads page opens connected to the core it was paired with',
  async () => {
    await page.waitFor(`${textOf('status-connection')} === 'Connected'`, 30_000);
    const version = await page.evaluate<string>(textOf('status-core'));
    expect(version).toBe(`Boite ${corePackage.version}`);
    await page.waitFor(`document.querySelector('${testid('sidebar')}')`);
  },
  TIMEOUT,
);

test(
  'a project and an echo thread are created through the UI',
  async () => {
    await page.click(testid('add-project'));
    await page.type(testid('project-path'), projectDir);
    await clickWhenEnabled(testid('project-add'));
    await page.waitFor(`${textOf('project-row')}.includes(${JSON.stringify(basename(projectDir))})`);

    await page.click(testid('new-thread'));
    await page.choose(testid('new-thread-provider'), 'echo');
    await page.waitFor(`document.querySelectorAll('${testid('new-thread-account')} option').length > 0`);
    await page.type(testid('new-thread-title'), 'browser thread');
    await clickWhenEnabled(testid('new-thread-create'));

    await page.waitFor(`${textOf('thread-title')} === 'browser thread'`);
    await page.waitFor(`document.querySelectorAll('${testid('thread-row')}').length === 1`);
  },
  TIMEOUT,
);

test(
  'a turn streams, the permission is allowed, and the thread goes back to idle',
  async () => {
    await page.type(testid('composer-input'), 'browser turn [permission]');
    await clickWhenEnabled(testid('composer-send'));

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
    expect(assistant).toContain('browser turn');
    expect(assistant).toContain('allowed');

    await page.screenshot(SCREENSHOT);
    expect(existsSync(SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

test(
  'the settings page shows the core it is connected to',
  async () => {
    await page.click(testid('nav-settings'));
    await page.waitFor(`document.querySelector('${testid('settings-page')}')`);
    const url = await page.evaluate<string>(`document.querySelector('${testid('settings-core-url')}').value`);
    expect(url).toBe(core.url);
    expect(await page.evaluate<string>(textOf('settings-endpoint'))).toBe(`127.0.0.1:${core.port}`);
    expect(await page.evaluate<string>(textOf('settings-version'))).toBe(corePackage.version);
  },
  TIMEOUT,
);
