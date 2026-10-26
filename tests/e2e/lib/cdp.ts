import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from '../../../packages/ui/src/lib/onboarding.ts';
import type { Subprocess } from 'bun';
import { E2E_DIR_PREFIX, killProcessTreeAsync, removeDirectory, watchParentDeath, type ParentDeathWatch } from './cleanup.ts';
import { reportOnHang } from './hang-report.ts';
import { uiServerSide } from './ui-requests.ts';
import { windowsProcessTree } from './process-tree.ts';
import { TextSocket } from '../../../packages/core/src/ws-client.ts';

/**
 * Marks the tour seen before any script of the page runs, and only where no
 * record is stored yet, so a test that writes its own keeps it across a reload.
 * Every profile a test drives is new, and the tour it would open covers the page.
 */
/**
 * This harness's Chrome leaves `navigator.webdriver` false where Playwright's
 * sets it. A launched page is told it is driven, so the app's automation
 * guards hold: Load on press waits for the click (`lib/press-preload.ts`).
 */
const DRIVEN = `Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => true, configurable: true });`;
const SEEN_TOUR = `try { if (localStorage.getItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}) === null) localStorage.setItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ version: ONBOARDING_VERSION, at: 0 }))}); } catch {}`;

const CONNECT_TIMEOUT_MS = 30_000;
/** How long a killed browser may take to exit: 30.6 s was measured on a loaded machine. */
const EXIT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
/** Distinct debugging-port answers a failed wait reports. */
const MAX_POLL_ANSWERS = 12;
/** How long the failure probe gives the debugging port, for TCP and then HTTP. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long a failed attach waits for its launcher's diagnosis. */
const DIAGNOSIS_TIMEOUT_MS = 20_000;
const WAIT_DIAGNOSTIC_TIMEOUT_MS = 250;
/** Main-frame navigation events a page keeps for its failure reports. */
const NAVIGATION_EVENTS = 30;
/**
 * Each `history.back()` and `popstate` of a main-frame document, sent to the navigation log through a binding:
 * a back that lands late takes over the navigation that follows it, and the document that called it is gone
 * by the time that navigation fails.
 */
const HISTORY_BINDING = '__boiteE2eHistory';
const HISTORY_WATCH = `if (window === top && typeof ${HISTORY_BINDING} === 'function') {
  const report = ${HISTORY_BINDING};
  const state = () => { try { return String(JSON.stringify(history.state)).slice(0, 160); } catch { return '?'; } };
  const back = History.prototype.back;
  History.prototype.back = function () { report('history.back() with state ' + state()); return back.call(this); };
  addEventListener('popstate', () => report('popstate to state ' + state()));
}`;
/** What a page that left an evaluate hanging is doing: frames drawn in a second, fonts and animations still pending. */
const HUNG_PAGE = `new Promise((resolve) => {
  let frames = 0;
  const tick = () => { frames += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve({
    framesInOneSecond: frames,
    visibility: document.visibilityState,
    fonts: document.fonts.status,
    loadingFonts: [...document.fonts].filter((f) => f.status === 'loading').map((f) => f.family + ' ' + f.weight),
    animations: document.getAnimations().filter((a) => a.playState !== 'finished').slice(0, 8)
      .map((a) => (a.animationName ?? a.transitionProperty ?? a.id) + ' ' + a.playState + ' .' + String(a.effect?.target?.className ?? '?').split(' ')[0]),
  }), 1000);
})`;

/**
 * Candidates in order; `BOITE_E2E_BROWSER` overrides all of them. Helium comes
 * last: on a fresh profile it reloads the open tab a few seconds after launch,
 * with no script or devtools call behind it, and the page boots a second time.
 */
