/**
 * The whole road of the `boite` CLI, nothing faked: a core from the sources, the
 * built UI in a hidden Chromium, and `boite-core cli` run as a process that
 * drives the thread from outside it (`--thread`, the owner token in `core.json`).
 * What it proves is the part no unit test can: the surface the CLI asked for is
 * the one the panel draws.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, removeDirectory, startCore, type RunningCore } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const TIMEOUT = 60_000;
const ROOT = join(import.meta.dir, '..', '..');
const MAIN = join(ROOT, 'packages', 'core', 'src', 'main.ts');
const ARTIFACTS = join(import.meta.dir, '.artifacts');

let core: RunningCore;
let page: BrowserPage;
let projectDir: string;
let threadId = '';

function testid(id: string): string {
  return `[data-testid=${id}]`;
}

function git(args: string[]): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'boite e2e',
    GIT_AUTHOR_EMAIL: 'e2e@boite.invalid',
    GIT_COMMITTER_NAME: 'boite e2e',
    GIT_COMMITTER_EMAIL: 'e2e@boite.invalid',
  };
  const run = Bun.spawnSync({ cmd: ['git', ...args], cwd: projectDir, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
}

/** `boite <args>` as the owner of the thread, the way a person at a terminal runs it. */
function boite(...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync({
    cmd: ['bun', 'run', MAIN, 'cli', ...args, '--thread', threadId, '--data-dir', core.dataDir],
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

async function capture(name: string): Promise<void> {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(ARTIFACTS, name));
}

beforeAll(async () => {
  ensureProductionUi();
  projectDir = mkdtempSync(join(tmpdir(), 'boite-e2e-cli-'));
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src', 'app.ts'), Array.from({ length: 40 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  writeFileSync(join(projectDir, 'README.md'), '# cli e2e\n');
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  // A change for the changes surface to list.
  writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const changed = true;\n');
  core = await startCore();
  page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1310, height: 820 } });
  await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`, 30_000);

  // A project and one echo thread, made the way the user makes them.
  await page.click(testid('add-project'));
  await page.waitFor(`document.querySelector('[data-testid=project-path]') && !document.querySelector('[data-testid=project-add]').disabled`);
  await page.type(testid('project-path'), projectDir);
  await page.waitFor(`!document.querySelector('${testid('project-add')}').disabled`);
  await page.click(testid('project-add'));
  await page.waitFor(`document.querySelector('${testid('project-row')}')?.textContent.includes(${JSON.stringify(basename(projectDir))})`);
  await page.click(testid('composer-picker'));
  await page.waitFor(`document.querySelector('${testid('composer-picker-menu')}')`);
  await page.click(`${testid('composer-picker-menu')} [data-provider="echo"]`);
  await page.click(`${testid('composer-picker-menu')} [data-model="echo"]`);
  await page.waitFor(`!document.querySelector('${testid('composer-picker-menu')}')`);
  await page.type(testid('composer-input'), 'cli thread');
  await page.waitFor(`!document.querySelector('${testid('composer-send')}').disabled`);
  await page.click(testid('composer-send'));
  await page.waitFor(`document.querySelectorAll('${testid('thread-row')}').length === 1`, 30_000);

  const client = await connect(core.url, core.token);
  try {
    const threads = await client.call('threads.list', {});
    threadId = threads[0]?.id ?? '';
  } finally {
    client.close();
  }
  if (threadId === '') throw new Error('the thread was not created');
}, 120_000);

afterAll(async () => {
  await page?.close();
  await core?.stop();
  if (projectDir !== undefined) await removeDirectory(projectDir);
}, 15_000);

test(
  'boite where names the thread the UI shows',
  () => {
    const run = boite('where');
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toContain(`thread: ${threadId}`);
    expect(run.out).toContain('agent: echo');
  },
  TIMEOUT,
);

test(
  'boite show opens the file at the line in the panel of the open thread',
  async () => {
    const run = boite('show', 'src/app.ts:1');
    expect(run.err).toBe('');
    expect(run.out).toBe('shown: yes\n');
    await page.waitFor(`document.querySelector('${testid('file-panel')}')`);
    await page.waitFor(`document.querySelector('${testid('panel-tab')}[data-kind=file]')?.textContent.includes('app.ts')`);
    await capture('cli-show.png');
  },
  TIMEOUT,
);

test(
  'boite open changes lists the modified file from the real repository',
  async () => {
    const status = boite('status');
    expect(status.code).toBe(0);
    expect(status.out).toContain('M  src/app.ts');
    const run = boite('open', 'changes');
    expect(run.out).toBe('shown: yes\n');
    await page.waitFor(`document.querySelector('${testid('changes-panel')}')?.textContent.includes('app.ts')`);
    await capture('cli-changes.png');
  },
  TIMEOUT,
);

test(
  'boite task and todo reach the tasks surface',
  async () => {
    expect(boite('task', 'add', 'prove the road').out).toBe('t1 [ ] prove the road\n');
    expect(boite('task', 'start', '1').out).toBe('t1 [>] prove the road\n');
    const todo = boite('todo', 'add', 'confirm the capture');
    expect(todo.code).toBe(0);
    const run = boite('open', 'tasks');
    expect(run.out).toBe('shown: yes\n');
    await page.waitFor(`document.querySelector('${testid('tasks-panel')}')?.textContent.includes('prove the road')`);
    await page.waitFor(`document.querySelector('${testid('tasks-panel')}')?.textContent.includes('confirm the capture')`);
    await capture('cli-tasks.png');
  },
  TIMEOUT,
);

test(
  'boite show draws a real picture and plays a real video over the ticketed route',
  async () => {
    // Both files are made by the browser that will show them, so they are
    // files it can decode: a canvas as a PNG, the same canvas recorded as WebM.
    const made = await page.evaluate<{ png: string; webm: string }>(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const paint = canvas.getContext('2d');
      const draw = (at) => { paint.fillStyle = '#1e293b'; paint.fillRect(0, 0, 320, 200); paint.fillStyle = '#34d399'; paint.fillRect(20 + at * 8, 60, 80, 80); };
      draw(0);
      const png = canvas.toDataURL('image/png').split(',')[1];
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
      const parts = [];
      recorder.ondataavailable = (event) => parts.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      for (let at = 1; at <= 20; at++) { draw(at); await new Promise((resolve) => setTimeout(resolve, 40)); }
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { png, webm: btoa(binary) };
    })()`);
    mkdirSync(join(projectDir, 'media'));
    writeFileSync(join(projectDir, 'media', 'shot.png'), Buffer.from(made.png, 'base64'));
    writeFileSync(join(projectDir, 'media', 'clip.webm'), Buffer.from(made.webm, 'base64'));

    expect(boite('show', 'media/shot.png').out).toBe('shown: yes\n');
    await page.waitFor(`document.querySelector('${testid('file-image')}')?.naturalWidth === 320`);
    expect(await page.text(testid('file-natural'))).toContain('320 x 200');
    // The address is the core's own route, resolved by the UI from a path.
    expect(await page.evaluate(`document.querySelector('${testid('file-image')}').src.startsWith(${JSON.stringify(`${core.url}/file/`)})`)).toBe(true);
    await capture('cli-image.png');

    expect(boite('show', 'media/clip.webm').out).toBe('shown: yes\n');
    await page.waitFor(`document.querySelector('${testid('file-video')}')?.videoWidth === 320`);
    // Playing it is what proves the bytes decode, not only the header.
    await page.evaluate(`(() => { const video = document.querySelector('${testid('file-video')}'); video.muted = true; return video.play(); })()`);
    await page.waitFor(`document.querySelector('${testid('file-video')}').currentTime > 0`);
    await page.evaluate(`document.querySelector('${testid('file-video')}').pause()`);
    await capture('cli-video.png');
  },
  TIMEOUT,
);

test(
  'a path outside the working directory and a bad url are refused by name',
  () => {
    const outside = boite('show', join(tmpdir(), 'nope.txt'));
    expect(outside.code).toBe(1);
    expect(outside.err.startsWith('error: ')).toBe(true);
    const url = boite('browse', 'javascript:alert(1)');
    expect(url.code).toBe(1);
    expect(url.err).toContain('http');
  },
  TIMEOUT,
);
