/*
 * Desktop-app plugins: an executable the core starts with no arguments and
 * keeps running, such as Bots. The app reaches the core like any client, with
 * the core's address and the owner token in its environment; the core starts
 * it, stops it and relaunches it when it crashes. docs/plugins.md describes
 * the contract an app answers.
 *
 * Whether the owner wants the app running is `enabled`, kept in `app.json`
 * beside `installed.json`. An update keeps that directory, so the choice
 * survives it; an uninstall deletes it, so a new install starts enabled.
 */

import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import type { PluginAppState } from '@boite/contracts';
import { messageOf } from '../errors.ts';
import type { SpawnedProcess } from '../procs.ts';

const APP_FILE = 'app.json';
/** The waits before each relaunch after a crash. One crash more within the window gives `crashed`. */
export const RELAUNCH_DELAYS_MS = [2_000, 10_000, 30_000] as const;
export const CRASH_WINDOW_MS = 5 * 60_000;

/** What the store hands the apps: the core's parts they use and the installed plugin they run. */
export interface AppHost {
  procs: { spawn(threadId: string, cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; showWindow: boolean }): SpawnedProcess; killTree(threadId: string): number };
  coreUrl(): string;
  ownerToken(): string;
  log(level: 'info' | 'warn', message: string): void;
  /** The binary and directory of an installed plugin providing a desktop app, or null. */
  installed(id: string): { binary: string; dir: string } | null;
  /** Announces the plugin's state after a change. */
  changed(id: string): void;
}

/** Timers the tests replace to walk through the backoff without waiting it out. */
export interface AppClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: AppClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Why this machine cannot show the app's window, or null when it can. */
export function desktopProblem(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'linux' || env['DISPLAY'] || env['WAYLAND_DISPLAY']) return null;
  return 'This core runs without a desktop (neither DISPLAY nor WAYLAND_DISPLAY is set), so it cannot open the app\'s window.';
}

/**
 * The app's environment: the core's own, minus every variable the agent door
 * sets, plus where the core answers and the owner token. `undefined` removes a
 * variable the core's environment carries, since the launcher merges onto it.
 */
export function appEnv(base: Record<string, string | undefined>, fields: { coreUrl: string; token: string; pluginId: string }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const agent = new Set<string>(Object.values(AGENT_ENV));
  for (const name of Object.keys(base)) if (agent.has(name.toUpperCase()) || name.toUpperCase().startsWith('BOITE_AGENT_')) env[name] = undefined;
  return { ...env, BOITE_CORE_URL: fields.coreUrl, BOITE_TOKEN: fields.token, BOITE_PLUGIN_ID: fields.pluginId };
}

/** The stream read to its end and thrown away: the app's output may carry secrets and must never fill a pipe. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try { while (!(await reader.read()).done) { /* dropped */ } } catch { /* the process went */ }
}

interface Running {
  threadId: string;
  pid: number;
  exited: Promise<number>;
}

interface Entry {
  status: PluginAppState['status'];
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  startedAt: number | null;
  running: Running | null;
  /** When each recent crash happened, within the crash window. */
  crashes: number[];
  relaunch: unknown;
}

export class PluginApps {
  clock: AppClock = realClock;
  /** Test seam: why the app cannot be shown here, or null. */
  desktop: () => string | null = () => desktopProblem();
  private entries = new Map<string, Entry>();
  private closing = false;