function browserCandidates(): string[] {
  const local = process.env.LOCALAPPDATA ?? '';
  const programs = process.env.ProgramFiles ?? '';
  const programsX86 = process.env['ProgramFiles(x86)'] ?? '';
  if (process.platform === 'win32') {
    return [
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programs, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programsX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programsX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(local, 'imput', 'Helium', 'Application', 'chrome.exe'),
    ].filter((path) => path.length > 0);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

export function findBrowser(): string {
  const override = process.env.BOITE_E2E_BROWSER;
  if (override !== undefined && override !== '') return override;
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no Chromium was found. Looked at:\n${browserCandidates().join('\n')}\nSet BOITE_E2E_BROWSER to one.`,
  );
}

export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('the OS did not report a port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export interface TargetInfo {
  id?: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InFlight {
  url: string;
  /** When its devtools event reached us, which can be after the server answered it. */
  at: number;
  /** When Chrome sent it (`wallTime`), on the same clock as `Date.now()`. */
  wall?: number;
  answered: boolean;
  frameId?: string;
  loaderId?: string;
  sent?: number;
  headers?: number;
  cache?: boolean;
}

/** One process of `SystemInfo.getProcessInfo`, CPU time in seconds since it started. */
interface ProcessInfo { type: string; id: number; cpuTime: number }

/**
 * `BOITE_E2E_HANG_STACK=1` turns the debugger on in every page, so a page whose
 * main thread runs JavaScript past an evaluate's deadline reports where. Off by
 * default: `Debugger.enable` waits for that thread like any other call, so it
 * cannot be sent once the page hangs, and on it reports every script parsed.
 */
const HANG_STACK = process.env.BOITE_E2E_HANG_STACK === '1';

export interface BrowserOptions {
  url: string;
  executable?: string;
  userDataDir?: string;
  debugPort?: number;
  windowSize?: { width: number; height: number };
  /** Leaves the profile as a device that never saw the tour, which opens on boot. */
  showTour?: boolean;
  /** Experiments switched on before the first boot, as Settings, Experiments stores them. */
  experiments?: string[];
  /** Extra Chromium switches, such as the fake camera a scan test reads its code from. */
  args?: string[];
  /**
   * Terminals draw on the GPU, as on a user's device. Off by default: the DOM
   * renderer puts the screen's text in `.xterm-rows`, which most tests read.
   */
  terminalGpu?: boolean;
}

/** How a browser that never got as far as its page fails: the only failures `launch` tries again. */
const STARTUP_STALLS = ['the browser never exposed a page', 'the devtools socket', 'Page.navigate timed out', 'the requested navigation never committed'];

/** Every page `launch` opened and nobody closed yet, for `closeAllBrowsers`. */
const open = new Set<BrowserPage>();

/**
 * Closes whatever a file launched and left open, a `beforeAll` that timed out
 * before it could hand its page over for one. The preload calls it after the run.
 */
export async function closeAllBrowsers(): Promise<void> {
  await Promise.all([...open].map((page) => page.close()));
}

// A run stopped at its deadline (scripts/ci/hang-watch.ts) reports every page still open.
reportOnHang('browser pages', async () => {
  const reports = await Promise.all([...open].map((page) => page.hangReport()));
  return reports.join('\n\n') || '(no page open)';
});

/**
 * Lets a closing browser exit, then kills a stalled browser's process tree
 * before its profile is removed: a profile deleted under a live browser was
 * the 0.5 GB each full run used to leave behind in the temp folder.
 */
async function stopBrowser(proc: Subprocess, userDataDir: string | null, watch: ParentDeathWatch | null): Promise<void> {
  if (proc.exitCode === null) {
    // POSIX's captured-PID kill cannot reap Chrome's children. SIGTERM lets
    // Chrome do that itself, including when startup failed before CDP opened.
    if (process.platform !== 'win32') proc.kill('SIGTERM');
    const graceful = await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
    if (!graceful && proc.exitCode === null) await killProcessTreeAsync(proc.pid);
  }
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(EXIT_TIMEOUT_MS).then(() => false)]);
  if (!exited) console.warn(`e2e: browser ${proc.pid} still running ${EXIT_TIMEOUT_MS} ms after its kill`);
  // A browser that would not exit keeps its watchdog, which still takes it
  // down if this process dies.
  else watch?.release();
  if (userDataDir !== null) await removeDirectory(userDataDir);
}

/** Only error codes: filesystem errors can contain arbitrary caller paths. */
function diagnosticError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unavailable';
}

function executableMetadata(selected: string): object {
  try {
    const resolved = realpathSync(Bun.which(selected) ?? selected);
    const info = statSync(resolved);
    return { selected, resolved, size: info.size, modifiedAt: info.mtimeMs };
  } catch (error) { return { selected, error: diagnosticError(error) }; }
}

/** Caller-owned profiles are never inspected; owned ones expose metadata only. */
function profileMarkers(profile: string): Record<string, object> {
  return Object.fromEntries(['First Run', 'SingletonLock', 'SingletonCookie', 'DevToolsActivePort'].map(name => {
    try {
      const path = join(profile, name);
      const info = lstatSync(path);
      const marker: { kind: string; size: number; modifiedAt: number; port?: number; error?: string } = {
        kind: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'directory', size: info.size, modifiedAt: info.mtimeMs,
      };
      // Never follow a marker symlink or read the WebSocket endpoint on line 2.
      if (name === 'DevToolsActivePort' && !info.isSymbolicLink()) {
        if (!info.isFile()) marker.error = 'EISDIR';
        else {
          const fd = openSync(path, 'r');
          try {
            const byte = Buffer.alloc(1);
            let line = '';
            for (let offset = 0; offset < 7; offset++) {
              if (readSync(fd, byte, 0, 1, offset) === 0 || byte[0] === 10) break;
              line += byte.toString('ascii');
            }
            line = line.trim();
            if (/^\d{1,5}$/.test(line) && Number(line) > 0 && Number(line) <= 65535) marker.port = Number(line);
          } finally { closeSync(fd); }
        }
      }
      return [name, marker];
    } catch (error) { return [name, { error: diagnosticError(error) }]; }
  }));
}

/** No raw command line, URL, or arbitrary switch value leaves the native helper. */
async function startupProcessTree(pid: number, profile: string, port: number, authorized: () => boolean): Promise<object[]> {
  return (await windowsProcessTree(pid, authorized)).map(proc => {
    const command = proc.CommandLine ?? '';
    const type = /(?:^|\s)--type=([a-z-]+)(?:\s|$)/.exec(command)?.[1];
    const knownType = ['renderer', 'gpu-process', 'utility', 'crashpad-handler'].includes(type ?? '') ? type : undefined;
    return {
      pid: proc.ProcessId, parentPid: proc.ParentProcessId, image: proc.Name, type: knownType,
      // Exact value matches are observations, not proof of process incarnation.
      port: new RegExp(`(?:^|\\s)--remote-debugging-port=${port}(?:\\s|$)`).test(command) ? port : undefined,
      profileMatches: command.includes(`--user-data-dir="${profile}"`) || command.includes(`"--user-data-dir=${profile}"`)
        || command.split(/\s+/).includes(`--user-data-dir=${profile}`),
    };
  });
}

export class BrowserPage {
  #socket: TextSocket;
  #proc: Subprocess | null;
  #watch: ParentDeathWatch | null;
  #userDataDir: string | null;
  #target: TargetInfo;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;
  /**
   * Set once devtools sent a message that is not JSON. Chrome never does: the
   * socket lost its frame alignment, so replies may be gone and every later
   * call fails with this instead of waiting out its timeout.
   */
  #fault: string | null = null;
  #pageErrors: string[] = [];
  /**
   * Requests the page's current documents sent and have not finished loading,
   * reported when a wait times out. `sent` and `headers` are the network
   * service's own events, which reach devtools from the browser process even
   * while the renderer's main thread is blocked and Blink reports nothing.
   */
  #requests = new Map<string, InFlight>();
  /** Network-service events that came before the request they belong to. */
  #early = new Map<string, { sent?: number; headers?: number }>();
  /** The debugging port of the browser this page runs in, for the processes' CPU. */
  #debugPort: number | null = null;
  #paused: ((frames: string) => void) | null = null;
  /** Completed failures would otherwise disappear from the timeout's in-flight list. */
  #networkFailures: string[] = [];
  /**
   * What devtools said of the main frame's navigations, oldest first, timed
   * from when this page opened its socket: a page left on about:blank shows
   * whether a navigation reached it, where to, and how its document request
   * ended. Main frame only, the last `NAVIGATION_EVENTS`.
   */
  #navigations: string[] = [];
  #opened = Date.now();
  /** Main-frame document requests still loading, by request id. */
  #documents = new Set<string>();
  errors(): string[] { return [...this.#pageErrors]; }
  navigationLog(): string[] { return [...this.#navigations]; }
  /** The profile `launch` made for this page and removes on close; null when the caller owns it. */
  get profileDir(): string | null { return this.#userDataDir; }
  /** The browser's pid, null for a page `attach` drives. */
  get pid(): number | null { return this.#proc?.pid ?? null; }
  /** The `/json/list` entry this page was opened on, as it read then. */
  get target(): TargetInfo { return { ...this.#target }; }

  private constructor(socket: TextSocket, target: TargetInfo, proc: Subprocess | null, userDataDir: string | null, watch: ParentDeathWatch | null = null) {
    this.#socket = socket;
    this.#target = target;
    this.#proc = proc;
    this.#watch = watch;
    this.#userDataDir = userDataDir;
    socket.onMessage((text) => this.#receive(text));
    socket.onClose(({ code, reason }) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`the devtools socket closed (${code} ${reason}), the browser exited or was killed (bun test kills every process a file started when one of its tests or hooks times out)`));
      }
      this.#pending.clear();
    });
  }

  /**
   * A browser on `options.url`. A start that never reached the page is tried
   * once more with a fresh process: on a loaded Windows runner the first
   * Chrome of a shard has taken over 30 s to open its debugging port, and one
   * in the middle of a run over 20 s to commit its first navigation, on `main`
   * as on branches (2026-10-07). What the page does once it is up is never retried.
   */
  static async launch(options: BrowserOptions): Promise<BrowserPage> {
    try {
      return await BrowserPage.#start(options, 1);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!STARTUP_STALLS.some((stall) => reason.startsWith(stall))) throw error;
      console.warn(`[e2e] the browser did not start, launching it once more: ${reason.split('\n', 1)[0]}`);
      return BrowserPage.#start(options, 2);
    }
  }

  static async #start(options: BrowserOptions, attempt: number): Promise<BrowserPage> {
    const executable = options.executable ?? findBrowser();
    const ownsUserDataDir = options.userDataDir === undefined;
    const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), `${E2E_DIR_PREFIX}browser-`));
    const port = options.debugPort ?? (await freePort());
    const size = options.windowSize ?? { width: 1440, height: 900 };

    const startedAt = Date.now();
    const executableInfo = executableMetadata(executable);
    const launch = {
      cmd: [
        executable,
        '--headless=new',
        // Hosted CI has no hardware GPU. Use CPU compositing there, with
        // software GL disabled so Chrome cannot fall back to SwiftShader.
        ...(process.env.CI === 'true'
          ? ['--disable-gpu', '--disable-software-rasterizer']
          : process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11']
            : process.platform === 'linux' ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl-egl', '--disable-software-rasterizer'] : []),
        '--mute-audio',
        // The suite's assertions are written in English and its numbers read
        // with the browser's own `toLocaleString`: both follow this, not the
        // language of the machine the run happens on.
        '--lang=en-US',
        '--accept-lang=en-US',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // No outside host resolves. A Chromium that ships a content blocker holds
        // every request of the page while its list update waits on a connect.
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        // Keep hidden test pages responsive when another browser owns the active page.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--remote-allow-origins=*',
        `--window-size=${size.width},${size.height}`,
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        ...(options.args ?? []),
        'about:blank',
      ],
      stdout: 'ignore' as const,
      stderr: 'pipe' as const,
      windowsHide: true,
    };
    const proc = Bun.spawn(launch);
    // Linux and macOS: a test process killed outright still takes its browser
    // and profile with it. Windows keeps the tree kill of `stopBrowser`.
    const watch = watchParentDeath(proc.pid, ownsUserDataDir ? userDataDir : null);

    // Drain continuously: a full pipe must never hold Chrome's startup.
    // Keep a bounded tail for failures instead of discarding GPU/crash errors.
    let stderr = '';
    const drainErrors = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) {
        stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-16_384);
      }
      stderr = (stderr + decoder.decode()).slice(-16_384);
    })();
    void drainErrors.catch(() => undefined);

    let exitedAt: number | null = null;
    void proc.exited.then(() => { exitedAt = Date.now(); }, () => undefined);
    let native: Record<string, unknown> = { status: process.platform === 'win32' ? 'not-started' : 'unsupported' };
    let observing = true;
    const collectLate = (deadline: number) => {
      if (!observing || native.status !== 'not-started') return;
      const requestedAt = Date.now();
      native = { status: 'pending', requestedAt };
      // The FFI helper cannot be preempted while synchronous native work runs.
      // Its promise is handled, but startup/cleanup never awaits it.
      void startupProcessTree(proc.pid, userDataDir, port,
        () => observing && proc.exitCode === null && Date.now() <= deadline).then(tree => {
        if (observing) native = { status: 'collected', requestedAt, completedAt: Date.now(), tree, incarnationVerified: false };
      }, error => {
        if (observing) native = { status: 'failed', requestedAt, completedAt: Date.now(), error: diagnosticError(error) };
      });
    };
    let page: BrowserPage | null = null;
    try {
      const target = await waitForPageTarget(port, '', proc, true, collectLate);
      const socket = await openSocket(target);
      page = new BrowserPage(socket, target, proc, ownsUserDataDir ? userDataDir : null, watch);
      page.#debugPort = port;
      open.add(page);
      await page.send('Page.enable', {});
      await page.send('Runtime.enable', {});
      await page.send('Network.enable', {});
      await page.#enableHangProbes();
      await page.#watchHistory();
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: DRIVEN });
      if (options.showTour !== true) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SEEN_TOUR });
      if (options.terminalGpu !== true) {
        // Only on a fresh profile: a test that turns the GPU on and reloads keeps its choice.
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { if (localStorage.getItem('boite.terminalGpu') === null) localStorage.setItem('boite.terminalGpu', 'off'); } catch {}` });
      }
      if (options.experiments !== undefined) {
        const stored = JSON.stringify(JSON.stringify(options.experiments));
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('boite.experiments', ${stored}); } catch {}` });
      }
      // Windows may clamp the headless window. Pin the CSS viewport before startup.
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
      });
      await page.navigate(options.url);
      observing = false;
      return page;
    } catch (error) {
      observing = false;
      const failedAt = Date.now();
      const log = join(import.meta.dir, '..', '.artifacts', `browser-${proc.pid}.log`);
      const diagnostic = join(dirname(log), `browser-${proc.pid}-attempt-${attempt}.json`);
      let unavailable = '';
      // Freeze and persist before cleanup can change exit state or delete markers.
      try {
        const report = {
          attempt, startedAt, failedAt, elapsedMs: failedAt - startedAt, pid: proc.pid, port,
          executable: executableInfo,
          profile: { path: userDataDir, owned: ownsUserDataDir, markers: ownsUserDataDir ? profileMarkers(userDataDir) : undefined },
          flags: launch.cmd.filter(arg => ['--headless=new', '--mute-audio', '--disable-gpu', '--enable-gpu', '--disable-software-rasterizer',
            '--use-gl=angle', '--use-angle=d3d11', '--use-angle=gl-egl'].includes(arg)),
          wrapper: { exitCode: proc.exitCode, signalCode: proc.signalCode, exitedAt },
          native: { ...native, ageMs: typeof native.completedAt === 'number' ? failedAt - native.completedAt : null },
          stderr: stderr.replace(/(DevTools listening on\s+)wss?:\/\/\S+/g, '$1[redacted]'),
        };
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(diagnostic, JSON.stringify(report, null, 2));
      } catch (failure) {
        unavailable = `\nStartup diagnostic unavailable: ${diagnosticError(failure)}`;
        console.warn(`[e2e]${unavailable}`);
      }
      if (page !== null) await page.close();
      else await stopBrowser(proc, ownsUserDataDir ? userDataDir : null, watch);
      await drainErrors.catch(() => undefined);
      try {
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, stderr);
      } catch (failure) { unavailable += `\nBrowser stderr log unavailable: ${diagnosticError(failure)}`; }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}\nBrowser stderr: ${log}\n${stderr}${unavailable}`, { cause: error });
    }
  }

  /**
   * Drives a page that something else launched, such as the shell's WebView2
   * started with `--remote-debugging-port`. Closing it kills nothing. When the
   * attach fails, `diagnose` gets the failure and says what the launcher left
   * behind (the shell's own log, its process tree); its text, given at most
   * `DIAGNOSIS_TIMEOUT_MS`, joins the error.
   */
  static async attach(port: number, urlIncludes = '', diagnose?: (failure: string) => string | Promise<string>): Promise<BrowserPage> {
    let page: BrowserPage | undefined;
    try {
      const target = await waitForPageTarget(port, urlIncludes);
      page = new BrowserPage(await openSocket(target), target, null, null);
      page.#debugPort = port;
      return await page.#prepareAttached();
    } catch (error) {
      await page?.close().catch(() => undefined);
      if (diagnose === undefined) throw error;
      const failure = error instanceof Error ? error.message : String(error);
      throw new Error(`${failure}\n${await diagnosis(() => diagnose(failure))}`, { cause: error });
    }
  }

  /** Readies an attached page: domains on, the tour recorded as seen. */
  async #prepareAttached(): Promise<BrowserPage> {
    await this.send('Page.enable', {});
    await this.send('Runtime.enable', {});
    // A page launched here reports its requests; one attached to, its own document request too (`navigationLog`).
    await this.send('Network.enable', {});
    await this.#enableHangProbes();
    await this.#watchHistory();
    // The page booted before we got here, on a profile as new as the data
    // directory it sits in: it read "never seen" already. Record the tour and
    // boot it again, once, so every later reload finds the record too.
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: SEEN_TOUR });
    const unseen = await this.evaluate<boolean>(
      `(() => { try { return localStorage.getItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}) === null; } catch { return false; } })()`,
    );
    if (unseen) {
      // That first boot may also have settled this device as a first run (the
      // calm preset, `WORK_STORAGE_KEY` in `lib/work-prefs.svelte.ts`). Forget
      // it: with the tour seen, the reload settles it as a working setup, as
      // every page `launch` drives does.
      await this.evaluate(`(() => { try { localStorage.removeItem('boite.work'); } catch {} })()`);
      await this.reload();
    }
    return this;
  }

  /** The one place raw devtools JSON is handled. */
  send(method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('the browser is closed'));
    if (this.#fault !== null) return Promise.reject(new Error(this.#fault));
    // A send on a closed socket is dropped without an error, and each call then
    // waited out its whole timeout: after `bun test` killed the browser of a
    // file whose test timed out, every later test of that file spent 20 s on a
    // "Runtime.evaluate timed out" that looked like a hung renderer.
    if (!this.#socket.open) {
      return Promise.reject(new Error(`the devtools socket closed before ${method}: the browser exited or was killed. bun test kills every process a file started when one of its tests or hooks times out, so look for the file's first failure`));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // Name the expression: every hung evaluate otherwise reports the same line of this file.
        const what = typeof params.expression === 'string' ? `: ${params.expression.replace(/\s+/g, ' ').slice(0, 160)}` : '';
        reject(new Error(`${method} timed out${what}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Untyped expressions return a by-value JavaScript result; callers can name a narrower shape. */
  evaluate(expression: string, timeoutMs?: number): Promise<string | number | boolean | object | null | undefined>;
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  async evaluate<T>(expression: string, timeoutMs?: number): Promise<T> {
    const raw = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs ?? CALL_TIMEOUT_MS).catch(async (error: unknown) => {
      // A direct call that hangs says what the page was waiting on: a promise
      // that never settles (fonts, an animation) or a page that stopped drawing.
      if (timeoutMs !== undefined || !(error instanceof Error) || !error.message.includes('timed out')) throw error;
      const state = await this.send('Runtime.evaluate', { expression: HUNG_PAGE, returnByValue: true, awaitPromise: true }, 3_000)
        .then((result) => JSON.stringify((result as { result?: { value?: unknown } }).result?.value))
        .catch(() => null);
      throw new Error(`${error.message}
Page: ${state === null ? `the page did not answer either: its main thread is busy\n${await this.#busyReport()}` : state}
In flight: ${JSON.stringify(this.#inFlight())}`);
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string; value?: unknown };
      };
    };
    const failure = raw.exceptionDetails;
    if (failure !== undefined) {
      // A Tauri command rejects with a plain string, which devtools reports as a
      // value and not as a description: without this line every refusal read
      // "Uncaught (in promise)" and said nothing about what was refused.
      const thrown = failure.exception?.value;
      const detail =
        failure.exception?.description ??
        (thrown === undefined ? undefined : JSON.stringify(thrown)) ??
        failure.text ??
        'unknown';
      throw new Error(`evaluate failed: ${detail}\nexpression: ${expression}`);
    }
    return raw.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      if (this.#closed || !this.#socket.open) throw new Error('the browser is closed');
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const ok = await this.evaluate<boolean>(`(async () => !!(await (${expression})))()`, Math.min(CALL_TIMEOUT_MS, remaining));
        if (ok) return;
        last = 'it stayed false';
      } catch (error) {
        if (this.#closed || !this.#socket.open) throw error;
        last = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
    if (this.#closed || !this.#socket.open) throw new Error('the browser is closed');
    // A separate, bounded grace preserves useful diagnostics after the condition consumes its budget.
    const state = await this.evaluate(`({ location: location.origin + location.pathname, ready: document.readyState, title: document.title, text: document.body?.innerText.slice(0, 500) })`, WAIT_DIAGNOSTIC_TIMEOUT_MS).catch(() => 'page diagnostic timed out');
    throw new Error(`waitFor timed out on ${expression}: ${last}\nPage: ${JSON.stringify(state)}\nErrors: ${JSON.stringify(this.#pageErrors)}\nIn flight: ${JSON.stringify(this.#inFlight())}\nFailed requests: ${JSON.stringify(this.#networkFailures)}`);
  }

  async navigate(url: string): Promise<void> {
    const result = await this.send('Page.navigate', { url }) as { errorText?: string; loaderId?: string };
    if (result.errorText) {
      const state = await this.evaluate(`({ location: location.origin + location.pathname, ready: document.readyState, title: document.title, text: document.body?.innerText.slice(0, 500) })`, WAIT_DIAGNOSTIC_TIMEOUT_MS).catch(() => 'page diagnostic timed out');
      throw new Error(`navigation failed: ${result.errorText}\nPage: ${JSON.stringify(state)}\nErrors: ${JSON.stringify(this.#pageErrors)}\nFailed requests: ${JSON.stringify(this.#networkFailures)}`);
    }
    if (result.loaderId) {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      for (;;) {
        const tree = await this.send('Page.getFrameTree', {}) as { frameTree: { frame: { loaderId: string; url: string } } };
        if (tree.frameTree.frame.loaderId === result.loaderId) break;
        if (Date.now() > deadline) throw new Error(`the requested navigation never committed in ${CONNECT_TIMEOUT_MS / 1000} s: loader ${result.loaderId}, the frame is on ${tree.frameTree.frame.url.split(/[?#]/, 1)[0]} loader ${tree.frameTree.frame.loaderId}
${await this.#historyReport()}`);
        await Bun.sleep(POLL_MS);
      }
    }
    // A cold Vite dependency build on the Windows runner can outlast the normal DOM wait.
    await this.waitFor("document.readyState === 'complete'", 60_000);
  }

  /** The tab's last history entries, `*` on the current one, and the main frame's navigation log. */
  async #historyReport(): Promise<string> {
    const history = await this.send('Page.getNavigationHistory', {}, WAIT_DIAGNOSTIC_TIMEOUT_MS * 4)
      .then((answer) => {
        const { currentIndex, entries } = answer as { currentIndex: number; entries: { url: string; transitionType: string }[] };
        // Without their query strings, as in the navigation log.
        return entries.map((entry, index) => `${index === currentIndex ? '* ' : ''}${entry.url.split(/[?#]/, 1)[0]} (${entry.transitionType})`).slice(-8).join(', ');
      })
      .catch((error: unknown) => `unread (${error instanceof Error ? error.message : String(error)})`);
    return `History: ${history}\nNavigations:\n  ${this.#navigations.join('\n  ')}`;
  }

  /** Boots the same page again and returns once the new document has loaded. */
  async reload(): Promise<void> {
    const frame = async (): Promise<string> =>
      ((await this.send('Page.getFrameTree', {})) as { frameTree: { frame: { loaderId: string } } }).frameTree.frame.loaderId;
    const before = await frame();
    await this.send('Page.reload', {});
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while ((await frame()) === before) {
      if (Date.now() > deadline) throw new Error('the reload never committed');
      await Bun.sleep(POLL_MS);
    }
    await this.waitFor("document.readyState === 'complete'", 60_000);
  }

  async click(selector: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate<null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.click(); return null; })()`,
    );
  }

  /** Sets the value and fires `input`, which is what a Svelte binding listens to. */
  async type(selector: string, text: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate<null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return null;
      })()`,
    );
  }

  /** Same idea for a `<select>`, which reacts to `change`. */
  async choose(selector: string, value: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate<null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      })()`,
    );
  }

  text(selector: string): Promise<string> {
    return this.evaluate<string>(
      `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`,
    );
  }

  /**
   * Waits for the fonts and every finite animation that is drawn. Chrome
   * settles an animation's `finished` promise on a rendering frame, so frames
   * are requested until everything has settled. An element that is not
   * rendered, such as one inside a folded `content-visibility` section, never
   * gets that update: a theme change left its colour transitions finished
   * with their promises pending, and the wait hung until the call timed out.
   * Content can also stop being drawn during the wait (a phone's chat body
   * covered by the list), so each frame looks again.
   */
  async settleAnimations(): Promise<void> {
    // The page gives up first, so the frame pump never outlives the call.
    const running = await this.evaluate<string[] | null>(`new Promise((resolve) => {
      let live = true, fonts = false;
      const done = (ok) => { if (!live) return; live = false; resolve(ok ? null : watched.filter((a) => !ended.has(a) && drawn(a))
        .map((a) => (a.animationName ?? a.transitionProperty ?? a.id) + ' on .' + String(a.effect?.target?.className ?? '?').split(' ')[0] + ' ' + a.playState).concat(fonts ? [] : [...document.fonts].filter((f) => f.status === 'loading').map((f) => 'font ' + f.family + ' ' + f.weight + ' loading').concat(['document.fonts ' + document.fonts.status]))); };
      const drawn = (a) => !(a.effect instanceof KeyframeEffect) || a.effect.target?.checkVisibility?.({ contentVisibilityAuto: true }) !== false;
      const ended = new Set();
      const watched = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity && drawn(a));
      for (const a of watched) a.finished.then(() => ended.add(a), () => ended.add(a));
      document.fonts.ready.then(() => { fonts = true; });
      const frame = () => {
        if (!live) return;
        if (fonts && watched.every((a) => ended.has(a) || !drawn(a))) return done(true);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      setTimeout(() => done(false), ${CALL_TIMEOUT_MS - 5_000});
    })`);
    if (running) throw new Error(`animations still running ${(CALL_TIMEOUT_MS - 5_000) / 1000} s after settleAnimations(): ${running.join(', ')}
