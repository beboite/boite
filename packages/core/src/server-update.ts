import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerUpdateStatus } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';
import { processPlatform } from './platform/index.ts';
import type { ServerInstallation, ServerUpdatePlatform, ServerUpdatePlan } from './server-update/types.ts';
import type { ServerOffer } from './server-update/release.ts';

export interface ServerUpdateOptions {
  platform?: ServerUpdatePlatform;
  findOffer?: (current: string, arch: string, signal: AbortSignal) => Promise<ServerOffer | null>;
  prepare?: (offer: ServerOffer, directory: string, signal: AbortSignal, progress: (received: number, total: number | null) => void) => Promise<string>;
  pollMs?: number;
}

/** One updater per core, shared by all its owner clients; a desktop update remains the shell's. */
export class ServerUpdates {
  readonly #core: Core;
  readonly #options: ServerUpdateOptions;

  #state: ServerUpdateStatus;
  #installation: ServerInstallation | null = null;
  #inspected = false;
  #inspection: Promise<void> | null = null;
  #workerLaunched = false;
  #offer: ServerOffer | null = null;
  #check: Promise<ServerUpdateStatus> | null = null;
  #abort: AbortController | null = null;
  #directory: string | null = null;
  #poll: ReturnType<typeof setTimeout> | null = null;
  #first: ReturnType<typeof setTimeout> | null = null;
  #interval: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(core: Core, options: ServerUpdateOptions = {}) {
    this.#core = core;
    this.#options = options;
    this.#state = { mode: existsSync('/.dockerenv') ? 'docker' : 'manual', phase: 'idle', currentVersion: core.version,
      version: null, channel: core.version.includes('-nightly.') ? 'nightly' : 'stable', publishedAt: null,
      checkedAt: null, received: 0, total: null, error: null };
    try {
      const result = JSON.parse(readFileSync(join(core.dataDir, 'server-update-result.json'), 'utf8')) as { error?: string };
      if (typeof result.error === 'string') this.#state = { ...this.#state, phase: 'error', error: result.error };
    } catch { /* No previous update. */ }
  }

  get #platform(): ServerUpdatePlatform | undefined { return this.#options.platform ?? processPlatform.serverUpdates; }
  snapshot(): ServerUpdateStatus { return { ...this.#state }; }
  #move(patch: Partial<ServerUpdateStatus>): ServerUpdateStatus {
    const was = this.#state.phase;
    this.#state = { ...this.#state, ...patch };
    // Each phase once, not each download tick; checking and current are the routine poll.
    if (this.#state.phase !== was && !['checking', 'current'].includes(this.#state.phase)) {
      // The version comes from the network and the error can hold a command's stderr: one line each, so neither forges a record.
      const line = (value: string, max: number): string => value.replace(/[\r\n\u2028\u2029]+/g, ' | ').replace(/[\p{C}]/gu, '').trim().slice(0, max);
      this.#core.logs.record(this.#state.phase === 'error' ? 'warn' : 'info', `Server update ${was} -> ${this.#state.phase}: ${this.#state.currentVersion} to ${this.#state.version ? line(this.#state.version, 80) : 'unknown'} (${this.#state.mode}, ${this.#state.channel})${this.#state.error ? `: ${line(this.#state.error, 500)}` : ''}`, {
        source: 'updates', event: `server-update.${this.#state.phase}`, data: { from: was, phase: this.#state.phase, mode: this.#state.mode, current: this.#state.currentVersion, version: this.#state.version, channel: this.#state.channel, totalBytes: this.#state.total, error: this.#state.error ?? null },
      });
    }
    this.#core.bus.emit('core.updateChanged', this.snapshot());
    return this.snapshot();
  }
  async #run(command: string, args: string[]): Promise<string> {
    const child = this.#core.procs.spawn('system:server-update', command, args, { agentRoot: false });
    const [out, error, code] = await Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${command}: ${error.trim() || `exit ${code}`}`);
    return out.trim();
  }
  async #inspect(): Promise<void> {
    if (this.#inspected) return;
    if (this.#inspection) return this.#inspection;
    this.#inspection = (async () => {
      this.#installation = await this.#platform?.inspect((cmd, args) => this.#run(cmd, args)) ?? null;
      this.#inspected = true;
      if (this.#installation) this.#move({ mode: 'systemd' });
    })().finally(() => { this.#inspection = null; });
    return this.#inspection;
  }

  async status(refresh = false): Promise<ServerUpdateStatus> {
    if (typeof refresh !== 'boolean') throw refused('core.updateStatus.refresh must be a boolean');
    this.#core.policy.assert(refresh && this.#core.policy.update('server') === 'off', 'updates.server', 'the release check');
    if (this.#check) return this.#check;
    await this.#inspect();
    if (this.#check) return this.#check;
    if (!refresh || !this.#installation || ['downloading', 'waiting', 'installing'].includes(this.#state.phase)) return this.snapshot();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#move({ phase: 'checking', error: null });
    this.#check = (async () => {
      try {
        const find = this.#options.findOffer ?? (await import('./server-update/release.ts')).findServerOffer;
        const offer = await find(this.#core.version, process.arch, signal);
        if (this.#closed) return this.snapshot();
        this.#offer = offer;
        return this.#move({ phase: offer ? 'available' : 'current', version: offer?.version ?? null,
          publishedAt: offer?.publishedAt ?? null, checkedAt: Date.now(), received: 0, total: null });
      } catch (error) {
        if (this.#closed) return this.snapshot();
        return this.#move({ phase: 'error', error: messageOf(error), checkedAt: Date.now() });
      } finally { this.#check = null; this.#abort = null; }
    })();
    return this.#check;
  }

  install(version: string): ServerUpdateStatus {
    this.#core.policy.assert(this.#core.policy.update('server') === 'off', 'updates.server');
    if (!this.#installation || !this.#offer || version !== this.#offer.version) throw refused('core.updateInstall.version must match the available server update');
    if (['downloading', 'waiting', 'installing'].includes(this.#state.phase)) return this.snapshot();
    if (this.#state.phase !== 'available' && this.#state.phase !== 'error') throw refused('Check for a server update before installing it');
    const abort = new AbortController();
    this.#abort = abort;
    const offer = this.#offer;
    this.#move({ phase: 'downloading', error: null, received: 0, total: null });
    void this.#prepare(offer, abort).catch(error => {
      if (this.#abort !== abort || this.#closed) return;
      this.#cancelFiles();
      this.#abort = null;
      this.#move({ phase: 'error', error: messageOf(error) });
    });
    return this.snapshot();
  }

  async #prepare(offer: ServerOffer, abort: AbortController): Promise<void> {
    const installation = this.#installation!;
    const { clearStaleUpdates, UPDATE_OWNER } = await import('./server-update/apply.ts');
    // A worker cut off with its recovery, by a power cut, left its files beside the installation.
    try { clearStaleUpdates(dirname(installation.directory), installation.directory); }
    catch (error) { this.#core.log('warn', `server update cleanup: ${messageOf(error)}`); }
    if (abort.signal.aborted || this.#closed) return;
    const id = randomUUID();
    const directory = join(dirname(installation.directory), `.boite-update-${id}`);
    this.#directory = directory;
    mkdirSync(directory, { mode: 0o700 });
    // Another installation's cleanup in the same folder leaves an operation that names someone else.
    writeFileSync(join(directory, UPDATE_OWNER), JSON.stringify({ installation: installation.directory }), { mode: 0o600 });
    const progress = (received: number, total: number | null) => {
      if (this.#abort === abort) this.#move({ received, total });
    };
    let archiveHash: string;
    if (this.#options.prepare) archiveHash = await this.#options.prepare(offer, directory, abort.signal, progress);
    else {
      const { downloadPayload, unpackPayload } = await import('./server-update/release.ts');
      const archive = join(directory, 'payload.zip');
      archiveHash = await downloadPayload(offer, archive, abort.signal, progress);
      if (abort.signal.aborted) return;
      await unpackPayload(archive, join(directory, 'stage'), offer.version, abort.signal);
    }
    if (abort.signal.aborted || this.#closed) return;
    const plan: ServerUpdatePlan = { id, installation, dataDir: this.#core.dataDir, version: offer.version,
      previousVersion: this.#core.version, originalPid: process.pid, healthUrl: `${this.#core.baseUrl()}/health`, archiveHash };
    const file = join(directory, 'plan.json');
    writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
    this.#workerLaunched = true;
    try { await this.#platform!.launch((cmd, args) => this.#run(cmd, args), installation.executable, file); }
    catch (error) { if (this.#abort === abort) this.#workerLaunched = false; throw error; }
    if (abort.signal.aborted || this.#closed) return;
    this.#move({ phase: 'waiting' });
    const readyDeadline = Date.now() + 15_000;
    const poll = () => {
      if (this.#closed || abort.signal.aborted) return;
      if (!existsSync(join(directory, 'ready'))) {
        if (Date.now() > readyDeadline) {
          this.#cancelFiles(); this.#abort = null;
          this.#move({ phase: 'error', error: 'The update worker did not start; the server was left running' });
          return;
        }
      } else {
        let admission: 'accepted' | 'busy' | 'unsupported';
        const admit = () => writeFileSync(join(directory, 'admitted'), id, { mode: 0o600 });
        try {
          // Idle installs at once; busy work ends its tool call, 30 s at most, and resumes
          // after the restart, as a desktop update does. Waiting for idle held a server
          // with an agent working for hours on "Waiting for work to finish" for good.
          admission = this.#core.requestIdleShutdown(admit);
          if (admission === 'busy') admission = this.#core.requestUpdateHandoff(admit);
        } catch (error) {
          this.#cancelFiles(); this.#abort = null; this.#poll = null;
          this.#move({ phase: 'error', error: messageOf(error) });
          return;
        }
        if (admission === 'unsupported') {
          this.#cancelFiles(); this.#abort = null;
          this.#move({ phase: 'error', error: 'This core does not support an idle restart' });
          return;
        }
        if (admission === 'accepted') {
          this.#move({ phase: 'installing' });
          this.#poll = null;
          return;
        }
      }
      this.#poll = setTimeout(poll, this.#options.pollMs ?? 1000);
      this.#poll.unref();
    };
    this.#poll = setTimeout(poll, 0);
    this.#poll.unref();
  }

  cancel(): ServerUpdateStatus {
    if (!['downloading', 'waiting'].includes(this.#state.phase)) return this.snapshot();
    this.#abort?.abort(new Error('Server update cancelled'));
    this.#abort = null;
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = null;
    this.#cancelFiles();
    return this.#move({ phase: 'available', received: 0, total: null, error: null });
  }
  #cancelFiles(): void {
    if (!this.#directory) return;
    try {
      if (existsSync(this.#directory)) {
        if (this.#workerLaunched) {
          try { writeFileSync(join(this.#directory, 'cancelled'), '', { mode: 0o600 }); }
          catch { rmSync(this.#directory, { recursive: true, force: true }); }
        } else rmSync(this.#directory, { recursive: true, force: true });
      }
    } catch (error) { this.#core.log('warn', `server update cleanup: ${messageOf(error)}`); }
    this.#directory = null;
    this.#workerLaunched = false;
  }
  start(): void {
    // The admin policy is asked at every tick: a file that turns checks off stops the next one.
    const tick = (): void => {
      if (this.#core.policy.update('server') === 'off') return;
      void this.status(true).catch(error => this.#core.log('warn', `server update check: ${messageOf(error)}`, { source: 'updates', event: 'server-update.check-failed' }));
    };
    this.#first = setTimeout(() => {
      tick();
      this.#interval = setInterval(tick, 6 * 60 * 60 * 1000);
      this.#interval.unref();
    }, 8000);
    this.#first.unref();
  }
  close(): void {
    this.#closed = true;
    if (this.#first) clearTimeout(this.#first);
    if (this.#interval) clearInterval(this.#interval);
    if (this.#poll) clearTimeout(this.#poll);
    if (this.#state.phase !== 'installing') { this.#abort?.abort(); this.#cancelFiles(); }
  }
}
