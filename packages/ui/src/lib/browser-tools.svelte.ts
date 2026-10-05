import { SvelteMap } from 'svelte/reactivity';
import { browserPresetSize, type BrowserAction, type BrowserDiagnostics, type BrowserHistoryEntry, type BrowserPreset, type BrowserRecording, type BrowserReply } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { automateBrowser } from './browser-automation';
import { BrowserRecorder, warmRecordingEncoder } from './browser-recording';
import { RecordingIndicators } from './recording-indicators';
import { isExperimentEnabled } from './experiments';
import { recordingCodec, recordingFrameRate } from './recording-settings';

/**
 * `agent`: the running recording was started by the conversation's agent, not
 * from the menu. `discarded`: the agent's turn ended before it stopped one.
 */
interface TabTools { preset: BrowserPreset | null; orientation: 'portrait' | 'landscape'; colorScheme: 'system' | 'light' | 'dark'; recording: boolean; result: BrowserRecording | null; url: string | null; agent: boolean; discarded: boolean }
const states = new SvelteMap<string, TabTools>();
const recorders = new Map<string, BrowserRecorder>();
const history = new Map<string, BrowserHistoryEntry[]>();
export const DISCARDED_RECORDING_ERROR = "the recording was discarded because the agent's turn ended while it was running: stop it with recording-stop in the turn that started it";
export function browserTools(id: string): TabTools { return states.get(id) ?? { preset: null, orientation: 'portrait', colorScheme: 'system', recording: false, result: null, url: null, agent: false, discarded: false }; }
function patch(id: string, values: Partial<TabTools>) { states.set(id, { ...browserTools(id), ...values }); }
async function protocol(id: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!browserBridge.protocol) throw new Error('browser testing tools require the Windows desktop app');
  return browserBridge.protocol(id, method, params);
}
function recorder(id: string, indicators = false): BrowserRecorder {
  let value = recorders.get(id);
  if (!value) {
    const stream = browserBridge.screencast?.bind(browserBridge);
    value = new BrowserRecorder({
      capture: async () => {
        const reply = await protocol(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: false }) as { data: string };
        return reply.data;
      },
      ...(stream ? { stream: (frameRate: number, frame: (jpeg: ArrayBuffer) => void) => stream(id, frameRate, frame) } : {}),
    }, (recording, result) => patch(id, { recording, result, url: recorders.get(id)?.url ?? null, ...(recording || result ? {} : { agent: false }) }), indicators ? new RecordingIndicators(id) : undefined);
    recorders.set(id, value);
  }
  return value;
}
browserBridge.on(event => {
  // A page opening warms the encoder of the desktop's codec, once per process, so a first take starts clean.
  if (event.type === 'loading' && event.loading) warmRecordingEncoder(recordingCodec());
  if (event.type !== 'destroyed') return;
  recorders.get(event.id)?.dispose(); recorders.delete(event.id); states.delete(event.id); history.delete(event.id);
});

export async function trackBrowserAction<T>(id: string, action: BrowserAction, run: () => Promise<T>): Promise<T> {
  if (['snapshot', 'diagnostics', 'recording-read', 'status', 'get', 'dialog', 'activate'].includes(action.kind)) return run();
  const at = Date.now(); let ok = true;
  try { return await run(); }
  catch (cause) { ok = false; throw cause; }
  finally {
    // Keep operation names only: typed values and evaluated code can contain passwords.
    const entries = history.get(id) ?? [];
    entries.push({ at, action: action.kind, ok, durationMs: Date.now() - at });
    history.set(id, entries.slice(-100));
  }
}
export async function browserDiagnostics(id: string, clear = false): Promise<BrowserDiagnostics> {
  const data = await protocol(id, 'Boite.diagnostics', { clear }) as Pick<BrowserDiagnostics, 'entries' | 'dropped'>;
  const result = { ...data, history: [...(history.get(id) ?? [])] };
  if (clear) history.delete(id);
  return result;
}
/**
 * Stops and throws away a recording the agent started and has not stopped:
 * nothing is kept or offered. One the user started, or one already stopped at
 * the size limit, stays.
 */
export function discardAgentRecording(id: string): void {
  const tools = browserTools(id);
  if (!tools.agent || tools.result || !recorders.has(id)) return;
  recorders.get(id)!.dispose(); recorders.delete(id);
  patch(id, { recording: false, result: null, url: null, agent: false, discarded: true });
}

/** `by`: the agent, through the conversation's browser host, or the user from the menu. */
export async function runBrowserAction(id: string, action: BrowserAction, by: 'agent' | 'user' = 'user'): Promise<BrowserReply> {
  return trackBrowserAction(id, action, async () => {
    if ((action.kind === 'recording-stop' || action.kind === 'recording-read') && browserTools(id).discarded) throw new Error(DISCARDED_RECORDING_ERROR);
    let value: unknown = { ok: true };
    switch (action.kind) {
      case 'diagnostics': value = await browserDiagnostics(id, action.clear); break;
      case 'preset': {
        const size = browserPresetSize(action.preset, action.orientation);
        await protocol(id, 'Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
        patch(id, { preset: action.preset, orientation: size.width > size.height ? 'landscape' : 'portrait' }); value = size; break;
      }
      case 'appearance':
        await protocol(id, 'Emulation.setEmulatedMedia', { features: action.colorScheme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: action.colorScheme }] });
        patch(id, { colorScheme: action.colorScheme }); break;
      case 'recording-start': {
        if (action.indicators && !isExperimentEnabled('recording-indicators')) throw new Error('enable the recording-indicators experiment on this desktop first');
        if (!browserTools(id).recording && !browserTools(id).result) { recorders.get(id)?.dispose(); recorders.delete(id); }
        const next = recorder(id, action.indicators !== false && isExperimentEnabled('recording-indicators'));
        // Marked before it starts: a turn that ends while it starts discards it too.
        if (!browserTools(id).recording && !browserTools(id).result) patch(id, { agent: by === 'agent', discarded: false });
        try { await next.start(action.frameRate ?? recordingFrameRate(), action.codec ?? recordingCodec()); }
        catch (error) { if (recorders.get(id) === next && !browserTools(id).recording && !browserTools(id).result) patch(id, { agent: false }); throw error; }
        break;
      }
      case 'recording-stop': return { tabId: id, recording: await recorder(id).stop() };
      case 'recording-read': value = await recorder(id).read(action.recordingId, action.offset, action.maxBytes); break;
      case 'recording-discard': recorder(id).discard(action.recordingId); break;
      default: {
        const reply = await automateBrowser(id, action);
        if (action.kind === 'resize' || action.kind === 'reset-viewport') patch(id, { preset: null });
        return reply;
      }
    }
    return { tabId: id, value };
  });
}
