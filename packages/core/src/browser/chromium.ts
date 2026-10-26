/*
 * Finds a Chromium-based browser on this machine and starts it headless for
 * one profile folder. The core speaks the DevTools protocol to it; nothing of
 * it is shown on screen.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserUserAgent } from '@boite/contracts';

export interface ChromiumFound { path: string }
export interface ChromiumMissing { path: null; reason: string }

/** Chromium-based browsers by command name, the first found wins. */
const COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];

function windowsCandidates(env: Record<string, string | undefined>): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((root): root is string => !!root);
  return roots.flatMap(root => [
    join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(root, 'Chromium', 'Application', 'chrome.exe'),
    join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ]);
}

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

/**
 * `BOITE_BROWSER` names the executable when set, and is the only place looked
 * at then. Otherwise Chrome, Chromium, Edge or Brave, where each installs.
 */
export function findChromium(env: Record<string, string | undefined> = process.env, platform = process.platform, which: (name: string) => string | null = name => Bun.which(name)): ChromiumFound | ChromiumMissing {
  const wanted = env.BOITE_BROWSER?.trim();
  if (wanted) return existsSync(wanted) ? { path: wanted } : { path: null, reason: `BOITE_BROWSER names ${wanted}, which does not exist` };
  const candidates = platform === 'win32' ? windowsCandidates(env) : platform === 'darwin' ? MAC_CANDIDATES : [];
  for (const candidate of candidates) if (existsSync(candidate)) return { path: candidate };
  for (const name of COMMANDS) {
    const found = which(name);
    if (found) return { path: found };
  }
  return { path: null, reason: 'no Chromium-based browser (Chrome, Chromium, Edge or Brave) was found on this machine; install one or set BOITE_BROWSER to its executable' };
}

const DISK_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * What a profile made before `--disable-component-update` downloaded or
 * cached for the browser itself: components, provenance models and the two
 * caches. Never cookies, logins or `Local State`.
 */
const PROFILE_LEFTOVERS = [
  'component_crx_cache', 'ProvenanceData', 'ProvenanceDataAllowList', 'ProvenanceDataTensors',
  'Edge Wallet', 'Edge Entity Extraction', 'Edge Shopping', join('Default', 'Cache'), join('Default', 'Code Cache'),
];
const TRIMMED = 'boite-trimmed';

/**
 * Removes those folders from a profile once, before its browser starts. The
 * mark stays only when every one went, so a folder still held is tried again
 * at the next start.
 */
export function trimProfile(profileDir: string): void {
  const mark = join(profileDir, TRIMMED);
  if (existsSync(mark)) return;
  let complete = true;
  for (const name of PROFILE_LEFTOVERS) {
    try { rmSync(join(profileDir, name), { recursive: true, force: true }); } catch { complete = false; }
  }
  if (complete) writeFileSync(mark, '');
}

/**
 * Headless, muted, no first-run page, no sync or background downloads. The
 * window size is the page's viewport until a viewer or the agent sets one.
 * `--password-store=basic` and `--use-mock-keychain` keep Chromium from
 * asking the desktop's keyring for a password, which would open a dialog.
 *
 * Headless Chromium draws WebGL with SwiftShader, on the CPU, unless it is
 * told to use the GPU. It is told to, and software rendering is off: a page
 * that needs WebGL on a machine without a usable GPU gets none, rather than
 * every core of the machine. On Linux ANGLE goes through EGL, which a
 * headless process reaches without a display. `gpu` false, in a macOS
 * virtual machine, draws pages on the CPU and leaves WebGL off: see
 * `drawsWithGpu`.
 *
 * Sites turn away a browser that says it is automated, so it says what the
 * same browser says with a window. `userAgent` replaces the one that names
 * `HeadlessChrome`, in every request, page, worker and popup.
 * `AutomationControlled` off leaves `navigator.webdriver` false; `--test-type`
 * keeps Chrome from showing a bar about that flag, which took 56 pixels of the
 * page. The screen is 1920 × 1080 rather than headless Chrome's 800 × 600,
 * smaller than its own window.
 */