In flight: ${JSON.stringify(this.#inFlight())}`);
  }

  async screenshot(path: string): Promise<void> {
    const raw = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (typeof raw.data !== 'string') throw new Error('the screenshot came back empty');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(raw.data, 'base64'));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // Let Chrome stop its children and finish profile writes before removal.
    // An unresponsive browser still falls through to the captured-PID kill.
    const shutdown = this.#proc !== null && this.#proc.exitCode === null
      ? this.send('Browser.close', {}, 2_000).catch(() => undefined)
      : Promise.resolve();
    this.#closed = true;
    await shutdown;
    try {
      this.#socket.close();
    } catch {
      /* already gone */
    }
    open.delete(this);
    if (this.#proc !== null) await stopBrowser(this.#proc, this.#userDataDir, this.#watch);
    else if (this.#userDataDir !== null) await removeDirectory(this.#userDataDir);
  }

  async #watchHistory(): Promise<void> {
    await this.send('Runtime.addBinding', { name: HISTORY_BINDING });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: HISTORY_WATCH });
  }

  /** What a run stopped at its deadline reports of this page: its target, what it waits on and whether its main thread answers. */
  async hangReport(): Promise<string> {
    return [
      `Page ${JSON.stringify(this.#target.url)} of browser ${this.pid ?? 'attached'} on port ${this.#debugPort ?? '?'}${this.#fault === null ? '' : `, socket fault: ${this.#fault}`}`,
      `Calls waiting: ${this.#pending.size}`,
      `Errors: ${JSON.stringify(this.#pageErrors)}`,
      `In flight: ${JSON.stringify(this.#inFlight())}`,
      `Failed requests: ${JSON.stringify(this.#networkFailures)}`,
      await this.#busyReport(),
    ].join('\n');
  }

  async #enableHangProbes(): Promise<void> {
    if (HANG_STACK) await this.send('Debugger.enable', {});
  }

  /**
   * What holds a page whose main thread left a call unanswered, asked of what
   * still answers. `Performance.getMetrics` is dispatched as a V8 interrupt, so
   * it answers while JavaScript runs and waits like any call while the thread
   * is in a layout, a synchronous IPC or a native wait (Edge 155, a busy loop
   * against a synchronous XHR). The browser endpoint gives each process's CPU.
   * The probes run side by side: about a second, up to 5 s when the browser
   * endpoint answers slowly (its fetch, upgrade and two calls have 1 s each).
   */
  async #busyReport(): Promise<string> {
    const asked = Date.now();
    const [again, inScript, cpu] = await Promise.all([
      this.send('Runtime.evaluate', { expression: '1' }, 1_000).then(() => Date.now() - asked, () => null),
      this.send('Performance.getMetrics', {}, 1_000).then(() => Date.now() - asked, () => null),
      this.#processCpu(),
    ]);
    const lines = [
      again !== null
        ? `Main thread: answered again ${again} ms later`
        : inScript === null
          ? 'Main thread: not in JavaScript: Performance.getMetrics, a V8 interrupt, got no answer in 1 s either (a layout, a synchronous IPC or a native wait)'
          : `Main thread: running JavaScript: Performance.getMetrics, a V8 interrupt, answered in ${inScript} ms`,
      `CPU over 1 s: ${cpu}`,
    ];
    if (HANG_STACK && again === null) lines.push(`Stack: ${await this.#pausedStack()}`);
    return lines.join('\n');
  }

  /** Where the running script is, through the debugger `HANG_STACK` turned on at launch. */
  async #pausedStack(): Promise<string> {
    const paused = new Promise<string>((resolve) => { this.#paused = resolve; });
    try {
      await this.send('Debugger.pause', {}, 1_000);
      return await Promise.race([paused, Bun.sleep(1_000).then(() => 'no pause within 1 s')]);
    } catch (error) {
      return `Debugger.pause failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#paused = null;
      await this.send('Debugger.resume', {}, 1_000).catch(() => undefined);
    }
  }

  /** CPU seconds per second of each process of the browser, over one second. */
  async #processCpu(): Promise<string> {
    if (this.#debugPort === null) return 'no browser endpoint';
    let socket: TextSocket | undefined;
    try {
      const version = await (await fetch(`http://127.0.0.1:${this.#debugPort}/json/version`, { signal: AbortSignal.timeout(1_000) })).json() as { webSocketDebuggerUrl?: string };
      if (version.webSocketDebuggerUrl === undefined) return 'the browser endpoint has no socket';
      const browser = socket = await TextSocket.connect(version.webSocketDebuggerUrl, 1_000);
      const replies = new Map<number, (processes: ProcessInfo[]) => void>();
      browser.onMessage((text) => {
        const message = JSON.parse(text) as { id?: number; result?: { processInfo?: ProcessInfo[] } };
        if (message.id !== undefined) replies.get(message.id)?.(message.result?.processInfo ?? []);
      });
      const processes = (id: number) => new Promise<ProcessInfo[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SystemInfo.getProcessInfo timed out')), 1_000);
        replies.set(id, (found) => { clearTimeout(timer); resolve(found); });
        browser.send(JSON.stringify({ id, method: 'SystemInfo.getProcessInfo', params: {} }));
      });
      const before = await processes(1);
      const started = performance.now();
      await Bun.sleep(1_000);
      const after = await processes(2);
      const seconds = (performance.now() - started) / 1_000;
      const used = after.map((process) => ({ process, rate: (process.cpuTime - (before.find((candidate) => candidate.id === process.id)?.cpuTime ?? 0)) / seconds }));
      const busy = used.filter(({ rate }) => rate >= 0.05).map(({ process, rate }) => `${process.type} ${process.id} ${rate.toFixed(2)}`);
      return `${busy.join(', ') || 'no process'} at 0.05 s/s or more, ${used.length - busy.length} below`;
    } catch (error) {
      return `could not read it: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      socket?.close();
    }
  }

  /** What a stalled page is still waiting on: whether the server never answered or the body never arrived. */
  #inFlight(): string[] {
    const now = Date.now();
    return [...this.#requests.values()].filter((request) => now - (request.wall ?? request.at) > 1_000).slice(0, 10).map((request) => {
      const sentAt = request.wall ?? request.at;
      const wire = request.cache ? 'served from the cache'
        : request.headers !== undefined ? `the network service had its headers by ${request.headers - sentAt} ms after it was sent`
          : request.sent !== undefined ? 'the network service sent it and has no headers'
            : 'nothing from the network service (not sent, or a service worker holds it)';
      const server = uiServerSide(request.url, request.wall ?? null, request.at);
      return `${request.url} ${request.answered ? 'answered, body pending' : 'no response'} for ${now - sentAt} ms: ${wire}${server === null ? '' : `; ${server}`}`;
    });
  }

  /** Fails what waits and what comes next with the message devtools sent, then hangs up. */
  #protocolFault(raw: string): void {
    if (this.#fault !== null) return;
    this.#fault = `devtools sent a message that is not JSON (${raw.length} chars: ${JSON.stringify(raw.slice(0, 120))}): the socket lost its frames, so replies and network events may be missing`;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.#fault));
    }
    this.#pending.clear();
    this.#socket.close(1002);
  }

  #receive(raw: string): void {
    if (raw === '') return;
    let frame: {
      id?: unknown;
      method?: string;
      params?: {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
        requestId?: string; frameId?: string; loaderId?: string; wallTime?: number; request?: { url?: string }; response?: { status?: number }; errorText?: string;
        frame?: { id: string; loaderId: string; url?: string; parentId?: string };
        url?: string; reason?: string; type?: string; canceled?: boolean; blockedReason?: string; name?: string; payload?: string;
        callFrames?: { functionName: string; url: string; location: { lineNumber: number; columnNumber: number } }[];
      };
      result?: unknown;
      error?: { message?: string };
    };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      // Bun's WebSocket client did this on the E2E runner: misaligned, it handed
      // over pieces of frames, and dropping them silently lost the replies and
      // network events inside. Each call then timed out, its probe too, and the
      // page read as "main thread busy" with its lazy chunks "no response".
      this.#protocolFault(raw);
      return;
    }
    if (typeof frame.id !== 'number') {
      if (frame.method === 'Runtime.bindingCalled' && frame.params?.name === HISTORY_BINDING) {
        this.#navigated(String(frame.params.payload));
        return;
      }
      if (frame.method === 'Runtime.exceptionThrown') {
        const detail = frame.params?.exceptionDetails;
        this.#pageErrors.push(detail?.exception?.description ?? detail?.text ?? 'unknown page exception');
        if (this.#pageErrors.length > 10) this.#pageErrors.shift();
      }
      if (frame.method === 'Debugger.paused') {
        const frames = (frame.params?.callFrames ?? []).slice(0, 8)
          .map((call) => `${call.functionName || '(anonymous)'} ${call.url}:${call.location.lineNumber + 1}:${call.location.columnNumber + 1}`).join(' < ');
        // A pause nobody asked for, a `debugger` statement, must not freeze the page.
        if (this.#paused !== null) this.#paused(frames || 'paused outside any script');
        else void this.send('Debugger.resume', {}).catch(() => undefined);
        return;
      }
      if (frame.method?.startsWith('Page.frame') && (frame.params?.frameId ?? frame.params?.frame?.id) === this.#target.id) {
        const params = frame.params!;
        const detail = frame.method === 'Page.frameNavigated' ? ` ${params.frame!.url} loader ${params.frame!.loaderId}`
          : frame.method === 'Page.frameRequestedNavigation' ? ` ${params.url} (${params.reason})`
            : frame.method === 'Page.frameStartedNavigating' ? ` ${params.url} loader ${params.loaderId}` : '';
        this.#navigated(`${frame.method}${detail}`);
      }
      if (frame.method === 'Page.frameNavigated') {
        // Chrome sends nothing more about the requests of a document a
        // navigation replaced: they would read as unanswered forever.
        const navigated = frame.params?.frame;
        if (navigated !== undefined) {
          for (const [key, request] of this.#requests) if (request.frameId === navigated.id && request.loaderId !== navigated.loaderId) this.#requests.delete(key);
        }
        return;
      }
      const id = frame.params?.requestId;
      if (id !== undefined) {
        const url = frame.params?.request?.url ?? '';
        if (frame.method === 'Network.requestWillBeSent' && frame.params?.type === 'Document' && frame.params.frameId === this.#target.id) {
          this.#documents.add(id);
          this.#navigated(`document request ${url.split(/[?#]/, 1)[0]} loader ${frame.params.loaderId}`);
        } else if (this.#documents.has(id) && frame.method === 'Network.responseReceived') {
          this.#navigated(`document response HTTP ${frame.params?.response?.status}`);
        } else if (this.#documents.has(id) && (frame.method === 'Network.loadingFinished' || frame.method === 'Network.loadingFailed')) {
          this.#documents.delete(id);
          const params = frame.params!;
          this.#navigated(frame.method === 'Network.loadingFinished' ? 'document loaded'
            : `document failed: ${params.errorText ?? 'no error text'}${params.canceled ? ', canceled' : ''}${params.blockedReason ? `, blocked (${params.blockedReason})` : ''}`);
        }
        if (frame.method === 'Network.requestWillBeSent' && !url.startsWith('data:')) {
          const early = this.#early.get(id);
          this.#early.delete(id);
          const wallTime = frame.params?.wallTime;
          this.#requests.set(id, { url, at: Date.now(), wall: typeof wallTime === 'number' ? wallTime * 1_000 : undefined, answered: false, frameId: frame.params?.frameId, loaderId: frame.params?.loaderId, ...early });
        } else if (frame.method === 'Network.requestWillBeSentExtraInfo' || frame.method === 'Network.responseReceivedExtraInfo') {
          // The browser process sends these, and not always after Blink's own event.
          const step = frame.method === 'Network.requestWillBeSentExtraInfo' ? 'sent' : 'headers';
          const request = this.#requests.get(id);
          if (request !== undefined) request[step] ??= Date.now();
          else {
            if (this.#early.size > 500) this.#early.clear();
            this.#early.set(id, { ...this.#early.get(id), [step]: Date.now() });
          }
        } else if (frame.method === 'Network.requestServedFromCache') {
          const request = this.#requests.get(id);
          if (request !== undefined) request.cache = true;
        } else if (frame.method === 'Network.responseReceived') {
          const request = this.#requests.get(id);
          if (request) request.answered = true;
          if ((frame.params?.response?.status ?? 0) >= 400) this.#recordNetworkFailure(id, `HTTP ${frame.params?.response?.status}`);
        } else if (frame.method === 'Network.loadingFinished' || frame.method === 'Network.loadingFailed') {
          if (frame.method === 'Network.loadingFailed') this.#recordNetworkFailure(id, frame.params?.errorText ?? 'loading failed');
          this.#requests.delete(id);
        }
      }
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) pending.reject(new Error(frame.error.message ?? 'devtools error'));
    else pending.resolve(frame.result);
  }

  #navigated(line: string): void {
    // Pairing and ticket query strings belong to the test, never to its failure log.
    this.#navigations.push(`+${Date.now() - this.#opened} ms ${line.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, '$1')}`);
    if (this.#navigations.length > NAVIGATION_EVENTS) this.#navigations.shift();
  }

  #recordNetworkFailure(id: string, reason: string): void {
    const request = this.#requests.get(id);
    if (!request) return;
    // Pairing and ticket query strings belong to the test, never to its failure log.
    this.#networkFailures.push(`${request.url.split(/[?#]/, 1)[0]} ${reason}`);
    if (this.#networkFailures.length > 10) this.#networkFailures.shift();
  }
}

