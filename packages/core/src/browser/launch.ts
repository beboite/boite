/*
 * Starts the agent's browser on a profile folder, and reads once per build of
 * an executable what that browser says it is with a window. Headless Chrome
 * names itself `HeadlessChrome` and sites turn it away as a robot; the agent
 * browser says what the same browser with a window says instead.
 */
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SpawnedProcess, SpawnOptions } from '../procs.ts';
import { Cdp } from './cdp.ts';
import { chromiumArgs, clearActivePort, IDENTITY_SCRIPT, pipesDevTools, waitForEndpoint, windowedUserAgent, type BrowserIdentity } from './chromium.ts';

/** A browser process the core started and speaks to. */
export interface Started { cdp: Cdp; kill(): void; exited: Promise<unknown> }

export type SpawnBrowser = (path: string, args: string[], options: SpawnOptions) => SpawnedProcess;

/** Reading what a browser says it is gives up after this long; the browser then starts as it is. */
const IDENTITY_TIMEOUT_MS = 20_000;

/**
 * Starts the browser at `path` on a profile folder and connects to it. A
 * browser that does not answer within `timeoutMs` is killed, and has ended or
 * had five seconds to, before the error is thrown: only then may its folder go.
 */
export async function startChromium(spawn: SpawnBrowser, path: string, dir: string, timeoutMs: number, userAgent?: string): Promise<Started> {
  mkdirSync(dir, { recursive: true });
  const piped = pipesDevTools();
  if (!piped) clearActivePort(dir);
  const spawned = spawn(path, chromiumArgs(dir, process.platform, userAgent), { agentRoot: false, ...(piped ? { extraPipes: 2 } : {}) });
  // Chromium writes to both pipes; nobody reads them, so they are drained.
  void spawned.proc.stdout.pipeTo(new WritableStream()).catch(() => {});
  void spawned.proc.stderr.pipeTo(new WritableStream()).catch(() => {});
  // Chromium's helpers exit with their parent; a clean close comes first.
  const kill = () => { try { spawned.proc.kill(); } catch { /* gone */ } };
  try {
    let cdp: Cdp;
    if (piped) {
      const [commands, replies] = spawned.fds ?? [];
      if (commands === undefined || replies === undefined) throw new Error('the browser was started without its DevTools pipes');
      cdp = Cdp.pipe(commands, replies);
    } else cdp = await Cdp.connect(await waitForEndpoint(dir, spawned.exited, timeoutMs));
    // The first answer says the browser is up; a browser that exits first never gives it.
    await Promise.race([
      cdp.send('Browser.getVersion', {}, undefined, timeoutMs),
      spawned.exited.then(() => { throw new Error('the browser exited while starting; another process may hold its profile folder'); }),
    ]);
    return { cdp, kill, exited: spawned.exited };
  } catch (error) {
    kill(); await Promise.race([spawned.exited, Bun.sleep(5000)]);
    throw error;
  }
}

/**
 * What each browser executable says it is with a window, by path and file
 * version. The first launch of a build reads it in a throwaway browser
 * started without `--user-agent`, since that flag empties the high-entropy
 * client hints; later launches reuse the answer. A browser whose answer
 * cannot be read gets null, and starts as it is, with a warning.
 */
export class BrowserIdentities {
  #known = new Map<string, Promise<BrowserIdentity | null>>();
  /** The throwaway folders being read, which a profile cleanup leaves alone. */
  readonly #reading = new Set<string>();

  constructor(
    private start: (path: string, dir: string) => Promise<Started>,
    private throwawayDir: () => string,
    private removeDir: (dir: string) => void,
    private warn: (message: string) => void,
  ) {}

  holds(dir: string): boolean { return this.#reading.has(dir); }

  of(path: string): Promise<BrowserIdentity | null> {
    let key = path;
    try { const real = realpathSync(path), file = statSync(real); key = `${real}\n${file.size}\n${file.mtimeMs}`; } catch { /* the start will say */ }
    let identity = this.#known.get(key);
    if (!identity) {
      identity = this.#read(path).catch(error => {
        this.warn(`the agent browser could not read what ${path} says it is with a window, so sites see headless Chrome: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      this.#known.set(key, identity);
    }
    return identity;
  }

  async #read(path: string): Promise<BrowserIdentity | null> {
    const dir = this.throwawayDir();
    this.#reading.add(dir);
    let started: Started | null = null;
    try {
      started = await this.start(path, dir);
      // Client hints exist only in a secure context: a `file:` page is one, `about:blank` is not.
      const page = join(dir, 'boite-identity.html');
      writeFileSync(page, '<!doctype html><title>identity</title>');
      const { targetId } = await started.cdp.send<{ targetId: string }>('Target.createTarget', { url: pathToFileURL(page).href });
      const { sessionId } = await started.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const deadline = Date.now() + IDENTITY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const { result } = await started.cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: IDENTITY_SCRIPT, awaitPromise: true, returnByValue: true }, sessionId, IDENTITY_TIMEOUT_MS);
        const value = result.value as BrowserIdentity | null | 'wait' | undefined;
        if (value === null || value === undefined) return null;
        if (value !== 'wait') return { userAgent: windowedUserAgent(value.userAgent), metadata: value.metadata };
        await Bun.sleep(50);
      }
      throw new Error(`its page did not load within ${IDENTITY_TIMEOUT_MS / 1000} seconds`);
    } finally {
      if (started) {
        await started.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
        await Promise.race([started.exited, Bun.sleep(5000)]);
        started.cdp.close(); started.kill();
        await Promise.race([started.exited, Bun.sleep(5000)]);
      }
      this.#reading.delete(dir);
      this.removeDir(dir);
    }
  }
}
