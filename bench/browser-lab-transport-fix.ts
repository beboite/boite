import { connect, type Socket } from 'node:net';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { BrowserLabNativeTransport, BrowserLabPlaywrightCommands, type BrowserLabEngineKind, type BrowserLabEngineOptions, type BrowserLabEngine } from './browser-lab-engine.ts';

export async function connectIndependentNativeTransport(daemon: BrowserDaemon, timeoutMs?: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const owner = (daemon as unknown as { socket: Socket }).socket;
  if (!owner.remotePort || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(owner.remoteAddress ?? '')) {
    throw new Error('Independent laboratory transport requires the owned loopback TCP endpoint (Windows native daemon).');
  }
  const socket = connect({ host: owner.remoteAddress!, port: owner.remotePort });
  socket.setEncoding('utf8');
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed);
        socket.off('close', closed); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const connected = () => finish(), failed = (error: Error) => finish(error);
      const closed = () => finish(new Error('Independent native connection closed during setup.'));
      const aborted = () => finish(new Error('Independent native connection aborted.'));
      const timer = setTimeout(() => finish(new Error('Independent native connection timed out.')), 5000);
      socket.once('connect', connected); socket.once('error', failed); socket.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    const native = new BrowserLabNativeTransport(socket, timeoutMs, signal);
    const dispose = native.dispose.bind(native);
    native.dispose = () => { dispose(); socket.destroy(); };
    return native;
  } catch (error) { socket.destroy(); throw error; }
}

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
type Pw = any;
function packageVersion(path: string, expectedName: string): string | undefined {
  try { const pkg = JSON.parse(readFileSync(path, 'utf8')); return pkg.name === expectedName && typeof pkg.version === 'string' ? pkg.version : undefined; }
  catch { return undefined; }
}