async function waitForPageTarget(port: number, urlIncludes = '', proc?: Subprocess, allowBlank = false, collectLate?: (deadline: number) => void): Promise<TargetInfo> {
  const started = Date.now();
  const deadline = started + CONNECT_TIMEOUT_MS;
  let last = 'the debugging port never answered';
  // Every distinct answer and when it came: the last one alone cannot say
  // whether the port never opened, opened late or listed a page that never
  // left about:blank.
  const answers = new Map<string, { count: number; first: number; last: number }>();
  for (;;) {
    if (proc && proc.exitCode !== null) throw new Error(`the browser exited before opening CDP with code ${proc.exitCode}`);
    const elapsed = Date.now() - started;
    if (elapsed >= CONNECT_TIMEOUT_MS - PROBE_TIMEOUT_MS && elapsed < CONNECT_TIMEOUT_MS) collectLate?.(deadline);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const targets = (await response.json()) as TargetInfo[];
      const page = targets.find(
        (target) => target.type === 'page' && target.url.includes(urlIncludes)
          // A launched browser navigates its blank page itself. An attached
          // shell must expose a committed page before scripts or reloads run.
          && (allowBlank || urlIncludes !== '' || (target.url !== '' && !target.url.startsWith('about:blank')))
          && typeof target.webSocketDebuggerUrl === 'string',
      );
      if (page !== undefined) return page;
      last = `no matching page target among ${targets.length}: ${JSON.stringify(targets.slice(0, 8).map(target => ({ type: target.type, url: target.url.slice(0, 200) })))}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const at = Date.now() - started;
    const seen = answers.get(last);
    if (seen !== undefined) { seen.count += 1; seen.last = at; }
    else if (answers.size < MAX_POLL_ANSWERS) answers.set(last, { count: 1, first: at, last: at });
    if (Date.now() > deadline) {
      const history = [...answers].map(([answer, { count, first, last: end }]) =>
        `${count}x ${(first / 1000).toFixed(1)}-${(end / 1000).toFixed(1)} s: ${answer}`).join('\n  ');
      // A launched browser is retried at once; only an attach, whose browser
      // nobody here can restart, spends the probe.
      const now = proc === undefined ? `\nPort ${port} now: ${await probeDebuggingPort(port)}` : '';
      throw new Error(`the browser never exposed a page: ${last}\nPolls of port ${port}:\n  ${history}${now}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

/** A launcher's diagnosis, bounded so that it never hides the failure it explains. */
async function diagnosis(diagnose: () => string | Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`the diagnosis gave nothing within ${DIAGNOSIS_TIMEOUT_MS} ms`), DIAGNOSIS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(diagnose), late]);
  } catch (failure) {
    return `the diagnosis failed: ${failure instanceof Error ? failure.message : String(failure)}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the debugging port does once the wait gave up. A poll that timed out
 * after 1 s cannot tell a port nothing answers on from a browser that accepts
 * the connection and never replies, as one whose UI thread is stuck would:
 * the probe connects first, then gives `/json/list` longer to answer.
 */
export async function probeDebuggingPort(port: number): Promise<string> {
  const tcp = await new Promise<string>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => done(`no TCP answer within ${PROBE_TIMEOUT_MS} ms`), PROBE_TIMEOUT_MS);
    function done(text: string) {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
      resolve(text);
    }
    socket.once('connect', () => done('accepts TCP'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(`TCP ${error.code ?? error.message}`));
  });
  if (tcp !== 'accepts TCP') return tcp;
  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const text = await response.text();
    return `accepts TCP; /json/list answered HTTP ${response.status} in ${Date.now() - startedAt} ms: ${text.replace(/\s+/g, ' ').slice(0, 600)}`;
  } catch (error) {
    return `accepts TCP; /json/list gave nothing in ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Bun's own WebSocket client closes sound devtools streams with 1002: see `packages/core/src/ws-client.ts`. */
async function openSocket(target: TargetInfo): Promise<TextSocket> {
  const url = target.webSocketDebuggerUrl;
  if (url === undefined) throw new Error('the page target has no debugger url');
  try {
    return await TextSocket.connect(url, CONNECT_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`the devtools socket did not open: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