  constructor(private host: AppHost) {}

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { status: 'stopped', pid: null, exitCode: null, error: null, startedAt: null, running: null, crashes: [], relaunch: null };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Whether the owner wants the app running. A plugin directory with no `app.json` is a first install: yes. */
  enabled(dir: string): boolean {
    const file = join(dir, APP_FILE);
    if (!existsSync(file)) return true;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown };
      return data.enabled !== false;
    } catch {
      return true;
    }
  }

  private async setEnabled(dir: string, enabled: boolean): Promise<void> {
    const file = join(dir, APP_FILE);
    await writeFile(`${file}.part`, JSON.stringify({ enabled }), 'utf8');
    await rename(`${file}.part`, file);
  }

  state(id: string, dir: string): PluginAppState {
    const entry = this.entries.get(id);
    const problem = this.desktop();
    const enabled = this.enabled(dir);
    if (problem !== null && entry?.running == null) {
      return { enabled, status: 'unavailable', pid: null, exitCode: entry?.exitCode ?? null, error: problem, startedAt: null };
    }
    if (entry === undefined || entry.status === 'unavailable') return { enabled, status: 'stopped', pid: null, exitCode: entry?.exitCode ?? null, error: null, startedAt: null };
    return { enabled, status: entry.status, pid: entry.pid, exitCode: entry.exitCode, error: entry.error, startedAt: entry.startedAt };
  }

  /** Starts the app unless it runs already, the core is closing or this machine has no desktop. */
  launch(id: string): void {
    if (this.closing) return;
    const entry = this.entry(id);
    if (entry.running !== null) return;
    this.clock.clearTimeout(entry.relaunch);
    entry.relaunch = null;
    const installed = this.host.installed(id);
    if (installed === null) return;
    const problem = this.desktop();
    if (problem !== null) {
      entry.status = 'unavailable';
      entry.error = problem;
      this.host.changed(id);
      return;
    }
    const threadId = `plugin:${id}:app`;
    let spawned: SpawnedProcess;
    try {
      spawned = this.host.procs.spawn(threadId, installed.binary, [], {
        cwd: installed.dir,
        env: appEnv(process.env, { coreUrl: this.host.coreUrl(), token: this.host.ownerToken(), pluginId: id }),
        showWindow: true,
      });
    } catch (error) {
      entry.status = 'crashed';
      entry.error = `${id} could not start: ${messageOf(error)}`;
      this.host.log('warn', entry.error);
      this.host.changed(id);
      return;
    }
    void drain(spawned.proc.stdout);
    void drain(spawned.proc.stderr);
    const running: Running = { threadId, pid: spawned.record.pid, exited: spawned.exited };
    Object.assign(entry, { status: 'running', pid: running.pid, error: null, startedAt: this.clock.now(), running });
    void spawned.exited.then((code) => this.exited(id, running, code));
    this.host.changed(id);
  }

  private exited(id: string, running: Running, code: number): void {
    const entry = this.entries.get(id);
    // A stop already said what happened; a process from before it is not this one.
    if (entry === undefined || entry.running !== running) return;
    Object.assign(entry, { running: null, pid: null, exitCode: code });
    if (this.closing) return;
    if (code === 0) {
      // The user quit from the app: it stays closed until the next core start or an explicit start.
      Object.assign(entry, { status: 'stopped', error: null, crashes: [] });
      this.host.changed(id);
      return;
    }
    const now = this.clock.now();
    entry.crashes = [...entry.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const delay = RELAUNCH_DELAYS_MS[entry.crashes.length - 1];
    if (delay === undefined) {
      entry.status = 'crashed';
      entry.error = `${id} exited with code ${code} ${entry.crashes.length} times in ${CRASH_WINDOW_MS / 60_000} minutes; start it again from Settings > Plugins.`;
      this.host.log('warn', entry.error);
    } else {
      entry.status = 'starting';
      entry.error = `${id} exited with code ${code}; starting it again in ${delay / 1000} s.`;
      this.host.log('info', entry.error);
      entry.relaunch = this.clock.setTimeout(() => { entry.relaunch = null; this.launch(id); }, delay);
    }
    this.host.changed(id);
  }

  /** Kills the app and waits for it, leaving status `stopped`. */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.clock.clearTimeout(entry.relaunch);
    entry.relaunch = null;
    const running = entry.running;
    Object.assign(entry, { running: null, pid: null, status: 'stopped', error: null });
    if (running !== null) {
      this.host.procs.killTree(running.threadId);
      entry.exitCode = await running.exited;
    }
    this.host.changed(id);
  }

  /** `plugins.app`: start enables and launches, stop disables and kills, restart does both. */
  async control(id: string, dir: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (action === 'stop') {
      await this.setEnabled(dir, false);
      await this.kill(id);
      return;
    }
    await this.setEnabled(dir, true);
    if (action === 'restart') await this.kill(id);
    this.entry(id).crashes = [];
    this.launch(id);
  }

  /** At core start and after an install: launches the app if the owner left it enabled. */
  resume(id: string, dir: string): void {
    if (!this.enabled(dir)) return;
    this.entry(id).crashes = [];
    this.launch(id);
  }

  /** Before an update replaces the binary (Windows locks a running exe) or an uninstall deletes it. */
  async forget(id: string): Promise<void> {
    await this.kill(id);
    this.entries.delete(id);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.entries.keys()].map((id) => this.kill(id)));
  }
}
