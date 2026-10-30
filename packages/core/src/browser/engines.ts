// Starts Chromium engines and owns their cookie saves, idle timers and shutdown.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVATE_BROWSER_PROFILE } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { findChromium, profileIdentity, readSavedCookies } from './chromium.ts';
import { restoreMissingCookies, saveCookies } from './saved-cookies.ts';
import { BrowserIdentities, startChromium, type Started } from './launch.ts';
import type { BrowserHost } from './host.ts';
import type { Engine } from './types.ts';

/** The first start of a profile can take longer while Chromium creates it. */
const START_TIMEOUT_MS = 60_000;
/** A process with no tab left closes after this long, or immediately for private tabs. */
const IDLE_CLOSE_MS = 60_000;
/** Save after navigation and periodically while the profile has tabs. */
const COOKIE_SAVE_DELAY_MS = 1000, COOKIE_SAVE_EVERY_MS = 30_000;

export class BrowserEngines {
  readonly pending = new Map<string, Promise<Engine>>();
  readonly #identities = new BrowserIdentities(
    (path, dir) => this.start(path, dir), () => this.profileDir(PRIVATE_BROWSER_PROFILE), dir => this.removeDir(dir), message => this.core.log('warn', message));

  constructor(
    private core: Core,
    private host: BrowserHost,
    private findBrowser: typeof findChromium,
    private machine: string,
    private scope: string,
    private targets: (engine: Engine) => void,
    private drop: (id: string) => void,
    /** The download quarantine folder, made on first use (`browser/downloads.ts`), and what to tell it when a browser ends. */
    private downloads: { prepare(): string; lost(engine: Engine): void },
  ) {}

  holdsIdentityDir(dir: string): boolean { return this.#identities.holds(dir); }

  profileDir(profile: string): string {
    return profile === PRIVATE_BROWSER_PROFILE
      ? join(this.core.dataDir, 'browser', `private-${crypto.randomUUID()}`)
      : join(this.core.dataDir, 'browser', profile);
  }

  /**
   * A profile keeps one engine, including while its User-Agent or the attached
   * host changes. One that is closing or lost keeps the profile until its
   * process exited: a browser started sooner would find the old one's lock.
   */
  get(profile: string): Promise<Engine> {
    const current = this.pending.get(profile) ?? this.pending.get(`host:${profile}`);
    if (current) return current.then(engine => this.#closing.has(engine) || this.#ended.has(engine) ? engine.exited.then(() => this.get(profile)) : engine);
    // A webview has no per-profile process flags. Custom identities use Chromium
    // so its workers and popups inherit the same User-Agent as its pages.
    const hosted = this.host.attached && !this.#userAgent(profile);
    const key = hosted ? `host:${profile}` : profile;
    let engine = this.pending.get(key);
    if (!engine) {
      engine = this.launch(profile, true, hosted);
      this.pending.set(key, engine);
      engine.then(started => {
        void started.exited.then(() => {
          this.lost(started);
          if (this.pending.get(key) === engine) this.pending.delete(key);
        });
        started.cdp.closed.then(() => this.lost(started));
      }, () => { if (this.pending.get(key) === engine) this.pending.delete(key); });
    }
    return engine;
  }

  #userAgent(profile: string) {
    return this.core.settings.get().browserProfiles?.find(one => one.id === profile)?.userAgent;
  }

  async #launchHosted(profile: string): Promise<Engine> {
    const cdp = this.host.connect(profile);
    try { await cdp.send('Browser.getVersion', {}, undefined, START_TIMEOUT_MS); }
    catch (error) { cdp.close(); throw refused(`the desktop app could not open the agent browser: ${error instanceof Error ? error.message : String(error)}`); }
    // The webviews keep the app's own cookies; the core still keeps a copy, so a
    // sign-in follows the profile whether the app hosts or a browser it starts does.
    const dir = profile === PRIVATE_BROWSER_PROFILE ? '' : this.profileDir(profile);
    const engine: Engine = { key: `host:${profile}`, profile, hosted: true, dir, cdp, kill: () => cdp.close(), exited: cdp.closed, tabs: new Set(), throwaway: false, identity: null };
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await restoreMissingCookies(engine, message => this.core.log('warn', message));
      engine.saveEvery = setInterval(() => { if (engine.tabs.size) void this.saveCookies(engine); }, COOKIE_SAVE_EVERY_MS);
    }
    this.targets(engine);
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    return engine;
  }

  /** Starts a browser process on `dir`. A test seam. */
  start(path: string, dir: string, userAgent?: string): Promise<Started> {
    return startChromium((cmd, args, options) => this.core.procs.spawn(this.scope, cmd, args, options), path, dir, START_TIMEOUT_MS, userAgent);
  }

  /** `identify` false starts the browser as it is: a page check (`probe`) visits no site, and its start and end are debug. `hosted` opens it in the desktop app. */
  async launch(profile: string, identify = true, hosted = false): Promise<Engine> {
    const at = performance.now();
    try {
      const found = hosted ? null : this.findBrowser();
      const engine = await (found === null ? this.#launchHosted(profile) : this.#launchLocal(profile, identify, found));
      if (!identify) this.#probing.add(engine);
      this.core.logs.record(identify ? 'info' : 'debug', `Agent browser started for profile ${profile} in ${Math.round(performance.now() - at)} ms`, { source: 'browser', event: 'browser.started', durationMs: performance.now() - at, data: { profile, hosted, program: found === null ? 'desktop app' : found.path?.split(/[\\/]/).pop() ?? null } });
      return engine;
    } catch (error) {
      this.core.logs.record(identify ? 'warn' : 'debug', `Agent browser for profile ${profile} did not start after ${Math.round(performance.now() - at)} ms: ${error instanceof Error ? error.message : String(error)}`, { source: 'browser', event: 'browser.start-failed', durationMs: performance.now() - at, data: { profile, hosted } });
      throw error;
    }
  }

  async #launchLocal(profile: string, identify: boolean, found: ReturnType<typeof findChromium>): Promise<Engine> {
    if (found.path === null) throw refused(`the agent browser cannot start on ${this.machine}: ${found.reason}`);
    const native = identify ? await this.#identities.of(found.path) : null;
    const setting = identify ? this.#userAgent(profile) : undefined;
    if (setting && !native) throw refused(`the User-Agent of browser profile ${profile} cannot be set because Chromium's identity could not be read`);
    const identity = native ? profileIdentity(native, setting) : null;
    const dir = this.profileDir(profile);
    let started: Started;
    try { started = await this.start(found.path, dir, identity?.userAgent); }
    catch (error) {
      if (profile === PRIVATE_BROWSER_PROFILE) this.removeDir(dir);
      throw refused(`the agent browser could not start on ${this.machine}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { cdp, kill } = started;
    try {
      // The cookies this profile held when its browser last closed, session cookies included.
      const saved = profile === PRIVATE_BROWSER_PROFILE ? [] : readSavedCookies(dir);
      if (saved.length) await cdp.send('Storage.setCookies', { cookies: saved }).catch(error => this.core.log('warn', `the saved cookies of browser profile ${profile} were refused: ${error instanceof Error ? error.message : String(error)}`));
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      // Downloads go to the quarantine under their guid, never under a name the page chose.
      // A browser that cannot report them refuses them, as before downloads were kept.
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloads.prepare(), eventsEnabled: true })
        .catch(() => cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {}));
      const engine: Engine = { key: profile, profile, hosted: false, dir, cdp, kill, exited: started.exited, tabs: new Set(), throwaway: profile === PRIVATE_BROWSER_PROFILE, identity };
      this.targets(engine);
      if (!engine.throwaway) engine.saveEvery = setInterval(() => { if (engine.tabs.size) void this.saveCookies(engine); }, COOKIE_SAVE_EVERY_MS);
      return engine;
    } catch (error) {
      // The profile stays this start's until the browser exited: `get` keeps it taken while this rejects.
      cdp.close();
      await kill();
      if (profile === PRIVATE_BROWSER_PROFILE) this.removeDir(dir);
      throw refused(`the agent browser could not start on ${this.machine}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Engines whose end is already in the log (the exit, the closed socket and a shutdown all call `lost`), those the core is closing, and page checks. */
  readonly #ended = new WeakSet<Engine>(); readonly #closing = new WeakSet<Engine>(); readonly #probing = new WeakSet<Engine>();
  /** The process ended or dropped its connection: its tabs are gone, its profile is free once the process exited. */
  lost(engine: Engine): void {
    if (!this.#ended.has(engine)) {
      this.#ended.add(engine);
      // Closed by the core, or with the desktop app hosting it, or with no tab: no crash.
      const expected = this.#closing.has(engine) || engine.hosted || engine.tabs.size === 0;
      this.core.logs.record(!expected ? 'warn' : this.#probing.has(engine) ? 'debug' : 'info', `Agent browser for profile ${engine.profile} ended${expected ? '' : ' on its own'} with ${engine.tabs.size} tabs open`, {
        source: 'browser', event: expected ? 'browser.ended' : 'browser.lost', data: { profile: engine.profile, tabs: engine.tabs.size, hosted: engine.hosted } });
    }
    this.#stopTimers(engine);
    this.downloads.lost(engine);
    for (const id of [...engine.tabs]) this.drop(id);
    engine.cdp.close(); engine.kill();
    if (engine.throwaway) void engine.exited.then(() => this.removeDir(engine.dir));
  }

  async shut(engine: Engine): Promise<void> {
    this.#closing.add(engine);
    this.#stopTimers(engine);
    await this.saveCookies(engine);
    // A clean close lets the browser write its own files; the kill is for one that does not end.
    await engine.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
    // The desktop app keeps its webviews: no process of its own to wait for.
    if (!engine.hosted) await Promise.race([engine.exited, Bun.sleep(5000)]);
    this.lost(engine);
  }

  /** `browser/saved-cookies.ts`. */
  saveCookies(engine: Engine): Promise<void> {
    return saveCookies(engine, message => this.core.log('warn', message));
  }

  saveCookiesSoon(engine: Engine): void {
    if (engine.throwaway) return;
    clearTimeout(engine.saveSoon);
    engine.saveSoon = setTimeout(() => void this.saveCookies(engine), COOKIE_SAVE_DELAY_MS);
  }

  #stopTimers(engine: Engine): void {
    clearTimeout(engine.idle); clearTimeout(engine.saveSoon); clearInterval(engine.saveEvery);
  }

  idle(engine: Engine): void {
    clearTimeout(engine.idle);
    if (engine.tabs.size) return;
    engine.idle = setTimeout(() => { if (!engine.tabs.size) void this.shut(engine); }, engine.throwaway ? 0 : IDLE_CLOSE_MS);
  }

  /** A folder that cannot go is logged, never thrown: these run detached and must not stop the core. */
  removeDir(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { this.core.log('warn', `could not remove the browser profile folder ${dir}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
