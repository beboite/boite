import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { freshDataDir, killProcessTree, removeDirectory, startCore } from './lib/core.ts';

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
/** What the shell exe carries: `frontendDist` is compiled into the binary. */
const UI_ROOTS = [join(ROOT, 'packages', 'ui', 'src'), join(ROOT, 'packages', 'ui', 'public'), join(ROOT, 'apps', 'shell', 'src-tauri', 'src')];
const UI_EXTENSIONS = ['.ts', '.svelte', '.css', '.html', '.json', '.js', '.rs', '.svg', '.png', '.webmanifest'];

const exeMissing = !existsSync(EXE);
const skipShell = process.env.BOITE_E2E_SKIP_SHELL === '1';

interface SourceFile {
  path: string;
  mtimeMs: number;
}

/** The most recently touched source file a built artefact is supposed to carry. */
function newestSource(roots: string[], extensions: string[]): SourceFile | null {
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
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const mtimeMs = statSync(full).mtimeMs;
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
    }
  };
  for (const root of roots) walk(root);
  return newest;
}

/** The same report for either artefact: what is old, what moved after it, how to refresh it. */
function staleReport(label: string, built: string, builtAtMs: number, newest: SourceFile, fix: string): string {
  return [
    `the ${label} the shell would run is older than the sources it is built from:`,
    `  built:  ${built}`,
    `          modified ${new Date(builtAtMs).toISOString()}`,
    `  newest: ${newest.path}`,
    `          modified ${new Date(newest.mtimeMs).toISOString()}`,
    `Refresh it before trusting this file: ${fix}`,
  ].join('\n');
}

/**
 * The shell runs whatever core `resolve_core` finds, in this order:
 * `BOITE_CORE_COMMAND`, the `boite-core` sidecar beside its exe,
 * `packages/core/dist/main.js`, then the sources. The two middle ones are built
 * artefacts, and a stale one answers this suite's UI with an old contract: the
 * turn tests then time out on the picker with nothing saying why (2026-09-08).
 * The sources cannot go stale, so they are not checked; `BOITE_CORE_COMMAND`
 * is stripped from the shell's environment below, so it never counts here.
 */
function staleCoreReason(): string | null {
  const sidecar = join(dirname(EXE), `boite-core${CORE_SUFFIX}`);
  const built = existsSync(sidecar) ? sidecar : join(ROOT, 'packages', 'core', 'dist', 'main.js');
  if (!existsSync(built)) return null;
  const newest = newestSource(SOURCE_ROOTS, SOURCE_EXTENSIONS);
  for (const artifact of [built, join(dirname(built), 'jobs-worker.js'), join(dirname(built), 'guard-worker.js')]) {
    if (!existsSync(artifact)) return `missing core artifact: ${artifact}. Run bun run stage:core`;
    const builtAtMs = statSync(artifact).mtimeMs;
    if (newest !== null && builtAtMs < newest.mtimeMs) {
      return staleReport('core', artifact, builtAtMs, newest, 'bun run stage:core');
    }
  }
  return null;
}

/**
 * The other half of the same trap. The shell window opens on
 * `WebviewUrl::default()`, so the UI it shows is the `frontendDist` compiled
 * into the exe, not the one the core serves: a `bun run build:ui` after the
 * last `tauri build` changes nothing on this window. A shell carrying yesterday's
 * UI against today's core fails exactly like a stale core did, on the picker,
 * with nothing saying why (2026-09-09).
 */
function staleUiReason(): string | null {
  const builtAtMs = statSync(EXE).mtimeMs;
  const newest = newestSource(UI_ROOTS, UI_EXTENSIONS);
  if (newest === null || builtAtMs >= newest.mtimeMs) return null;
  return staleReport(
    'UI',
    EXE,
    builtAtMs,
    newest,
    'bun run --cwd apps/shell tauri build --no-bundle',
  );
}

const staleReason = skipShell ? null : exeMissing
  ? `missing shell: ${EXE}. Run bun run --cwd apps/shell tauri build --no-bundle, or explicitly set BOITE_E2E_SKIP_SHELL=1 for a partial run`
  : (staleCoreReason() ?? staleUiReason());
