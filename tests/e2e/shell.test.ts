import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

const CORE_SUFFIX = process.platform === 'win32' ? '.exe' : '';
const SOURCE_ROOTS = [
  join(ROOT, 'packages', 'core', 'src'),
  join(ROOT, 'packages', 'contracts', 'src'),
];
const SOURCE_EXTENSIONS = ['.ts', '.json'];

const exeMissing = !existsSync(EXE);
if (exeMissing) {
  console.log(
    `[shell.test] skipped: ${EXE} does not exist. Build it with \`bun run --cwd apps/shell tauri build --no-bundle\`.`,
  );
}

interface SourceFile {
  path: string;
  mtimeMs: number;
}

/** The most recently touched `.ts` or `.json` the compiled core is built from. */
function newestCoreSource(): SourceFile | null {
  let newest: SourceFile | null = null;
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      const mtimeMs = statSync(full).mtimeMs;
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return newest;
}

/**
 * The shell runs whatever core `resolve_core` finds, in this order:
 * `BOITE_CORE_COMMAND`, the `boite-core` sidecar beside its exe,
 * `packages/core/dist/main.js`, then the sources. The two middle ones are built
 * artefacts, and a stale one answers this suite's UI with an old contract: the
 * turn tests then time out on the picker with nothing saying why (2026-09-08).
 * The sources cannot go stale, and a `BOITE_CORE_COMMAND` points wherever its
 * author meant, so neither is checked.
 */
function staleCoreReason(): string | null {
  if ((process.env.BOITE_CORE_COMMAND ?? '') !== '') return null;
  const sidecar = join(dirname(EXE), `boite-core${CORE_SUFFIX}`);
  const built = existsSync(sidecar) ? sidecar : join(ROOT, 'packages', 'core', 'dist', 'main.js');
  if (!existsSync(built)) return null;
  const builtAtMs = statSync(built).mtimeMs;
  const newest = newestCoreSource();
  if (newest === null || builtAtMs >= newest.mtimeMs) return null;
  return [
    `the core the shell would start is older than the sources it is built from:`,
    `  core:   ${built}`,
    `          modified ${new Date(builtAtMs).toISOString()}`,
    `  newest: ${newest.path}`,
    `          modified ${new Date(newest.mtimeMs).toISOString()}`,
    `Refresh it before trusting this file: bun run stage:core`,
  ].join('\n');
}

const staleReason = exeMissing ? null : staleCoreReason();
const shellTest = exeMissing || staleReason !== null ? test.skip : test;

// One failure, right away, instead of two turn tests timing out in two minutes.
if (staleReason !== null) {
  const reason = staleReason;
  test('the core the shell would start is not older than the core sources', () => {
    throw new Error(reason);
  });
}

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

const LINK = `${testid('message')}[data-role=assistant] ${testid('text-part')} a[href="https://example.invalid/docs"]`;

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
  if (exeMissing || staleReason !== null) return;
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
  'a markdown link in an answer is handed to the system browser, not the webview',
  async () => {
    // The real opener would put a browser window on the user's screen. The IPC
    // is wrapped instead: `open_url` is recorded and answered as the custom
    // protocol would, everything else still goes to the shell. `invoke`, `ipc`
    // and `postMessage` on `__TAURI_INTERNALS__` are all defined non-writable
    // and non-configurable, so the seam is the `fetch` that `sendIpcMessage`
    // calls; a reply with `Tauri-Response: ok` and a JSON body resolves the
    // promise `openUrl` is waiting on.
    await page?.evaluate<null>(`(() => {
      const real = window.fetch.bind(window);
      const PREFIXES = ['http://ipc.localhost/', 'https://ipc.localhost/', 'ipc://localhost/'];
      window.__boiteInvokes = [];
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : String(input && input.url);
        const prefix = PREFIXES.find((candidate) => url.startsWith(candidate));
        if (prefix) {
          const cmd = decodeURIComponent(url.slice(prefix.length));
          let args = null;
          try { args = JSON.parse(String(init && init.body)); } catch (e) { args = null; }
          window.__boiteInvokes.push([cmd, args]);
          if (cmd === 'plugin:opener|open_url') {
            return Promise.resolve(new Response('null', {
              status: 200,
              headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' }
            }));
          }
        }
        return real(input, init);
      };
      return null;
    })()`);

    // The echo driver streams the prompt back, so the answer carries the link.
    await page?.type(testid('composer-input'), 'read [docs](https://example.invalid/docs) now');
    await clickWhenEnabled(testid('composer-send'));
    await page?.waitFor(`document.querySelector('${LINK}')`, 30_000);

    await page?.evaluate<null>(`(() => { document.querySelector('${LINK}').click(); return null; })()`);
    await page?.waitFor(
      `window.__boiteInvokes.some(([cmd]) => cmd === 'plugin:opener|open_url')`,
      10_000,
    );

    const call = await page?.evaluate<[string, { url?: string }] | undefined>(
      `window.__boiteInvokes.find(([cmd]) => cmd === 'plugin:opener|open_url')`,
    );
    expect(call?.[0]).toBe('plugin:opener|open_url');
    expect(call?.[1]?.url).toBe('https://example.invalid/docs');
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
