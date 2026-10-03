import { existsSync, mkdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Core } from './core.ts';
import type { SpawnedPipedProcess } from './procs.ts';
import { refused } from './errors.ts';
import { SPEECH_IDLE_MS } from './speech-server.ts';
import { speechThreads } from './speech-server.ts';

interface Running {
  id: string;
  key: string;
  child: SpawnedPipedProcess;
  ready: Promise<void>;
}
interface Pending { resolve(value: any): void; reject(error: Error): void }

/** One loaded Nemotron per core, isolated in a traced process with a private stdio protocol. */
export class SpeechNative {
  commandOverride: string[] | null = null;
  idleMs = SPEECH_IDLE_MS;
  private current: Running | null = null;
  private shutdown: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  constructor(private core: Core, private cwd: string) {}

  async ensure(runtime: string, model: string, signal?: AbortSignal): Promise<void> {
    await this.shutdown;
    signal?.throwIfAborted();
    const key = JSON.stringify([runtime, model]);
    if (this.current && this.current.key !== key) await this.stop();
    signal?.throwIfAborted();
    if (!this.current) {
      mkdirSync(this.cwd, { recursive: true });
      const entry = ['./main.ts', './main.js'].map(path => fileURLToPath(new URL(path, import.meta.url))).find(existsSync);
      const command = this.commandOverride ?? [process.execPath, ...(entry ? [entry] : []), '--speech-worker'];
      const id = `speech:${crypto.randomUUID()}`;
      const env = { ...process.env, LD_LIBRARY_PATH: [runtime, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter), DYLD_LIBRARY_PATH: [runtime, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(delimiter), PATH: [runtime, process.env.PATH].filter(Boolean).join(delimiter) };
      const child = this.core.procs.spawnPiped(id, command[0]!, command.slice(1), { cwd: this.cwd, env });
      const running: Running = { id, key, child, ready: Promise.resolve() };
      this.current = running;
      void this.read(running);
      // Drain diagnostic output without retaining or journaling audio, text or native configuration.
      void (async () => { for await (const _chunk of child.proc.stderr) {} })().catch(() => {});
      void child.exited.then(() => {
        if (this.current !== running) return;
        this.current = null;
        this.rejectAll(refused('speech: native engine stopped; try recording again'));
      });
      running.ready = this.request('init', { runtime, model, threads: Math.min(4, speechThreads()) }, AbortSignal.timeout(120_000)).then(() => {});
    }
    const running = this.current;
    try { await running.ready; this.touch(); }
    catch (error) { if (this.current === running) await this.stop(); throw error; }
  }

  async request(operation: string, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    signal.throwIfAborted();
    const running = this.current;
    if (!running) throw refused('speech: native engine is not loaded');
    clearTimeout(this.idle);
    const id = crypto.randomUUID();
    const abort = () => { if (this.current === running) void this.stop(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { running.child.proc.stdin.write(`${JSON.stringify({ id, operation, ...params })}\n`); }
        catch { this.pending.delete(id); reject(refused('speech: native engine disconnected')); }
      });
    } finally {
      signal.removeEventListener('abort', abort);
      this.touch();
    }
  }

  private async read(running: Running): Promise<void> {
    const decoder = new TextDecoder();
    let tail = '';
    try {
      for await (const chunk of running.child.proc.stdout) {
        if (this.current !== running) return;
        tail += decoder.decode(chunk, { stream: true });
        if (tail.length > 64 * 1024) throw new Error('oversized speech response');
        let end: number;
        while ((end = tail.indexOf('\n')) >= 0) {
          const response = JSON.parse(tail.slice(0, end)); tail = tail.slice(end + 1);
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          if (response.error) pending.reject(refused('speech: native decoder failed; reinstall the selected model and runtime'));
          else pending.resolve(response.result);
        }
      }
    } catch { if (this.current === running) await this.stop(); }
  }
  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private touch(): void {
    clearTimeout(this.idle);
    if (!this.current || this.pending.size) return;
    this.idle = setTimeout(() => { void this.stop(); }, this.idleMs);
    this.idle.unref?.();
  }
  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const running = this.current;
    this.current = null;
    if (running) {
      this.rejectAll(refused('speech: transcription cancelled'));
      this.core.procs.killTree(running.id);
      this.shutdown = running.child.exited;
    }
    await this.shutdown;
  }
}
