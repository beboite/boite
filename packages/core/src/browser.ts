import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { BrowserConfig, BrowserRequest, BrowserStatus, BrowserTask } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { newToken } from './ids.ts';
import { validateBrowserRequest } from './browser/loop.ts';

interface Job { task: BrowserTask; controller: AbortController; done: Promise<void> }
export class BrowserStore {
  private config: BrowserConfig = { enabled: false, executablePath: null };
  private readonly jobs = new Map<string, Job>();
  private closing = false;
  private readonly file: string;
  constructor(private readonly core: Core) {
    this.file = join(core.dataDir, 'browser.json');
    if (existsSync(this.file)) {
      let raw: unknown; try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { throw new Error(`${this.file}: expected valid JSON`); }
      this.config = this.readConfig(raw);
    }
  }
  private readConfig(raw: unknown): BrowserConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidParams('browser config must be an object');
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !['enabled', 'executablePath'].includes(key)) || typeof value.enabled !== 'boolean' || !(value.executablePath === null || typeof value.executablePath === 'string' && isAbsolute(value.executablePath))) throw invalidParams('browser config expects enabled: boolean and executablePath: an absolute path or null');
    return { enabled: value.enabled, executablePath: value.executablePath as string | null };
  }
  status(): BrowserStatus { return { config: { ...this.config }, keyAvailable: Boolean(process.env.TYPESAFE_API_KEY), tasks: [...this.jobs.values()].map(job => ({ ...job.task })).reverse() }; }
  async configure(raw: BrowserConfig): Promise<BrowserStatus> {
    const config = this.readConfig(raw);
    if (config.executablePath && (!existsSync(config.executablePath) || !statSync(config.executablePath).isFile())) throw invalidParams('executablePath must name an existing browser executable');
    writeFileSync(this.file, JSON.stringify(config, null, 2) + '\n');
    this.config = config;
    if (!config.enabled) await this.stopAll();
    return this.status();
  }
  busyPlugin(id: string): boolean { return [...this.jobs.values()].some(job => job.task.pluginId === id && job.task.finishedAt === null); }
  list(threadId: string): BrowserTask[] { this.core.threads.require(threadId); return this.status().tasks.filter(task => task.threadId === threadId); }
  private emit(task: BrowserTask): void { this.core.bus.emit('browser.updated', { ...task }); }

  start(raw: BrowserRequest): BrowserTask {
    const request = validateBrowserRequest(raw);
    if (this.closing) throw refused('Boite is shutting down.');
    if (!this.config.enabled) throw refused('Enable browser automation in Plugins first.');
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw refused('Set TYPESAFE_API_KEY in the core environment before starting a browser task.');
    if (this.core.threads.require(request.threadId).archived) throw refused('Unarchive the thread before starting a browser task.');
    const active = [...this.jobs.values()].filter(job => job.task.finishedAt === null);
    if (active.some(job => job.task.threadId === request.threadId)) throw refused('This thread already has a browser task.');
    if (active.length >= 2) throw refused('Two browser tasks are already running. Wait or cancel one.');
    const binary = this.core.plugins.browserBinary(request.pluginId);
    const task: BrowserTask = { id: newToken().slice(0, 20), threadId: request.threadId, pluginId: request.pluginId, goal: request.goal, status: 'running', step: 0, maxSteps: request.maxSteps, startedAt: Date.now(), finishedAt: null, url: request.url, message: 'Starting the browser', inputTokens: 0 };
    const job: Job = { task, controller: new AbortController(), done: Promise.resolve() };
    // Retain only the latest 100 tasks in memory. No form values or API key are persisted.
    for (const [id, old] of this.jobs) { if (this.jobs.size < 100) break; if (old.task.finishedAt !== null) this.jobs.delete(id); }
    this.jobs.set(task.id, job); this.emit(task);
    const executablePath = this.config.executablePath;
    job.done = (async () => {
      let daemon: import('./browser/daemon.ts').BrowserDaemon | undefined;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, request.timeoutMs);
      try {
        const [{ BrowserDaemon }, { runBrowserLoop, jevDecision }] = await Promise.all([import('./browser/daemon.ts'), import('./browser/loop.ts')]);
        job.controller.signal.throwIfAborted();
        daemon = await BrowserDaemon.launch(this.core, task.id, binary, executablePath, job.controller.signal);
        await daemon.command('navigate', { url: request.url, timeout: 30_000 });
        const outcome = await runBrowserLoop(request, daemon, jevDecision(key), job.controller.signal, update => { Object.assign(task, update); this.emit(task); });
        Object.assign(task, outcome);
      } catch {
        // Provider and browser errors may contain page or credential data. Keep
        // failure messages fixed and leave uncertain actions to the main agent.
        task.status = job.controller.signal.aborted ? timedOut ? 'needs-agent' : 'cancelled' : 'error';
        task.message = timedOut ? 'The task reached its time limit.' : job.controller.signal.aborted ? 'The task was cancelled.' : 'The browser or Jev request failed. No action was retried.';
      } finally {
        clearTimeout(timer);
        let cleanupFailed = false;
        try { await daemon?.close(); } catch { cleanupFailed = true; task.status = 'error'; task.message = 'Browser cleanup failed. Check the process trace.'; }
        // Cancellation during cleanup still wins over a late successful response.
        if (!cleanupFailed && job.controller.signal.aborted && !timedOut) { task.status = 'cancelled'; task.message = 'The task was cancelled.'; }
        task.finishedAt = Date.now(); this.emit(task);
      }
    })();
    return { ...task };
  }
  async cancel(threadId: string, id: string): Promise<BrowserTask> {
    const job = this.jobs.get(id);
    if (!job || job.task.threadId !== threadId) throw invalidParams('browser task id must belong to the named thread');
    if (job.task.finishedAt === null) { job.controller.abort(); await job.done; }
    return { ...job.task };
  }
  async stopThread(threadId: string): Promise<void> { const jobs = [...this.jobs.values()].filter(job => job.task.threadId === threadId); for (const job of jobs) if (job.task.finishedAt === null) job.controller.abort(); await Promise.all(jobs.map(job => job.done)); }
  private async stopAll(): Promise<void> { for (const job of this.jobs.values()) if (job.task.finishedAt === null) job.controller.abort(); await Promise.all([...this.jobs.values()].map(job => job.done)); }
  async close(): Promise<void> { this.closing = true; await this.stopAll(); }
}
