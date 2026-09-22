import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import type { Core } from '../core.ts';
import { delay, type Driver } from './loop.ts';

/** Native agent-browser 0.37 protocol, pinned by the plugin capability. */
export class BrowserDaemon implements Driver {
  private buffer = '';
  private nextId = 0;
  private pending: { id: string; resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private socket: Socket | null = null;
  private closed = false;
  private constructor(private dispose: () => Promise<void>, private readonly signal: AbortSignal) {}

  static async launch(core: Core, taskId: string, binary: string, executablePath: string | null, signal: AbortSignal): Promise<BrowserDaemon> {
    const directory = mkdtempSync(join(tmpdir(), 'bb-'));
    const group = `browser:${taskId}`;
    // Do not inherit API keys, agent tokens, profiles, proxy credentials, or
    // agent-browser settings from the core's environment.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    writeFileSync(join(directory, 'config.json'), '{}');
    Object.assign(env, {
      AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: 'task', AGENT_BROWSER_SOCKET_DIR: directory,
      AGENT_BROWSER_PROFILE: join(directory, 'profile'),
      AGENT_BROWSER_CONFIG: join(directory, 'config.json'), AGENT_BROWSER_HEADED: '0',
      AGENT_BROWSER_ARGS: ['--mute-audio', '--no-first-run', '--no-default-browser-check', ...(process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11'] : [])].join(','),
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '30000', AGENT_BROWSER_DEFAULT_TIMEOUT: '5000',
    });
    if (executablePath) env.AGENT_BROWSER_EXECUTABLE_PATH = executablePath;
    let spawned: ReturnType<Core['procs']['spawnPiped']>;
    try { spawned = core.procs.spawnPiped(group, binary, [], { cwd: directory, env }); spawned.proc.stdin.end(); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    const drain = async (stream: ReadableStream<Uint8Array>) => { try { for await (const _ of stream) { /* Diagnostic output never enters the task transcript. */ } } catch {} };
    const drains = [drain(spawned.proc.stdout), drain(spawned.proc.stderr)];
    const daemon = new BrowserDaemon(async () => {
      core.procs.killTree(group);
      await spawned.exited;
      await Promise.allSettled(drains);
      try { await core.procs.stopAndWait(group); }
      finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }, signal);
    const abort = () => { daemon.fail(new Error('Browser task cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    const previousDispose = daemon.dispose;
    daemon.dispose = async () => { signal.removeEventListener('abort', abort); await previousDispose(); };
    void spawned.exited.then(() => daemon.fail(new Error('Browser daemon exited.')));
    try {
      const path = join(directory, process.platform === 'win32' ? 'task.port' : 'task.sock');
      const deadline = Date.now() + 15_000;
      while (!existsSync(path)) {
        signal.throwIfAborted();
        if (spawned.proc.exitCode !== null || Date.now() > deadline) throw new Error('Browser daemon did not start within 15 seconds.');
        await delay(50, signal);
      }
      signal.throwIfAborted();
      const socket = process.platform === 'win32'
        ? connect({ host: '127.0.0.1', port: Number(readFileSync(path, 'utf8').trim()) }) : connect(path);
      daemon.socket = socket;
      socket.setEncoding('utf8');
      socket.on('error', () => daemon.fail(new Error('Browser connection failed.')));
      socket.on('close', () => daemon.fail(new Error('Browser connection closed.')));
      socket.on('data', (chunk: string) => daemon.receive(chunk));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Browser connection timed out.')); }, 5000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('Browser connection failed.')); });
        socket.once('close', () => { clearTimeout(timer); reject(new Error('Browser connection closed.')); });
      });
      return daemon;
    } catch (error) { await daemon.close(); throw error; }
  }

  private fail(error: Error): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) { this.fail(new Error('Browser response exceeds 1 MB.')); this.socket?.destroy(); return; }
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      let raw: { id?: unknown; success?: unknown; data?: unknown };
      try { raw = JSON.parse(line) as typeof raw; } catch { this.fail(new Error('Browser returned invalid JSON.')); continue; }
      const pending = this.pending;
      if (!pending) continue;
      if (raw?.id !== pending.id) {
        // A cancelled command may finish before the queued close command.
        if (typeof raw?.id === 'string' && Number(raw.id) < Number(pending.id)) continue;
        this.fail(new Error('Browser response ID mismatch.')); continue;
      }
      clearTimeout(pending.timer); this.pending = null;
      if (raw.success !== true || !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) pending.reject(new Error('Browser command failed. No action was retried.'));
      else pending.resolve(raw.data as Record<string, unknown>);
    }
  }

  command(action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (action !== 'close') this.signal.throwIfAborted();
    if (this.closed || !this.socket || this.socket.destroyed) return Promise.reject(new Error('Browser connection is closed.'));
    if (this.pending) return Promise.reject(new Error('Only one browser command may run at a time.'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('Browser command timed out.')); this.socket?.destroy(); }, action === 'navigate' ? 30_000 : 10_000);
      this.pending = { id, resolve, reject, timer };
      this.socket!.write(JSON.stringify({ ...args, id, action }) + '\n');
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { if (!this.pending && this.socket && !this.socket.destroyed) await this.command('close'); } catch { /* force-stop the owned process group below */ }
    this.closed = true; this.fail(new Error('Browser task closed.')); this.socket?.destroy();
    await this.dispose();
  }
}