export function chromiumArgs(profileDir: string, platform = process.platform, userAgent?: string, gpu = true): string[] {
  return [
    gpu ? '--enable-gpu' : '--disable-gpu',
    '--disable-software-rasterizer',
    ...(platform === 'linux' ? ['--use-gl=angle', '--use-angle=gl-egl'] : []),
    // Every tab of the agent counts as shown: none is throttled for being in the background.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--headless=new',
    // The DevTools protocol runs over descriptors 3 and 4, never a port another process could reach.
    // Bun cannot open those descriptors on Windows: there it is a random loopback port.
    ...(pipesDevTools(platform) ? ['--remote-debugging-pipe'] : ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']),
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1280,800',
    '--disable-background-networking',
    // No component downloads (Edge fetched about 400 MB of them into a profile), and a 64 MiB HTTP cache.
    '--disable-component-update',
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-blink-features=AutomationControlled',
    // A window a page opens from a script the agent ran, not a click, becomes a tab as in the desktop app's webviews,
    // which have no popup blocker: the conversation's tab limit is the bound (`#adopt` in `browser.ts`).
    '--disable-popup-blocking',
    '--test-type',
    '--screen-info={1920x1080}',
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    'about:blank',
  ];
}

/**
 * False in a macOS virtual machine, a CI runner among them. Its GPU is the
 * hypervisor's paravirtual one, on which Chromium's GPU process loses its
 * Metal device and restarts. The process that exits then stays a zombie with
 * a thread in the kernel, opening the GPU's driver, and the browser's UI
 * thread waits for it to end: no DevTools command was answered for 10 to 30
 * seconds. On a macos-15 arm64 runner, 40 minutes of the browser tests gave
 * 48 GPU restarts in 1180 browsers and 20 silences past 3 seconds. Without
 * the GPU, 3177 browsers never took more than 1.6 seconds to answer. A Mac's
 * own hardware keeps the GPU.
 */
export async function drawsWithGpu(platform = process.platform): Promise<boolean> {
  return platform !== 'darwin' || !(await import('../platform/macos-vm.ts')).macVirtualMachine();
}

/**
 * What a browser says it is when it runs with a window: its user agent and
 * the client hints a page or a server can ask for, in the form
 * `Emulation.setUserAgentOverride` takes them.
 */
export interface BrowserIdentity { userAgent: string; metadata: Record<string, unknown> }

/** Empty preserves the native identity byte for byte; client hints still describe the real engine. */
export function profileIdentity(identity: BrowserIdentity, setting?: BrowserUserAgent): BrowserIdentity {
  if (!setting?.value.trim()) return identity;
  const value = setting.value.trim();
  return { ...identity, userAgent: setting.mode === 'suffix' ? `${identity.userAgent} ${value}` : value };
}

/**
 * Read in a page of the browser itself, without `--user-agent`: that flag
 * alone empties the high-entropy client hints (`fullVersionList`, the
 * platform's version). Client hints exist only in a secure context, which a
 * `file:` page is and `about:blank` is not. Null when the browser has none.
 */
export const IDENTITY_SCRIPT = `(async () => {
  if (location.protocol !== 'file:' || document.readyState === 'loading') return 'wait';
  const data = navigator.userAgentData;
  if (!data) return null;
  const high = await data.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'wow64']);
  const metadata = {};
  for (const key of ['brands', 'fullVersionList', 'platform', 'platformVersion', 'architecture', 'model', 'mobile', 'bitness', 'wow64', 'formFactors']) if (high[key] !== undefined) metadata[key] = high[key];
  return { userAgent: navigator.userAgent, metadata };
})()`;

/** The user agent of the same browser with a window: headless Chrome names itself `HeadlessChrome`. */
export function windowedUserAgent(userAgent: string): string {
  return userAgent.replace(/\bHeadlessChrome\//, 'Chrome/');
}

/** A profile's cookies as the core saved them, beside the browser's own files. */
const COOKIE_FILE = 'boite-cookies.json';

/**
 * What the profile's browser held when it last closed, in the form
 * `Storage.setCookies` takes. An unreadable file reads as none.
 */
export function readSavedCookies(profileDir: string): Record<string, unknown>[] {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(profileDir, COOKIE_FILE), 'utf8'));
    return Array.isArray(saved) ? saved.filter((cookie): cookie is Record<string, unknown> => !!cookie && typeof cookie === 'object') : [];
  } catch { return []; }
}

/**
 * Writes every cookie of a profile where only this account reads it, whole or
 * not at all. `cookies` are DevTools `Cookie` objects: the fields that only
 * describe them are dropped, and a session cookie keeps no expiry date.
 */
export function writeSavedCookies(profileDir: string, cookies: Record<string, unknown>[]): void {
  const kept = cookies.map(({ size: _size, session, expires, ...cookie }) => (session === true || typeof expires !== 'number' || expires <= 0 ? cookie : { ...cookie, expires }));
  const file = join(profileDir, COOKIE_FILE), partial = `${file}.part`;
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(partial, JSON.stringify(kept), { mode: 0o600 });
  renameSync(partial, file);
}

/** Whether the DevTools protocol goes over the browser's own pipes on this OS, rather than a loopback port. */
export function pipesDevTools(platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Where a fresh process writes its DevTools port: removed first, so a stale one is never read. */
export function clearActivePort(profileDir: string): void {
  rmSync(join(profileDir, 'DevToolsActivePort'), { force: true });
}

/** The browser endpoint once Chromium has written it: `ws://127.0.0.1:<port><path>`. */
export async function waitForEndpoint(profileDir: string, exited: Promise<unknown>, timeoutMs = 20_000): Promise<string> {
  const file = join(profileDir, 'DevToolsActivePort');
  let gone = false;
  void exited.then(() => { gone = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gone) throw new Error('the browser exited while starting; another process may hold its profile folder');
    try {
      const [port, path] = readFileSync(file, 'utf8').split(/\r?\n/);
      if (port && /^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) return `ws://127.0.0.1:${port}${path}`;
    } catch { /* not written yet */ }
    await Bun.sleep(50);
  }
  throw new Error(`the browser did not open its DevTools port within ${timeoutMs / 1000} seconds`);
}