const shellTest = skipShell || staleReason !== null ? test.skip : test;

// One failure, right away, instead of two turn tests timing out in two minutes.
if (staleReason !== null) {
  const reason = staleReason;
  test('neither the core nor the UI the shell would run is older than its sources', () => {
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
let debugPort = 0;
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

/**
 * A shell with no window: `BOITE_SHELL_HIDDEN` keeps it off the screen, and its
 * WebView2 profile goes under the data directory, so a run never shares a
 * browser process with the installed app the user may have open. A debugging
 * port is only passed when the test drives the page.
 */
function spawnHiddenShell(ownDataDir: string, debugPort?: number): number {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.BOITE_CORE_COMMAND;
  env.BOITE_SHELL_HIDDEN = '1';
  env.BOITE_DATA_DIR = ownDataDir;
  env.BOITE_ECHO = '1';
  if (debugPort !== undefined) {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${debugPort} --remote-allow-origins=*`;
  }
  return Bun.spawn({ cmd: [EXE], env, stdout: 'ignore', stderr: 'ignore', windowsHide: true }).pid;
}

async function waitForHealthyCore(ownDataDir: string): Promise<CoreFile> {
  const corePath = join(ownDataDir, 'core.json');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const file = readCoreFile(corePath);
    if (file !== undefined && (await healthy(file.port))) return file;
    if (Date.now() > deadline) {
      throw new Error(`no core answered /health from ${corePath} within ${READY_TIMEOUT_MS / 1000} s`);
    }
    await Bun.sleep(POLL_MS);
  }
}

/** The webview exposes its page target before the IPC bridge is injected. */
const TAURI_READY = "typeof window.__TAURI_INTERNALS__?.invoke === 'function'";

shellTest('close exits by default; the persisted setting hides instead; the native quota page connects', async () => {
  const ownDataDir = freshDataDir();
  let ownPid = 0;
  let ownCore: CoreFile | undefined;
  let ownPage: BrowserPage | undefined;
  let popup: BrowserPage | undefined;
  try {
    const port = await freePort(); ownPid = spawnHiddenShell(ownDataDir, port);
    ownCore = await waitForHealthyCore(ownDataDir);
    ownPage = await BrowserPage.attach(port);
    await ownPage.waitFor(TAURI_READY);
    expect(await ownPage.evaluate(`window.__TAURI_INTERNALS__.invoke('close_behavior')`)).toBe(false);
    await ownPage.waitFor(`document.querySelector('[data-testid="titlebar"] .close')`);
    await ownPage.evaluate(`document.querySelector('[data-testid="titlebar"] .close').click()`);
    await waitUntil(() => !pidAlive(ownPid) && !pidAlive(ownCore!.pid), CORE_GONE_TIMEOUT_MS);
    expect(pidAlive(ownPid)).toBe(false); expect(pidAlive(ownCore.pid)).toBe(false);
    await ownPage.close(); ownPage = undefined;

    const secondPort = await freePort(); ownPid = spawnHiddenShell(ownDataDir, secondPort);
    ownCore = await waitForHealthyCore(ownDataDir); ownPage = await BrowserPage.attach(secondPort);
    await ownPage.waitFor(`document.querySelector('[data-testid="nav-settings"]')`);
    await ownPage.click('[data-testid="nav-settings"]');
    await ownPage.waitFor(`document.querySelector('[data-testid="close-to-tray"]') && !document.querySelector('[data-testid="close-to-tray"]').disabled`);
    await ownPage.click('[data-testid="close-to-tray"]');
    await ownPage.waitFor(`document.querySelector('[data-testid="close-to-tray"]').checked`);
    await ownPage.screenshot(join(import.meta.dir, '.artifacts', 'shell-close-settings.png'));
    expect(JSON.parse(readFileSync(join(ownDataDir, 'shell-settings.json'), 'utf8')).close_to_tray).toBe(true);
    await ownPage.evaluate(`document.querySelector('[data-testid="titlebar"] .close').click()`);
    expect(await healthy(ownCore.port)).toBe(true);
    expect(pidAlive(ownPid)).toBe(true);

    // Keep every real login out of this test. The popup still crosses real IPC and WS.
    const client = await connect(`http://127.0.0.1:${ownCore.port}`, ownCore.token);
    try {
      for (const account of await client.call('accounts.list', {})) await client.call('quotas.configure', { accountId: account.id, enabled: false });
    } finally { client.close(); }
    await ownPage.evaluate(`window.__TAURI_INTERNALS__.invoke('quota_window', {action:'show'})`);
    popup = await BrowserPage.attach(secondPort, 'view=quotas');
    await popup.waitFor(`document.querySelector('[data-testid="quota-popup"]') && !document.querySelector('[role="alert"]')`);
    await popup.waitFor(`document.querySelector('[data-testid="quota-list"]')`);
    expect(await popup.evaluate(`window.__TAURI_INTERNALS__.invoke('core_endpoint').then(e => Boolean(e.url && e.token))`)).toBe(true);
    await popup.screenshot(join(import.meta.dir, '.artifacts', 'shell-quota-popup.png'));
    await popup.evaluate(`window.__TAURI_INTERNALS__.invoke('quota_window', {action:'hide'})`);
    await popup.close(); popup = undefined;
    await quitShell(ownPage);
    await waitUntil(() => !pidAlive(ownPid), CORE_GONE_TIMEOUT_MS);
    await ownPage.close(); ownPage = undefined;

    const thirdPort = await freePort(); ownPid = spawnHiddenShell(ownDataDir, thirdPort);
    ownCore = await waitForHealthyCore(ownDataDir); ownPage = await BrowserPage.attach(thirdPort);
    await ownPage.waitFor(TAURI_READY);
    expect(await ownPage.evaluate(`window.__TAURI_INTERNALS__.invoke('close_behavior')`)).toBe(true);
    await ownPage.evaluate(`window.__TAURI_INTERNALS__.invoke('close_behavior', {enabled:false})`);
    await ownPage.waitFor(`document.querySelector('[data-testid="titlebar"] .close')`);
    await ownPage.evaluate(`document.querySelector('[data-testid="titlebar"] .close').click()`);
    await waitUntil(() => !pidAlive(ownPid) && !pidAlive(ownCore!.pid), CORE_GONE_TIMEOUT_MS);
    expect(pidAlive(ownPid)).toBe(false); expect(pidAlive(ownCore.pid)).toBe(false);
  } finally {
    await popup?.close(); await ownPage?.close();
    if (ownPid) killProcessTree(ownPid);
    if (ownCore) killProcessTree(ownCore.pid);
    await removeDirectory(ownDataDir);
  }
}, TIMEOUT);

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(POLL_MS);
}

/**
 * The clean quit, the one the tray's Quit item runs: `CoreState::kill_child`
 * and then `app.exit(0)`. `quit_shell` is an application command, which the
 * capability file does not gate, and it is the only way in without a mouse on
 * the tray icon: the window's close button and a `WM_CLOSE` both land on the
 * `CloseRequested` the shell prevents, which hides to the tray and quits
 * nothing (`apps/shell/src-tauri/src/lib.rs`).
 */
async function quitShell(shellPage: BrowserPage): Promise<void> {
  await shellPage.waitFor(TAURI_READY);
  try {
    await shellPage.evaluate<null>(
      `(() => { window.__TAURI_INTERNALS__.invoke('quit_shell'); return null; })()`,
    );
  } catch {
    // The webview can die with the shell before the answer comes back.
  }
}

beforeAll(async () => {
  if (skipShell || staleReason !== null) return;
  dataDir = freshDataDir();
  projectDir = mkdtempSync(join(tmpdir(), 'boite-e2e-shell-project-'));
  debugPort = await freePort();

  const startedAt = performance.now();
  shellPid = spawnHiddenShell(dataDir, debugPort);
  try {
    coreFile = await waitForHealthyCore(dataDir);
  } catch (error) {
    killProcessTree(shellPid);
    throw error;
  }
  startToHealthMs = performance.now() - startedAt;
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
    await page?.click(`${testid('composer-picker-menu')} [data-provider="echo"]`);
    await page?.click(`${testid('composer-picker-menu')} [data-model="echo"]`);
    await page?.waitFor(`!document.querySelector('${testid('composer-picker-menu')}')`);
    await page?.waitFor(`${textOf('composer-picker')}.startsWith('Echo')`);

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

/**
 * A child webview is its own CDP target on the same debugging port, which is
 * exactly why every browser surface shares the main webview's user data folder:
 * a second folder is a second WebView2 browser process, and only the first one
 * can hold `--remote-debugging-port`.
 */
async function browserTargets(url: string): Promise<{ type: string; url: string }[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    });
    const targets = (await response.json()) as { type: string; url: string }[];
    return targets.filter((target) => target.type === 'page' && target.url === url);
  } catch {
    return [];
  }
}

