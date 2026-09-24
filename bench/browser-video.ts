import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';

type Pending = { resolve(value: any): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> };

class RecordingCdp {
  private next = 0;
  private pending = new Map<number, Pending>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Video CDP connection timed out.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Video CDP connection failed.')); }, { once: true });
    });
    return new RecordingCdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Video CDP ${method} timed out.`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Video CDP connection closed.'));
    }
    this.pending.clear();
  }
  close() { this.rejectPending(); this.socket.close(); }
}

// This is recorder instrumentation. It observes actual DOM events and draws a
// target outline, never dispatches events or invents pointer movement.
function installOverlay(started: number, title: string) {
  const scope = window as any;
  scope.__boiteRecording?.stop();
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>*{box-sizing:border-box}.label{position:absolute;left:16px;bottom:16px;background:#111e;color:white;padding:10px 14px;border:1px solid #9bb7ca;border-radius:6px;font:14px/1.5 monospace;max-width:900px;white-space:pre-wrap}.target{position:absolute;border:3px solid #ffbf47;background:#ffbf4715;border-radius:4px;display:none}</style><div class="target"></div><div class="label"></div>';
  const label = root.querySelector('.label') as HTMLElement;
  const target = root.querySelector('.target') as HTMLElement;
  let action = 'Recording live browser';
  let observed = '';
  let hide: ReturnType<typeof setTimeout>;
  const paint = () => { label.textContent = `RECORDER | ${title} | ${((Date.now() - started) / 1000).toFixed(1)}s\n${action}${observed ? '\nObserved ' + observed : ''}`; };
  const mount = () => { if (!host.isConnected) document.documentElement?.append(host); paint(); };
  const onEvent = (event: Event) => {
    if (!(event.target instanceof Element) || event.target === host) return;
    const rect = event.target.getBoundingClientRect();
    observed = `${event.type} on ${event.target.tagName.toLowerCase()}${event.target.id ? '#' + event.target.id : ''}`;
    target.style.cssText = `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    clearTimeout(hide);
    hide = setTimeout(() => { target.style.display = 'none'; }, 700);
    paint();
  };
  const events = ['click', 'focusin', 'input'];
  for (const event of events) document.addEventListener(event, onEvent, true);
  const timer = setInterval(mount, 200);
  scope.__boiteRecording = {
    mark: (value: string) => { action = value; observed = ''; mount(); },
    stop: () => { clearInterval(timer); clearTimeout(hide); for (const event of events) document.removeEventListener(event, onEvent, true); host.remove(); delete scope.__boiteRecording; },
  };
  mount();
}

/** Opt-in live recording. Its runs must stay separate from timing benchmarks. */
export class BrowserVideo {
  private events: Array<{ atMs: number; label: string }> = [];
  private errors: string[] = [];
  private stopped = false;
  private constructor(
    private daemon: BrowserDaemon,
    private cdp: RecordingCdp,
    private sessionId: string,
    private scriptId: string,
    readonly path: string,
    private started: number,
    private setupMs: number,
  ) {}

  static async start(daemon: BrowserDaemon, output: string, title = 'Live browser task', fps = 15): Promise<BrowserVideo> {
    const setupStart = performance.now();
    const path = resolve(output);
    if (!/\.(mp4|webm)$/i.test(path)) throw new Error('Video output must end in .mp4 or .webm.');
    mkdirSync(dirname(path), { recursive: true });
    const endpoint = await daemon.command('cdp_url');
    const url = Object.values(endpoint).find(value => typeof value === 'string' && /^wss?:\/\//.test(value));
    if (typeof url !== 'string') throw new Error('Native cdp_url did not return a WebSocket endpoint.');
    const cdp = await RecordingCdp.connect(url);
    let sessionId: string | undefined;
    let scriptId: string | undefined;
    let recordingStarted = false;
    try {
      const targets = await cdp.send('Target.getTargets');
      const pages = targets.targetInfos.filter((target: any) => target.type === 'page');
      if (pages.length !== 1) throw new Error('Video helper requires exactly one owned page.');
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true }));
      await cdp.send('Page.enable', {}, sessionId);
      await daemon.command('recording_start', { path, fps });
      recordingStarted = true;
      const started = Date.now();
      const source = `(${installOverlay.toString()})(${started},${JSON.stringify(title)})`;
      ({ identifier: scriptId } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId));
      await cdp.send('Runtime.evaluate', { expression: source }, sessionId);
      return new BrowserVideo(daemon, cdp, sessionId!, scriptId!, path, started, performance.now() - setupStart);
    } catch (error) {
      if (recordingStarted) await daemon.command('recording_stop').catch(() => {});
      if (sessionId) {
        if (scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }, sessionId).catch(() => {});
        await cdp.send('Runtime.evaluate', { expression: 'window.__boiteRecording?.stop()' }, sessionId).catch(() => {});
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      cdp.close();
      throw error;
    }
  }

  /** Non-blocking label. Pass a public label without credentials or field values. */
  mark(label: string): void {
    if (this.stopped) return;
    this.events.push({ atMs: Date.now() - this.started, label });
    void this.cdp.send('Runtime.evaluate', {
      expression: `window.__boiteRecording?.mark(${JSON.stringify(label)})`,
    }, this.sessionId).catch(error => this.errors.push(String(error)));
  }

  async stop() {
    if (this.stopped) throw new Error('Video has already stopped.');
    this.stopped = true;
    const stopStart = performance.now();
    let recording: Record<string, unknown> | undefined;
    let recordingError: unknown;
    try { recording = await this.daemon.command('recording_stop'); }
    catch (error) { recordingError = error; }
    finally {
      // A native stop timeout destroys the driver's connection. The owner must
      // close its browser; more page RPCs can only delay that cleanup.
      if (!recordingError) {
        await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }, this.sessionId).catch(error => this.errors.push(String(error)));
        await this.cdp.send('Runtime.evaluate', { expression: 'window.__boiteRecording?.stop()' }, this.sessionId).catch(error => this.errors.push(String(error)));
        await this.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(error => this.errors.push(String(error)));
      }
      this.cdp.close();
      writeFileSync(`${this.path}.json`, JSON.stringify({ instrumented: true, source: 'Live native agent-browser CDP screencast', setupMs: this.setupMs, elapsedMs: Date.now() - this.started, stopMs: performance.now() - stopStart, recording, recordingError: recordingError ? String(recordingError) : undefined, events: this.events, errors: this.errors }, null, 2));
    }
    if (recordingError) throw recordingError;
    return { ...recording, fileExists: statSync(this.path).size > 0, bytes: statSync(this.path).size };
  }
}