// Separate variant of the frozen factory. Action mappings and observations are unchanged.
export async function createBrowserLabEngineTransportFix(kind: BrowserLabEngineKind, options: BrowserLabEngineOptions): Promise<BrowserLabEngine> {
  const signal = options.signal ?? new AbortController().signal;
  const daemon = await BrowserDaemon.launch(options.core, options.taskId, options.binary, options.executablePath, signal);
  let native: BrowserLabNativeTransport;
  try { native = await connectIndependentNativeTransport(daemon, options.commandTimeoutMs, signal); }
  catch (error) { await daemon.close(); throw error; }
  const group = `browser:${options.taskId}`;
  let browser: Pw;
  let closed = false;
  let busy = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let keepingAlive: Promise<void> | undefined;
  let viewport: Record<string, unknown> = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
  const log = options.log ?? (() => {});
  async function close() {
    if (closed) return; closed = true;
    clearInterval(heartbeat);
    native.dispose();
    // A CDP-connected Playwright close disconnects it. BrowserDaemon owns the process tree.
    try { if (browser) await browser.close(); }
    finally { try { await daemon.close(); } finally { await options.core.procs.stopAndWait(group); } }
  }
  try {
    await native.command('evaluate', { script: '0' });
    await native.command('set_media', { colorScheme: 'light' });
    const { cdpUrl } = await native.command('cdp_url');
    if (typeof cdpUrl !== 'string' || !cdpUrl.startsWith('ws://127.0.0.1:')) throw new Error('Expected the owned local browser CDP URL.');
    const agent = await native.command('evaluate', { script: 'navigator.userAgent' });
    let pw: BrowserLabPlaywrightCommands | undefined;
    let playwrightVersion: string | undefined;
    if (kind === 'playwright') {
      const modulePath = options.playwrightModule ?? process.env.BOITE_BENCH_PLAYWRIGHT_MODULE;
      const module = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright-core');
      playwrightVersion = modulePath ? packageVersion(join(dirname(modulePath), 'package.json'), 'playwright-core') : undefined;
      browser = await module.chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
      pw = new BrowserLabPlaywrightCommands(browser);
    }
    const metadata = { kind, userAgent: agent.result, executablePath: options.executablePath, browserLifecycle: 'BrowserDaemon launches the same isolated headless muted browser for both engines; Playwright attaches over CDP. This compares actions and observations, not independent Playwright lifecycle.', agentBrowserVersion: options.agentBrowserVersion ?? packageVersion(join(dirname(options.binary), '..', 'package.json'), 'agent-browser') ?? 'unknown', playwrightVersion: playwrightVersion ?? null, playwrightProtocol: kind === 'playwright' ? `${typeof browser.contexts()[0].pages()[0].ariaSnapshot === 'function' ? 'Public page.ariaSnapshot({mode:ai})' : 'Internal _snapshotForAI fallback for older versions'} and aria-ref; default locator actionability` : null, nativeTimeout: 'No automatic retry. A timed-out native command may complete later; socket remains open.', snapshotFiltering: kind === 'playwright' ? 'AI snapshot full tree; interactive retains lines with refs; compact is already implicit; selector scoping unsupported.' : 'Native snapshot options' };
    Object.assign(metadata, { nativeTransport: "Independent loopback TCP connection; production BrowserDaemon receiver sees only its own close reply. Frozen campaign instrumentation correction.", colorScheme: 'light', observationRendering: 'prepare_observation reapplies the requested viewport and light color scheme on the current target before every LabPage observation, including after failed actions and downloads.' });
    const command = async (action: string, args: Record<string, unknown> = {}) => {
      signal.throwIfAborted();
      if (keepingAlive) await keepingAlive;
      if (closed) throw new Error('Browser laboratory engine is closed.');
      if (busy) throw new Error('Only one browser laboratory command may run at a time.');
      busy = true; const start = performance.now();
      try {
        if (action === 'prepare_observation') {
          // A navigation or failed download can replace the renderer while the
          // native browser process remains alive. Reapply emulation to the
          // current target before state, snapshot and screenshot are collected.
          if (pw) await pw.command('viewport', viewport);
          else {
            await native.command('viewport', viewport);
            await native.command('set_media', { colorScheme: 'light' });
          }
          const result = { viewport: { ...viewport }, colorScheme: 'light' };
          log({ engine: kind, action, args, ms: performance.now() - start, success: true, result });
          return result;
        }
        const result = await (pw ? pw.command(action === 'tab_list' ? 'tabs' : action, args) : native.command(action === 'tabs' ? 'tab_list' : action, args));
        if (action === 'viewport') viewport = { ...args };
        if ((action === 'tab_new' || action === 'tab_switch') && viewport) {
          const viewportStart = performance.now();
          await (pw ? pw.command('viewport', viewport) : native.command('viewport', viewport));
          log({ engine: kind, action: 'viewport', args: viewport, phase: 'tab-viewport', ms: performance.now() - viewportStart, success: true });
        }
        log({ engine: kind, action, args, ms: performance.now() - start, success: true, result });
        return result;
      } catch (error) {
        log({ engine: kind, action, args, ms: performance.now() - start, success: false, error: error instanceof Error ? error.stack ?? String(error) : String(error) });
        throw error;
      } finally { busy = false; }
    };
    heartbeat = setInterval(() => {
      // PW actions do not touch the native transport. Keep its launch owner alive
      // even during a long PW navigation, or AB's idle timer kills both clients.
      if ((busy && !pw) || closed || keepingAlive) return;
      const start = performance.now();
      keepingAlive = (async () => {
        try { await native.command('cdp_url'); log({ engine: kind, action: 'cdp_url', args: {}, phase: 'keepalive', ms: performance.now() - start, success: true }); }
        catch (error) { log({ engine: kind, action: 'cdp_url', args: {}, phase: 'keepalive', ms: performance.now() - start, success: false, error: String(error) }); }
        finally { keepingAlive = undefined; }
      })();
    }, 10_000);
    heartbeat.unref();
    const activeTargetId = async () => {
      if (keepingAlive) await keepingAlive;
      if (pw) return pw.activeTargetId();
      const result = await native.command('tab_list');
      const active = (result.tabs as Array<{ active: boolean; targetId: string }>).find(tab => tab.active);
      if (!active) throw new Error('Native browser has no active page target.');
      return active.targetId;
    };
    return { kind, daemon, cdpUrl, processGroup: group, metadata, command, close, activeTargetId };
  } catch (error) { await close(); throw error; }
}
