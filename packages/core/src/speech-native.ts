import { existsSync, mkdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Core } from './core.ts';
import type { SpawnedPipedProcess } from './procs.ts';
import { refused } from './errors.ts';
import { SPEECH_IDLE_MS } from './speech-server.ts';
import { speechThreads } from './speech-server.ts';
import { EngineSlot } from './speech-engine.ts';

/** A loaded engine: `ensure` leases it, and a request names the one it was leased. */
export interface NativeEngine {
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
  private readonly slot = new EngineSlot<NativeEngine>(async (running) => {
    this.rejectAll(refused('speech: transcription cancelled'));
    await running.child.stop();
  });
  private pending = new Map<string, Pending>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  constructor(private core: Core, private cwd: string) {}

  async ensure(runtime: string, model: string, signal?: AbortSignal): Promise<NativeEngine> {
    signal?.throwIfAborted();
    const running = await this.slot.acquire(JSON.stringify([runtime, model]), () => this.launch(runtime, model));
    signal?.throwIfAborted();
    try { await running.ready; this.touch(); }
    catch (error) { await this.slot.stop(running); throw error; }
    return running;
  }

  /** A request to `engine`, refused once another engine replaced it. */
  async request(operation: string, params: Record<string, unknown>, signal: AbortSignal, engine = this.slot.current): Promise<any> {
    signal.throwIfAborted();
    if (!engine) throw refused('speech: native engine is not loaded');
    if (engine !== this.slot.current) throw refused('speech: the voice model changed; record again');
    return this.send(engine, operation, params, signal);
  }

  private launch(runtime: string, model: string): NativeEngine {
    mkdirSync(this.cwd, { recursive: true });
    const entry = ['./main.ts', './main.js'].map(path => fileURLToPath(new URL(path, import.meta.url))).find(existsSync);
    const command = this.commandOverride ?? [process.execPath, ...(entry ? [entry] : []), '--speech-worker'];
    const id = `speech:${crypto.randomUUID()}`;
    const env = { ...process.env, LD_LIBRARY_PATH: [runtime, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter), DYLD_LIBRARY_PATH: [runtime, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(delimiter), PATH: [runtime, process.env.PATH].filter(Boolean).join(delimiter) };
    const child = this.core.procs.spawnPiped(id, command[0]!, command.slice(1), { cwd: this.cwd, env });
    const running: NativeEngine = { id, key: JSON.stringify([runtime, model]), child, ready: Promise.resolve() };
    void this.read(running);
    // Drain diagnostic output without retaining or journaling audio, text or native configuration.
    void (async () => { for await (const _chunk of child.proc.stderr) {} })().catch(() => {});
    void child.exited.then(() => {
      if (this.slot.vacate(running)) this.rejectAll(refused('speech: native engine stopped; try recording again'));
    });
    running.ready = this.send(running, 'init', { runtime, model, threads: Math.min(4, speechThreads()) }, AbortSignal.timeout(120_000)).then(() => {});
    return running;
  }

  private async send(running: NativeEngine, operation: string, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    clearTimeout(this.idle);
    const id = crypto.randomUUID();
    const abort = () => { void this.slot.stop(running); };
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

  private async read(running: NativeEngine): Promise<void> {
    const decoder = new TextDecoder();
    let tail = '';
    try {
      for await (const chunk of running.child.proc.stdout) {
        if (this.slot.current !== running) return;
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
    } catch { await this.slot.stop(running); }
  }
  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private touch(): void {
    clearTimeout(this.idle);
    if (!this.slot.current || this.pending.size) return;
    const engine = this.slot.current;
    this.idle = setTimeout(() => { void this.slot.stop(engine); }, this.idleMs);
    this.idle.unref?.();
  }
  async stop(): Promise<void> {
    clearTimeout(this.idle);
    await this.slot.stop();
  }
}
