import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { freshDataDir, killProcessTree, removeDirectory } from './lib/core.ts';

const TIMEOUT = 120_000;
const READY_TIMEOUT_MS = 30_000;
const CORE_GONE_TIMEOUT_MS = 5_000;
const HARD_KILL_TIMEOUT_MS = 3_000;
const POLL_MS = 100;

const ROOT = join(import.meta.dir, '..', '..');
const EXE = join(ROOT, 'apps', 'shell', 'src-tauri', 'target', 'release', 'boite-shell.exe');
const SCREENSHOT = join(import.meta.dir, '.artifacts', 'shell.png');

const exeMissing = !existsSync(EXE);
if (exeMissing) {
  console.log(
    `[shell.test] skipped: ${EXE} does not exist. Build it with \`bun run --cwd apps/shell tauri build --no-bundle\`.`,
  );
}
const shellTest = exeMissing ? test.skip : test;

interface CoreFile {
  port: number;
  host: string;
  token: string;
  pid: number;
}

let shellPid = 0;
let dataDir = '';
let projectDir = '';
let page: BrowserPage | undefined;
let coreFile: CoreFile | undefined;
let startToHealthMs = 0;

function testid(id: string): string {
  return `[data-testid=${id}]`;
}

function textOf(id: string): string {
  return `document.querySelector('${testid(id)}')?.textContent.replace(/\\s+/g, ' ').trim()`;
}

const ASSISTANT_TEXT = `Array.from(document.querySelectorAll('${testid('message')}[data-role=assistant] ${testid('text-part')}')).map((node) => node.textContent).join(' ')`;

async function clickWhenEnabled(selector: string): Promise<void> {
  await page?.waitFor(`document.querySelector('${selector}') && !document.querySelector('${selector}').disabled`);
  await page?.click(selector);
}

