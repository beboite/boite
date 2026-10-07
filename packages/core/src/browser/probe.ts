/*
 * The check of a page before it is shown: `boite view` loads the page it is
 * about to publish in a browser of its own and asks what it threw, what the
 * content policy refused and how tall it stands. `AgentBrowser.probe` starts
 * and ends the browser; this is what happens in it.
 */
import { VIEW_HEIGHT_EXPRESSION } from '@boite/contracts';
import type { Cdp } from './cdp.ts';

/** A page check gives up after this long and the page is published unchecked: a slow browser never blocks an answer. */
export const PROBE_TIMEOUT_MS = 20_000;
const LOAD_MS = 8_000;
/** A few frames of the page's own script: what throws in its first tick of animation is caught too. */
const SETTLE_MS = 400;
const ERRORS_MAX = 8;

/** What a page did when it was loaded alone: its errors, and its height at each width asked. */
export interface PageProbe { errors: string[]; heights: number[] }

export async function probePage(cdp: Cdp, url: string, widths: readonly number[]): Promise<PageProbe> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const errors: string[] = [];
  // The ticket in the address means nothing to the agent: its own file does.
  const note = (text: string) => { if (errors.length < ERRORS_MAX) errors.push(text.split(url).join('page').slice(0, 600)); };
  const mine = (listener: (params: Record<string, unknown>) => void) => (params: Record<string, unknown>, session?: string) => { if (session === sessionId) listener(params); };
  let loaded!: () => void;
  const load = new Promise<void>(resolve => { loaded = resolve; });
  const off = [
    cdp.on('Runtime.exceptionThrown', mine(params => {
      const details = params.exceptionDetails as { text?: string; lineNumber?: number; exception?: { description?: string } };
      const text = details.exception?.description ?? details.text ?? 'exception';
      note(/:\d+:\d+\)?$/m.test(text) || details.lineNumber === undefined ? text : `${text} (line ${details.lineNumber + 1})`);
    })),
    cdp.on('Runtime.consoleAPICalled', mine(params => {
      if (params.type !== 'error') return;
      const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      note(`console.error: ${args.map(arg => arg.description ?? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value))).join(' ')}`);
    })),
    // What the content policy refused is logged here, with the address it refused.
    cdp.on('Log.entryAdded', mine(params => {
      const entry = params.entry as { level?: string; text?: string; lineNumber?: number };
      if (entry.level !== 'error' || !entry.text || /favicon\.ico/.test(entry.text)) return;
      note(entry.lineNumber === undefined ? entry.text : `${entry.text} (line ${entry.lineNumber + 1})`);
    })),
    cdp.on('Page.loadEventFired', mine(() => loaded())),
  ];
  try {
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable'].map(method => cdp.send(method, {}, sessionId)));
    const sized = (width: number) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sized(widths[0] ?? 800);
    const reply = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId);
    if (reply.errorText) throw new Error(reply.errorText);
    await Promise.race([load, Bun.sleep(LOAD_MS)]);
    await Bun.sleep(SETTLE_MS);
    const heights: number[] = [];
    for (const width of widths) {
      await sized(width);
      await Bun.sleep(100);
      const { result } = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: VIEW_HEIGHT_EXPRESSION, returnByValue: true }, sessionId);
      heights.push(typeof result.value === 'number' && Number.isFinite(result.value) ? result.value : 0);
    }
    return { errors, heights };
  } finally { for (const stop of off) stop(); }
}
