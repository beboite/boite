import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename } from 'node:path';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import type { SpawnedProcess } from './procs.ts';

/**
 * Half the logical processors, never fewer than whisper's own default of
 * min(4, n) and never more than 8. On an 11 s clip with Whisper Small the
 * encoder took 2.1 s on 4 threads and 1.27 s on 8 (2026-09-26, Ryzen 7 9800X3D).
 */
export function speechThreads(n = availableParallelism()): number {
  return Math.max(Math.min(4, n), Math.min(8, Math.floor(n / 2)));
}

/**
 * The encoder positions a provisional window needs: 50 per second of audio and
 * a margin, instead of the 1500 of a padded 30 s window. It decodes a 12 s preview
 * about twice as fast and a little less exactly, which a preview can afford.
 */
export function previewContext(audio: Uint8Array): number {
  const seconds = (audio.length - 44) / 32000;
  return Math.min(1500, Math.ceil(seconds * 50) + 64);
}

/** A dictation starts, previews run, the final request comes: the model stays loaded through the longest one. */
export const SPEECH_IDLE_MS = 150_000;

interface Running {
  id: string;
  key: string;
  base: string;
  child: SpawnedProcess;
  ready: Promise<void>;
  alive: boolean;
  loaded: boolean;
  /** The last line whisper-server wrote that names an error, never a transcript. */
  failure: string;
}

/**
 * whisper.cpp's `whisper-server`, started once and kept loaded between
 * requests, instead of a `whisper-cli` that loads the model for every one.
 * It listens on a loopback port under a random request path, since its CORS
 * header lets any page reach it and its `/load` swaps the model. It stops
 * after `idleMs` without a request or a warm.
 */
export class SpeechServer {
  idleMs = SPEECH_IDLE_MS;
  /** How long a model may take to load. A test seam. */
  readyMs = 120_000;
  private current: Running | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Inference requests still waiting for their answer. */
  private inflight = 0;

  constructor(private readonly core: Core, private readonly cwd: string) {}

  /** A server is up with its model loaded. */
  get running(): boolean { return this.current?.alive === true && this.current.loaded; }

  /**
   * Starts the server for this model unless it runs already, and resolves once
   * it answers. A warm and the request after it share the one that is loading.
   */
  async ensure(command: string[], model: string): Promise<string> {
    const key = JSON.stringify([command, model]);
    this.touch();
    if (this.current && (this.current.key !== key || !this.current.alive)) await this.stop();
    this.current ??= this.launch(command, model, key);
    const running = this.current;
    try {
      await running.ready;
    } catch (error) {
      if (this.current === running) this.current = null;
      throw error;
    }
    // The idle wait counts from the loaded model, not from the start of a load.
    this.touch();
    return running.base;
  }

  /** Keeps a loaded model for another `idleMs`. */
  touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      // A model still loading is bounded by `readyMs`, a request by its own
      // signal: each starts the wait again when it ends.
      if (this.inflight > 0 || (this.current?.alive && !this.current.loaded)) return;
      void this.stop();
    }, this.idleMs);
    if (typeof this.idle.unref === 'function') this.idle.unref();
  }

  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const running = this.current;
    this.current = null;
    if (!running) return;
    running.alive = false;
    this.core.procs.killTree(running.id);
    await running.child.exited;
  }

  async transcribe(command: string[], model: string, audio: Uint8Array, options: { language: string; audioCtx: number; signal: AbortSignal }): Promise<{ text: string; language?: string }> {
    const base = await this.ensure(command, model);
    options.signal.throwIfAborted();
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'dictation.wav');
    form.set('response_format', 'verbose_json');
    // The detected language is already in `language`; the probabilities would run the encoder once more.
    form.set('no_language_probabilities', 'true');
    form.set('no_timestamps', 'true');
    form.set('language', options.language);
    if (options.audioCtx > 0) form.set('audio_ctx', String(options.audioCtx));
    let response: Response;
    let body: unknown;
    this.inflight += 1;
    try {
      try {
        // Closing the connection is what makes whisper-server abort the decode.
        response = await fetch(`${base}/inference`, { method: 'POST', body: form, signal: options.signal });
      } catch (error) {
        options.signal.throwIfAborted();
        throw refused(`speech: whisper-server stopped answering${this.current ? '' : '; it will start again on the next dictation'} (${error instanceof Error ? error.message : String(error)})`);
      }
      try { body = await response.json(); } catch { body = null; }
    } finally {
      this.inflight -= 1;
      this.touch();
    }
    if (!response.ok) throw refused(`speech: whisper-server answered HTTP ${response.status}; check the model in Voice settings`);
    if (!body || typeof body !== 'object' || typeof (body as { text?: unknown }).text !== 'string') throw refused('speech: whisper-server returned an invalid transcript');
    const result = body as { text: string; language?: unknown };
    // One segment per line on the wire; a dictation reads as one run of text.
    const text = result.text.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
    return typeof result.language === 'string' && result.language ? { text, language: result.language } : { text };
  }

  private launch(command: string[], model: string, key: string): Running {
    const [program, ...prefix] = command;
    if (!program) throw refused('speech: no whisper-server to start');
    // Free when probed; another process taking it in the next milliseconds fails this start, and the next request picks another.
    const port = freeLoopbackPort();
    const path = `/${crypto.randomUUID().replaceAll('-', '')}`;
    const id = `speech:server-${crypto.randomUUID()}`;
    // A model path set by hand leaves no speech directory behind to start in.
    mkdirSync(this.cwd, { recursive: true });
    const child = this.core.procs.spawn(id, program, [
      ...prefix, '-m', model, '-t', String(speechThreads()), '-ng', '-nt',
      '--host', '127.0.0.1', '--port', String(port), '--request-path', path,
    ], { cwd: this.cwd });
    const running: Running = { id, key, base: `http://127.0.0.1:${port}${path}`, child, ready: Promise.resolve(), alive: true, loaded: false, failure: '' };
    // Both pipes are drained or the server blocks on a full one; only an error line is kept.
    void drain(child.proc.stdout, () => {});
    void drain(child.proc.stderr, line => { if (/error|failed|couldn't/i.test(line)) running.failure = line.trim().slice(0, 300); });
    const exited = child.exited.then(code => { running.alive = false; if (this.current === running) this.current = null; return code; });
    running.ready = this.waitReady(running, exited, model).then(() => { running.loaded = true; });
    return running;
  }

  private async waitReady(running: Running, exited: Promise<number>, model: string): Promise<void> {
    const deadline = Date.now() + this.readyMs;
    let stopped: number | null = null;
    void exited.then(code => { stopped = code; });
    for (;;) {
      if (stopped !== null || !running.alive) {
        await Bun.sleep(20); // the last stderr line lands after the exit
        throw refused(`speech: whisper-server could not load ${basename(model)}${running.failure ? ` (${running.failure})` : ''}; check the model in Voice settings`);
      }
      try {
        const response = await fetch(`${running.base}/health`, { signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* not listening yet: the model loads before the port opens */ }
      if (Date.now() > deadline) {
        this.core.procs.killTree(running.id);
        throw refused(`speech: whisper-server did not load ${basename(model)} within ${Math.round(this.readyMs / 1000)} s`);
      }
      await Bun.sleep(25);
    }
  }
}

function freeLoopbackPort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function drain(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > 4096) pending = pending.slice(-4096);
      for (const text of lines) line(text);
    }
  } catch { /* the process went away */ }
  if (pending) line(pending);
}
