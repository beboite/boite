/*
 * Finds a Chromium-based browser on this machine and starts it headless for
 * one profile folder. The core speaks the DevTools protocol to it; nothing of
 * it is shown on screen.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * headless process reaches without a display.
 */
export function chromiumArgs(profileDir: string, platform = process.platform): string[] {
  return [
    '--enable-gpu',
    '--disable-software-rasterizer',
    ...(platform === 'linux' ? ['--use-gl=angle', '--use-angle=gl-egl'] : []),
    // Every tab of the agent counts as shown: none is throttled for being in the background.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--headless=new',
    // The DevTools protocol runs over descriptors 3 and 4, never a port another process could reach.
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1280,800',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--password-store=basic',
    '--use-mock-keychain',
    'about:blank',
  ];
}

/**
 * Asks the profile to keep its session, as "Continue where you left off"
 * does: a sign-in whose cookie has no expiry date would otherwise be gone each
 * time the browser process closes, a minute after its last tab. Measured on
 * Chrome 153: without it a session cookie is lost at the restart, with it kept.
 * Called before the process starts; a profile whose preferences cannot be read
 * is left as it is.
 */
export function keepSession(profileDir: string): void {
  const file = join(profileDir, 'Default', 'Preferences');
  try {
    let preferences: Record<string, unknown> = {};
    if (existsSync(file)) preferences = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const session = (preferences.session && typeof preferences.session === 'object' ? preferences.session : {}) as Record<string, unknown>;
    if (session.restore_on_startup === 1) return;
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...preferences, session: { ...session, restore_on_startup: 1 } }));
  } catch { /* the browser starts with what it has */ }
}