function readCoreFile(path: string): CoreFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CoreFile>;
    if (typeof parsed.port !== 'number' || typeof parsed.pid !== 'number') return undefined;
    return parsed as CoreFile;
  } catch {
    return undefined;
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A shell killed without its tree leaves its WebView2 browser processes behind
// for a moment. They are this run's own, recognised by the profile they carry
// under the temporary data directory, and nothing else is touched.
function killWebviewsOf(dataDir: string): void {
  Bun.spawnSync({
    cmd: [
      'powershell',
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${dataDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

function parentOf(pid: number): number | null {
  const query = Bun.spawnSync({
    cmd: [
      'powershell',
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
    ],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const parsed = Number(query.stdout.toString().trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

beforeAll(async () => {
  if (exeMissing) return;
  dataDir = freshDataDir();
  projectDir = mkdtempSync(join(tmpdir(), 'boite-e2e-shell-project-'));
  const debugPort = await freePort();

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.BOITE_CORE_COMMAND;
  env.BOITE_SHELL_HIDDEN = '1';
  // The shell puts its WebView2 profile under the data directory, so this run
  // never shares a browser process with the installed app the user may have open.
  env.BOITE_DATA_DIR = dataDir;
  env.BOITE_ECHO = '1';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${debugPort} --remote-allow-origins=*`;

  const startedAt = performance.now();
  const proc = Bun.spawn({
    cmd: [EXE],
    env,
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });
  shellPid = proc.pid;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  const corePath = join(dataDir, 'core.json');
  for (;;) {
    const file = readCoreFile(corePath);
    if (file !== undefined && (await healthy(file.port))) {
      startToHealthMs = performance.now() - startedAt;
      coreFile = file;
      break;
    }
    if (Date.now() > deadline) {
      killProcessTree(shellPid);
      throw new Error(`the shell did not write ${corePath} and answer /health within ${READY_TIMEOUT_MS / 1000} s`);
    }
    await Bun.sleep(POLL_MS);
  }
  console.log(`[shell.test] spawn to /health: ${startToHealthMs.toFixed(0)} ms`);

  page = await BrowserPage.attach(debugPort);
}, TIMEOUT);

afterAll(async () => {
  await page?.close();
  if (shellPid > 0) killProcessTree(shellPid);
  if (coreFile !== undefined) killProcessTree(coreFile.pid);
  if (dataDir !== '') await removeDirectory(dataDir);
  if (projectDir !== '') await removeDirectory(projectDir);
});

shellTest(
  'the hidden shell starts a core of its own and reaches it',
  () => {
    expect(coreFile?.port).toBeGreaterThan(0);
    expect(coreFile?.pid).toBeGreaterThan(0);
    expect(startToHealthMs).toBeGreaterThan(0);
    expect(startToHealthMs).toBeLessThan(READY_TIMEOUT_MS);
  },
  TIMEOUT,
);

shellTest(
  'the embedded UI connects to that core',
  async () => {
    await page?.waitFor(`${textOf('status-connection')} === 'Connected'`, 30_000);
    await page?.waitFor(`document.querySelector('${testid('sidebar')}')`);
  },
  TIMEOUT,
);

shellTest(
  'a project, an echo thread and a turn go through the shell',
  async () => {
    // The first-run card offers the native picker in the shell; the path field sits behind one click.
    await page?.waitFor(`document.querySelector('${testid('first-run')}')`);
    await page?.click(testid('add-project'));
    await page?.type(testid('project-path'), projectDir);
    await clickWhenEnabled(testid('project-add'));
    await page?.waitFor(`${textOf('project-row')}.includes(${JSON.stringify(basename(projectDir))})`);
    await page?.waitFor(`document.querySelector('${testid('draft-row')}')`);

    await page?.click(testid('composer-picker'));
    await page?.waitFor(`document.querySelector('${testid('composer-picker-menu')}')`);
    await page?.click(`${testid('composer-picker-menu')} [data-instance^="echo::"]`);
    await page?.waitFor(`${textOf('composer-picker')}.startsWith('Echo')`);
    await page?.click(`${testid('composer-picker-menu')} [data-model="echo"]`);
    await page?.waitFor(`!document.querySelector('${testid('composer-picker-menu')}')`);

    await page?.type(testid('composer-input'), 'shell turn');
    await clickWhenEnabled(testid('composer-send'));
    await page?.waitFor(`${textOf('thread-title')} === 'shell turn'`, 30_000);
    await page?.waitFor(`${ASSISTANT_TEXT}.includes('shell turn')`, 30_000);
    await page?.waitFor(
      `document.querySelector('${testid('thread-status')}').dataset.status === 'idle'`,
      30_000,
    );

    const assistant = await page?.evaluate<string>(ASSISTANT_TEXT);
    expect(assistant).toContain('shell turn');

    await page?.screenshot(SCREENSHOT);
    expect(existsSync(SCREENSHOT)).toBe(true);
  },
  TIMEOUT,
);

shellTest(
  'killing the shell tree takes the core it started with it',
  async () => {
    const corePid = coreFile?.pid ?? 0;
    expect(corePid).toBeGreaterThan(0);
    expect(pidAlive(corePid)).toBe(true);
    console.log(`[shell.test] core pid ${corePid} parent ${parentOf(corePid)}, shell pid ${shellPid}`);

    await page?.close();
    page = undefined;
    killProcessTree(shellPid);

    const deadline = Date.now() + CORE_GONE_TIMEOUT_MS;
    while (pidAlive(corePid)) {
      if (Date.now() > deadline) break;
      await Bun.sleep(POLL_MS);
    }
    expect(pidAlive(corePid)).toBe(false);
    expect(pidAlive(shellPid)).toBe(false);
  },
  TIMEOUT,
);

shellTest(
  'a hard-killed shell takes its core down',
  async () => {
    // Its own shell, its own data directory: the shell above is already gone.
    const ownDataDir = freshDataDir();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.BOITE_CORE_COMMAND;
    env.BOITE_SHELL_HIDDEN = '1';
    env.BOITE_DATA_DIR = ownDataDir;
    env.BOITE_ECHO = '1';

    const proc = Bun.spawn({
      cmd: [EXE],
      env,
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    });
    let corePid = 0;

    try {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      const corePath = join(ownDataDir, 'core.json');
      for (;;) {
        const file = readCoreFile(corePath);
        if (file !== undefined && (await healthy(file.port))) {
          corePid = file.pid;
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`the shell did not write ${corePath} and answer /health within ${READY_TIMEOUT_MS / 1000} s`);
        }
        await Bun.sleep(POLL_MS);
      }
      expect(corePid).toBeGreaterThan(0);
      expect(pidAlive(corePid)).toBe(true);

      // The shell alone, no `/T`: nothing walks the tree here, so only the Job
      // Object the shell owns can take the core down.
      Bun.spawnSync(['taskkill', '/pid', String(proc.pid), '/F'], { stdout: 'ignore', stderr: 'ignore' });

      const gone = Date.now() + HARD_KILL_TIMEOUT_MS;
      while (pidAlive(corePid)) {
        if (Date.now() > gone) break;
        await Bun.sleep(POLL_MS);
      }
      expect(pidAlive(proc.pid)).toBe(false);
      expect(pidAlive(corePid)).toBe(false);
    } finally {
      killProcessTree(proc.pid);
      if (corePid > 0) killProcessTree(corePid);
      killWebviewsOf(ownDataDir);
      await removeDirectory(ownDataDir);
    }
  },
  TIMEOUT,
);