async function waitForTargets(url: string, wanted: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await browserTargets(url);
    if (found.length === wanted) return;
    if (Date.now() > deadline) {
      throw new Error(`the debugging port listed ${found.length} targets on ${url}, wanted ${wanted}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

/** `invoke` from the shell's own page, with the promise it returns awaited. */
async function invokeShell(command: string, args: Record<string, unknown> = {}): Promise<void> {
  await page?.waitFor(TAURI_READY);
  await page?.evaluate<null>(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(() => null)`,
  );
}

shellTest(
  'a browser surface is a child webview the shell parks over the slot and destroys',
  async () => {
    const health = `http://127.0.0.1:${coreFile?.port ?? 0}/health`;
    expect(await browserTargets(health)).toHaveLength(0);

    await invokeShell('browser_create', { id: 't1', url: health });
    await invokeShell('browser_set_bounds', {
      id: 't1',
      rect: { x: 400, y: 100, width: 600, height: 400 },
    });

    // The child is a page of its own on this port, and it really loaded.
    await waitForTargets(health, 1, 20_000);
    const child = (await browserTargets(health))[0];
    expect(child?.url).toBe(health);

    await invokeShell('browser_destroy', { id: 't1' });
    await waitForTargets(health, 0, 20_000);
  },
  TIMEOUT,
);

shellTest(
  'a browser surface refuses a scheme that is not http, https or about',
  async () => {
    const health = `http://127.0.0.1:${coreFile?.port ?? 0}/health`;
    await invokeShell('browser_create', { id: 't2', url: health });
    await waitForTargets(health, 1, 20_000);

    let refusal = '';
    try {
      await invokeShell('browser_navigate', { id: 't2', url: 'file:///C:/Windows/win.ini' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('file');
    expect(refusal).toContain('t2');
    // The page it was already on is the page it stayed on.
    expect(await browserTargets(health)).toHaveLength(1);

    await invokeShell('browser_destroy', { id: 't2' });
    await waitForTargets(health, 0, 20_000);
  },
  TIMEOUT,
);

/**
 * The material itself is drawn by the compositor behind the window, so no
 * capture of this webview can show it. What is provable here is the half the UI
 * owns: the stored choice is read before the first paint of every load, and
 * `data-glass` is what `app.css` reads to let the ground through. Solid removes
 * the attribute instead of setting a third value.
 */
async function reloadShellPage(): Promise<void> {
  await page?.send('Page.reload', {});
  await page?.waitFor(`document.querySelector('${testid('sidebar')}')`, 30_000);
}

shellTest(
  'the stored window material is stamped on every load, and solid stamps nothing',
  async () => {
    await page?.evaluate<null>(
      `(() => { window.localStorage.setItem('boite.glass', 'mica'); return null; })()`,
    );
    await reloadShellPage();
    await page?.waitFor(`document.documentElement.dataset.glass === 'mica'`, 30_000);

    await page?.evaluate<null>(
      `(() => { window.localStorage.setItem('boite.glass', 'solid'); return null; })()`,
    );
    await reloadShellPage();
    await page?.waitFor(`document.documentElement.dataset.glass === undefined`, 30_000);
    expect(await page?.evaluate<string | undefined>('document.documentElement.dataset.glass')).toBe(
      undefined,
    );

    // The other half, which the UI swallows on purpose: the command is really
    // registered, it really reaches the window, and a material nobody defined is
    // refused by name rather than falling back on one.
    const supported = await page?.evaluate<boolean>(
      `window.__TAURI_INTERNALS__.invoke('window_material_supported')`,
    );
    expect(supported).toBe(process.platform === 'win32');

    await invokeShell('window_material', { kind: 'mica' });
    await invokeShell('window_material', { kind: 'solid' });

    let refusal = '';
    try {
      await invokeShell('window_material', { kind: 'frosted' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('frosted');
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
    const shell = spawnHiddenShell(ownDataDir);
    let corePid = 0;

    try {
      corePid = (await waitForHealthyCore(ownDataDir)).pid;
      expect(corePid).toBeGreaterThan(0);
      expect(pidAlive(corePid)).toBe(true);

      // The shell alone, no `/T`: nothing walks the tree here, so only the Job
      // Object the shell owns can take the core down.
      Bun.spawnSync(['taskkill', '/pid', String(shell), '/F'], { stdout: 'ignore', stderr: 'ignore' });

      await waitUntil(() => !pidAlive(corePid), HARD_KILL_TIMEOUT_MS);
      expect(pidAlive(shell)).toBe(false);
      expect(pidAlive(corePid)).toBe(false);
    } finally {
      killProcessTree(shell);
      if (corePid > 0) killProcessTree(corePid);
      killWebviewsOf(ownDataDir);
      await removeDirectory(ownDataDir);
    }
  },
  TIMEOUT,
);

shellTest(
  'a clean quit kills the core the shell started',
  async () => {
    // `kill_child` is the explicit half of the shutdown: the tree kill above
    // proves the Job Object, this proves the shell asking its own core to go.
    const ownDataDir = freshDataDir();
    const debugPort = await freePort();
    const shell = spawnHiddenShell(ownDataDir, debugPort);
    let corePid = 0;
    let shellPage: BrowserPage | undefined;

    try {
      corePid = (await waitForHealthyCore(ownDataDir)).pid;
      expect(corePid).toBeGreaterThan(0);
      expect(pidAlive(corePid)).toBe(true);
      // Started, not adopted: the core is this shell's own child.
      expect(parentOf(corePid)).toBe(shell);

      shellPage = await BrowserPage.attach(debugPort);
      await quitShell(shellPage);

      await waitUntil(() => !pidAlive(shell) && !pidAlive(corePid), CORE_GONE_TIMEOUT_MS);
      expect(pidAlive(shell)).toBe(false);
      expect(pidAlive(corePid)).toBe(false);
    } finally {
      await shellPage?.close();
      killProcessTree(shell);
      if (corePid > 0) killProcessTree(corePid);
      killWebviewsOf(ownDataDir);
      await removeDirectory(ownDataDir);
    }
  },
  TIMEOUT,
);

shellTest(
  'a clean quit leaves the core the shell adopted alone',
  async () => {
    // A core that was already answering when the shell opened is nobody's
    // child and is in no Job Object of the shell's: quitting must not touch it.
    const adopted = await startCore();
    const debugPort = await freePort();
    let shell = 0;
    let shellPage: BrowserPage | undefined;

    try {
      shell = spawnHiddenShell(adopted.dataDir, debugPort);
      shellPage = await BrowserPage.attach(debugPort);

      // Adopted, not replaced: the endpoint the shell hands its own UI is the
      // core this test started, and `core.json` still names that process. The
      // page target is there before the IPC is, so this waits for the bridge.
      await shellPage.waitFor(TAURI_READY);
      const endpoint = await shellPage.evaluate<{ url: string }>(
        `window.__TAURI_INTERNALS__.invoke('core_endpoint')`,
      );
      expect(endpoint.url).toContain(`:${adopted.port}`);
      expect(readCoreFile(join(adopted.dataDir, 'core.json'))?.pid).toBe(adopted.pid);

      await quitShell(shellPage);

      await waitUntil(() => !pidAlive(shell), CORE_GONE_TIMEOUT_MS);
      expect(pidAlive(shell)).toBe(false);

      // Long enough for a job handle closing at exit to have taken it down.
      await Bun.sleep(500);
      expect(pidAlive(adopted.pid)).toBe(true);
      expect(await healthy(adopted.port)).toBe(true);
    } finally {
      await shellPage?.close();
      if (shell > 0) killProcessTree(shell);
      killWebviewsOf(adopted.dataDir);
      await adopted.stop();
    }
  },
  TIMEOUT,
);
