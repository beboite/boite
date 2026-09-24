import { writeFileSync } from 'node:fs';
import type { BrowserLabEngine, BrowserLabLog } from './browser-lab-engine.ts';

/** Viewport capture without Playwright's font-readiness wait. The page's actual
 * rendered pixels are evidence even when a remote font never finishes loading.
 */
export async function useDirectCapture(engine: BrowserLabEngine, log: (entry: BrowserLabLog) => void) {
  const socket = new WebSocket(engine.cdpUrl);
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (message: string) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); } pending.clear(); };
  socket.addEventListener('message', event => {
    let value: any;
    try { value = JSON.parse(String(event.data)); } catch { fail('Invalid capture CDP response.'); return; }
    const item = pending.get(value.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(value.id);
    if (value.error) item.reject(new Error('Capture CDP: ' + JSON.stringify(value.error))); else item.resolve(value.result);
  });
  socket.addEventListener('close', () => fail('Capture CDP closed.'));
  socket.addEventListener('error', () => fail('Capture CDP failed.'));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Capture CDP connection timed out.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('Capture CDP connection failed.')); }, { once: true });
  });
  const send = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Capture ${method} timed out.`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const command = engine.command, close = engine.close;
  const sessions = new Map<string, string>();
  engine.metadata.directCapture = 'CDP Page.captureScreenshot on the exact selected target; no font-readiness wait.';
  engine.command = async (action, args = {}) => {
    if (action !== 'screenshot') return command(action, args);
    if (typeof args.path !== 'string' || args.fullPage === true) throw new Error('Direct capture requires a viewport PNG output path.');
    const started = performance.now();
    try {
      const targetId = await engine.activeTargetId();
      let sessionId = sessions.get(targetId);
      if (!sessionId) { sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId as string; sessions.set(targetId, sessionId); }
      // Retain the emulation session until shutdown. A temporary session's
      // detach can restore the underlying headless window dimensions.
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
      const frame = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true }, sessionId);
      writeFileSync(args.path, Buffer.from(frame.data, 'base64'));
      const result = { path: args.path, capture: 'direct-cdp' };
      log({ engine: engine.kind, action, args, ms: performance.now() - started, success: true, result });
      return result;
    } catch (error) {
      log({ engine: engine.kind, action, args, ms: performance.now() - started, success: false, error: String(error) });
      throw error;
    }
  };
  engine.close = async () => { fail('Capture adapter closed.'); socket.close(); await close(); };
}
