import { SvelteMap } from 'svelte/reactivity';
import { browserPresetSize, type BrowserAction, type BrowserDiagnostics, type BrowserHistoryEntry, type BrowserPreset, type BrowserRecording, type BrowserReply } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { automateBrowser } from './browser-automation';
import { BrowserRecorder } from './browser-recording';
import { RecordingIndicators } from './recording-indicators';
import { isExperimentEnabled } from './experiments';

interface TabTools { preset: BrowserPreset | null; orientation: 'portrait' | 'landscape'; colorScheme: 'system' | 'light' | 'dark'; recording: boolean; result: BrowserRecording | null; url: string | null }
const states = new SvelteMap<string, TabTools>();
const recorders = new Map<string, BrowserRecorder>();
const history = new Map<string, BrowserHistoryEntry[]>();
export function browserTools(id: string): TabTools { return states.get(id) ?? { preset: null, orientation: 'portrait', colorScheme: 'system', recording: false, result: null, url: null }; }
function patch(id: string, values: Partial<TabTools>) { states.set(id, { ...browserTools(id), ...values }); }
async function protocol(id: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!browserBridge.protocol) throw new Error('browser testing tools require the Windows desktop app');
  return browserBridge.protocol(id, method, params);
}
function recorder(id: string, indicators = false): BrowserRecorder {
  let value = recorders.get(id);
  if (!value) {
    value = new BrowserRecorder(async () => {
      const reply = await protocol(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: false }) as { data: string };
      return reply.data;
    }, (recording, result) => patch(id, { recording, result, url: recorders.get(id)?.url ?? null }), indicators ? new RecordingIndicators(id) : undefined);
    recorders.set(id, value);
  }
  return value;
}
browserBridge.on(event => {
  if (event.type !== 'destroyed') return;
  recorders.get(event.id)?.dispose(); recorders.delete(event.id); states.delete(event.id); history.delete(event.id);
});

export async function trackBrowserAction<T>(id: string, action: BrowserAction, run: () => Promise<T>): Promise<T> {
  if (['snapshot', 'diagnostics', 'recording-read', 'status'].includes(action.kind)) return run();
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
export async function runBrowserAction(id: string, action: BrowserAction): Promise<BrowserReply> {
  return trackBrowserAction(id, action, async () => {
    let value: unknown = { ok: true };
    switch (action.kind) {
      case 'snapshot': {
        const reply = await automateBrowser(id, action);
        return { ...reply, value: { ...reply.value as object, diagnostics: await browserDiagnostics(id), settings: browserTools(id) } };
      }
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
        await recorder(id, action.indicators !== false && isExperimentEnabled('recording-indicators')).start(); break;
      }
      case 'recording-stop': return { tabId: id, recording: await recorder(id).stop() };
      case 'recording-read': value = await recorder(id).read(action.recordingId, action.offset); break;
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
