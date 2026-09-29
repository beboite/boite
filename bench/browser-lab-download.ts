import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrowserLabEngine, BrowserLabLog } from './browser-lab-engine.ts';

/** Candidate correction, separate from the frozen native download baseline.
 * BrowserDaemon retains browser/process ownership. Only download is wrapped.
 */
export function useNativeDownload(engine: BrowserLabEngine, log: (entry: BrowserLabLog) => void) {
  if (engine.kind !== 'agent-browser') return;
  const command = engine.command, close = engine.close;
  let closed = false, cancel: ((error: Error) => void) | undefined;
  engine.metadata.downloadCorrection = 'Native observed-ref click with pinTab:true, root CDP allowAndName, ordinary resolved destination parent, active-frame and GUID matching, verified file copy. Windows extended-path cancellation workaround; pinTab retains the web target when Edge creates its downloads hub. 30 second bound. No native download command or Playwright attachment.';
  engine.close = async () => { closed = true; cancel?.(new Error('Native download adapter closed.')); await close(); };
  engine.command = async (action, args = {}) => {
    if (action !== 'download') return command(action, args);
    const started = performance.now();
    let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let cancelOperation: ((error: Error) => void) | undefined;
    let next = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    const events: any[] = [];
    try {
      if (closed) throw new Error('Native download adapter closed.');
      if (cancel) throw new Error('A native download is already active.');
      if (typeof args.selector !== 'string' || !/^@\S+$/.test(args.selector)) throw new Error('Native download requires an observed @ref selector.');
      if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('Native download requires an artifact path.');
      // Rust canonicalize supplies this prefix on Windows. CDP in the tested
      // Edge build accepts the ordinary drive path and cancels the extended form.
      const input = args.path.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1');
      if (/^\\\\/.test(input)) throw new Error('Native download correction supports ordinary local drive paths, not UNC/device paths.');
      const path = resolve(input), directory = dirname(path);
      mkdirSync(directory, { recursive: true });
      const endpoint = new URL(engine.cdpUrl);
      if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Native download requires the owned loopback CDP endpoint.');
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      let abortedOnce = false;
      cancelOperation = error => {
        if (abortedOnce) return; abortedOnce = true;
        rejectAbort(error); for (const item of pending.values()) item.reject(error); pending.clear(); socket?.close();
      };
      cancel = cancelOperation;
      timer = setTimeout(() => cancelOperation?.(new Error('Native download timed out after 30000ms. A click may have completed; no retry was made.')), 30_000);
      const run = async () => {
        let frameId = '', begun: any, armed = false;
        let resolveTerminal!: (value: any) => void;
        const terminal = new Promise<any>(resolve => { resolveTerminal = resolve; });
        socket = new WebSocket(engine.cdpUrl);
        socket.addEventListener('message', event => {
          let value: any;
          try { value = JSON.parse(String(event.data)); }
          catch { cancelOperation?.(new Error('Invalid native download CDP response.')); return; }
          const item = pending.get(value.id);
          if (item) {
            pending.delete(value.id);
            if (value.error) item.reject(new Error('Native download CDP: ' + JSON.stringify(value.error))); else item.resolve(value.result);
          }
          if (!value.method?.startsWith('Browser.download')) return;
          events.push(value);
          if (!armed) return;
          if (value.method === 'Browser.downloadWillBegin' && value.params.frameId === frameId && !begun) begun = value.params;
          if (value.method === 'Browser.downloadProgress' && begun && value.params.guid === begun.guid && ['completed', 'canceled'].includes(value.params.state)) resolveTerminal({ begun, progress: value.params });
        });
        socket.addEventListener('close', () => cancelOperation?.(new Error('Native download CDP closed.')));
        socket.addEventListener('error', () => cancelOperation?.(new Error('Native download CDP failed.')));
        await new Promise<void>((resolve, reject) => {
          socket!.addEventListener('open', () => resolve(), { once: true });
          socket!.addEventListener('error', () => reject(new Error('Native download CDP connect failed.')), { once: true });
        });
        const send = (method: string, params: any, sessionId?: string) => new Promise<any>((resolve, reject) => {
          const id = ++next; pending.set(id, { resolve, reject });
          socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
        const targetId = await engine.activeTargetId();
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
        frameId = frameTree.frame.id;
        await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true });
        armed = true;
        await command('click', { selector: args.selector, pinTab: true });
        const { progress } = await terminal;
        if (progress.state !== 'completed') throw new Error('Native download canceled: ' + begun.guid);
        if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(begun.guid)) throw new Error('Native download returned an invalid GUID.');
        const owned = join(directory, begun.guid);
        if (!existsSync(owned)) throw new Error('Native download completed but owned GUID file is missing.');
        const stat = lstatSync(owned);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Native download GUID artifact is not a nonempty regular file.');
        const bytes = readFileSync(owned), sha256 = createHash('sha256').update(bytes).digest('hex');
        if (owned !== path) {
          copyFileSync(owned, path);
          if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) throw new Error('Native download copied artifact hash mismatch.');
          unlinkSync(owned);
        }
        return { path, suggestedFilename: begun.suggestedFilename, sourceUrl: begun.url, sourcePageUrl: frameTree.frame.url, guid: begun.guid,
          bytes: bytes.length, header: bytes.subarray(0, 4).toString('hex'), sha256, downloadEvents: events };
      };
      const result = await Promise.race([run(), aborted]);
      log({ engine: engine.kind, action, args, ms: performance.now() - started, success: true, result });
      return result;
    } catch (error) {
      log({ engine: engine.kind, action, args, ms: performance.now() - started, success: false,
        error: error instanceof Error ? error.stack ?? String(error) : String(error), result: { downloadEvents: events } });
      throw error;
    } finally {
      clearTimeout(timer); if (cancel === cancelOperation) cancel = undefined;
      cancelOperation = undefined;
      for (const item of pending.values()) item.reject(new Error('Native download operation ended.'));
      pending.clear(); socket?.close();
    }
  };
}
