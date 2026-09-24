import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Core } from '../packages/core/src/core.ts';
import type { BrowserLabEngine } from './browser-lab-engine.ts';

class ScreencastCdp {
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onFrame: (params: any, sessionId: string) => void = () => {};
  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Page.screencastFrame') this.onFrame(message.params, message.sessionId);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Recording CDP: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Recording CDP connection timed out.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Recording CDP connection failed.')); }, { once: true });
    });
    return new ScreencastCdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Recording ${method} timed out.`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  private rejectPending() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Recording CDP disconnected.')); } this.pending.clear(); }
  close() { this.rejectPending(); this.socket.close(); }
}

export interface BrowserLabRecordingOptions {
  core: Core;
  output: string;
  ffmpegPath: string;
  fps?: number;
  width?: number;
  height?: number;
}

/** Continuous CDP screencast video. Repeats the last real frame while a page is
 * static, just as a screen recorder does. No action replay or synthetic cursor.
 * Wraps only this benchmark engine's command method to follow its selected tab.
 * Instrumented runs must be separate from timing runs.
 */
export class BrowserLabRecording {
  private cdp!: ScreencastCdp;
  private encoder!: ReturnType<Core['procs']['spawnPiped']>;
  private stderr!: Promise<string>;
  private stdout!: Promise<string>;
  private timer?: ReturnType<typeof setInterval>;
  private targetId?: string;
  private sessionId?: string;
  private latest?: Uint8Array;
  private frameCount = 0;
  private capturedFrames = 0;
  private started = 0;
  private pumping: Promise<void> | undefined;
  private stopped = false;
  private firstFrame?: () => void;
  private events: Array<Record<string, unknown>> = [];
  private errors: string[] = [];
  private originalCommand: BrowserLabEngine['command'];
  private wrappedCommand: BrowserLabEngine['command'];
  readonly path: string;
  readonly processGroup: string;
  private constructor(private engine: BrowserLabEngine, private options: BrowserLabRecordingOptions) {
    this.path = resolve(options.output);
    this.processGroup = `${engine.processGroup}:video`;
    this.originalCommand = engine.command;
    this.wrappedCommand = async (action, args = {}) => {
      this.mark(action);
      let result: Record<string, unknown>;
      try { result = await this.originalCommand(action, args); }
      finally {
        if (['tab_switch', 'tab_new', 'tab_close', 'click', 'press'].includes(action)) {
          await this.follow().catch(error => { this.errors.push(String(error)); });
        }
      }
      return result;
    };
  }
  static async start(engine: BrowserLabEngine, options: BrowserLabRecordingOptions) {
    const recorder = new BrowserLabRecording(engine, options);
    if (!recorder.path.endsWith('.mp4')) throw new Error('Recording output must end in .mp4.');
    const fps = options.fps ?? 10;
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('Recording fps must be an integer from 1 to 30.');
    mkdirSync(dirname(recorder.path), { recursive: true });
    const width = options.width ?? 1280, height = options.height ?? 800;
    recorder.cdp = await ScreencastCdp.connect(engine.cdpUrl);
    try {
      recorder.encoder = options.core.procs.spawnPiped(recorder.processGroup, options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'warning', '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
        '-an', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', recorder.path,
      ], { cwd: dirname(recorder.path) });
      recorder.stderr = new Response(recorder.encoder.proc.stderr).text();
      recorder.stdout = new Response(recorder.encoder.proc.stdout).text();
      recorder.cdp.onFrame = (params, sessionId) => {
        void recorder.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(error => recorder.errors.push(String(error)));
        if (sessionId !== recorder.sessionId) return;
        recorder.latest = Buffer.from(params.data, 'base64');
        recorder.capturedFrames++;
        recorder.firstFrame?.();
      };
      recorder.started = performance.now();
      await recorder.follow();
      recorder.timer = setInterval(() => { void recorder.pump().catch(error => recorder.errors.push(String(error))); }, 1000 / fps);
      recorder.timer.unref();
      engine.command = recorder.wrappedCommand;
      return recorder;
    } catch (error) {
      recorder.cdp.close();
      if (recorder.encoder) { options.core.procs.killTree(recorder.processGroup); await recorder.encoder.exited; await options.core.procs.stopAndWait(recorder.processGroup); }
      throw error;
    }
  }
  mark(label: string) { this.events.push({ atMs: performance.now() - this.started, label }); }
  /** Called automatically after commands that may change the selected page. */
  async follow() {
    if (this.stopped) return;
    const targetId = await this.engine.activeTargetId();
    if (targetId === this.targetId) return;
    if (this.sessionId) {
      await this.cdp.send('Page.stopScreencast', {}, this.sessionId).catch(error => this.errors.push(String(error)));
      await this.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(error => this.errors.push(String(error)));
    }
    const attached = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = attached.sessionId; this.targetId = targetId;
    this.events.push({ atMs: performance.now() - this.started, targetId, event: 'selected-target' });
    await this.cdp.send('Page.enable', {}, this.sessionId);
    // Every owned browser is headless. This selects its visible rendering target
    // without creating a desktop window or changing the selected model page.
    await this.cdp.send('Page.bringToFront', {}, this.sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = new Promise<void>((resolve, reject) => { this.firstFrame = resolve; timer = setTimeout(() => reject(new Error('No screencast frame arrived for selected target.')), 5000); });
    void first.catch(() => {});
    try {
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: this.options.width ?? 1280, maxHeight: this.options.height ?? 800, everyNthFrame: 1 }, this.sessionId);
      await first;
    } finally { clearTimeout(timer); this.firstFrame = undefined; }
  }
  private async pump() {
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      if (!this.latest) return;
      const expected = Math.max(1, Math.ceil((performance.now() - this.started) / 1000 * (this.options.fps ?? 10)));
      while (this.frameCount < expected) { this.encoder.proc.stdin.write(this.latest); this.frameCount++; }
      await this.encoder.proc.stdin.flush();
    })();
    try { await this.pumping; } finally { this.pumping = undefined; }
  }
  async stop() {
    if (this.stopped) throw new Error('Recording has already stopped.');
    this.stopped = true;
    if (this.engine.command === this.wrappedCommand) this.engine.command = this.originalCommand;
    clearInterval(this.timer);
    let exitCode: number | undefined;
    let failure: unknown;
    try {
      if (this.sessionId) await this.cdp.send('Page.stopScreencast', {}, this.sessionId);
      if (this.pumping) await this.pumping;
      await this.pump();
      this.encoder.proc.stdin.end();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { exitCode = await Promise.race([this.encoder.exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Video encoder did not finish within 15 seconds.')), 15_000); })]); }
      finally { clearTimeout(timeout); }
      if (exitCode !== 0) throw new Error(`Video encoder exited ${exitCode}: ${await this.stderr}`);
    } catch (error) { failure = error; }
    finally {
      if (this.sessionId) await this.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(error => this.errors.push(String(error)));
      this.cdp.close();
      this.options.core.procs.killTree(this.processGroup);
      await this.encoder.exited;
      await this.options.core.procs.stopAndWait(this.processGroup);
      writeFileSync(`${this.path}.json`, JSON.stringify({ instrumented: true, source: 'Actual CDP Page.screencastFrame JPEG stream with held last frames at constant frame rate; no screenshots, generated frames, overlays or action replay.', elapsedMs: performance.now() - this.started, fps: this.options.fps ?? 10, frames: this.frameCount, capturedFrames: this.capturedFrames, events: this.events, errors: this.errors, exitCode, failure: failure ? String(failure) : undefined, stderr: await this.stderr, stdout: await this.stdout }, null, 2));
    }
    if (failure) throw failure;
    return { path: this.path, bytes: statSync(this.path).size, frames: this.frameCount, capturedFrames: this.capturedFrames, targetChanges: this.events.filter(event => event.event === 'selected-target').length };
  }
}
