/*
 * The check of a page before it is shown: `boite view` loads the page it is
 * about to publish in a browser of its own and asks what it threw, what the
 * content policy refused and how tall it stands. `PageProbes` starts and ends
 * the browser of each check, with what `AgentBrowser` gives it to do so;
 * `probePage` is what happens in that browser.
 */
import { VIEW_BLEED, VIEW_DEFAULT_HEIGHT, VIEW_HEIGHT_EXPRESSION, clampViewHeight, type ViewCheckCapture } from '@boite/contracts';
import type { Cdp } from './cdp.ts';

/** A page check gives up after this long and the page is published unchecked: a slow browser never blocks an answer. */
export const PROBE_TIMEOUT_MS = 20_000;
const LOAD_MS = 8_000;
/** A few frames of the page's own script: what throws in its first tick of animation is caught too. */
const SETTLE_MS = 400;
const ERRORS_MAX = 8;

/** What a page did when it was loaded alone: its errors, and its height at each width asked. */
export interface PageProbe { errors: string[]; heights: number[]; captures?: ViewCheckCapture[] }
export interface ViewCheckOptions { script?: string; scheme?: 'dark' | 'light' }

/**
 * How far a page runs past its frame's right edge, and the outermost element
 * that does: null when it fits. The frame hides its scrollbars, so the rest is
 * cut and the reader cannot tell it is there. What a clipping or scrolling box
 * holds, and what is fixed to the window, scrolls nothing and is not counted.
 */
const OVERFLOW_EXPRESSION = `(function(){var r=document.documentElement,b=document.body,w=r.clientWidth;if(!b||r.scrollWidth<=w+1)return null;
function out(e){var x=e.getBoundingClientRect();return x.width>0&&x.right>w+1;}
function free(e){if(getComputedStyle(e).position==="fixed")return false;for(var a=e.parentElement;a&&a!==r;a=a.parentElement)if(getComputedStyle(a).overflowX!=="visible")return false;return true;}
var f=out(b)?b:null,all=b.getElementsByTagName("*"),i,e;
for(i=0;!f&&i<all.length;i++){e=all[i];if(out(e)&&!out(e.parentElement)&&free(e))f=e;}
function name(e){var d="<"+e.tagName.toLowerCase(),c=e.getAttribute("class");if(e.id)d+=' id="'+e.id+'"';if(c)d+=' class="'+c.trim().replace(/\\s+/g," ").slice(0,60)+'"';return d+">";}
var d=f?name(f)+(f!==b&&f.parentElement!==b?" inside "+name(f.parentElement):""):null;
return {width:r.scrollWidth,frame:w,element:d,right:f?Math.ceil(f.getBoundingClientRect().right):0};})()`;

interface Overflow { width: number; frame: number; element: string | null; right: number }

/** The refusal for a page wider than its frame, in the widths the agent was told: the content's, without the bleed. */
function overflowProblem(found: Overflow): string {
  const column = found.frame - 2 * VIEW_BLEED;
  const past = found.element ? `${found.element} ends ${found.right - (found.frame - VIEW_BLEED)}px past the right edge` : `the page is ${found.width - 2 * VIEW_BLEED}px wide`;
  return `at ${column}px wide the page is cut on the right and the reader cannot scroll sideways: ${past}. Use fluid widths (.grid, minmax(0, 1fr), max-width: 100%) and SVG with a viewBox and width:100%.`;
}

export async function probePage(cdp: Cdp, url: string, widths: readonly number[], check?: ViewCheckOptions): Promise<PageProbe> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const errors: string[] = [];
  // The ticket in the address means nothing to the agent: its own file does.
  const note = (text: string) => { if (errors.length < ERRORS_MAX) errors.push(text.split(url).join('page').slice(0, 600)); };
  const mine = (listener: (params: Record<string, unknown>) => void) => (params: Record<string, unknown>, session?: string) => { if (session === sessionId) listener(params); };
  let loaded = () => {};
  let load: Promise<void>;
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
    const sized = (width: number, height = 800) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    const navigate = async (width: number) => {
      await sized(width);
      load = new Promise<void>(resolve => { loaded = resolve; });
      const reply = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId);
      if (reply.errorText) throw new Error(reply.errorText);
      await Promise.race([load, Bun.sleep(LOAD_MS)]);
      await Bun.sleep(SETTLE_MS);
    };
    if (check) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: check.scheme ?? 'dark' }] }, sessionId);
    await navigate(widths[0] ?? 800);
    const heights: number[] = [];
    const captures: ViewCheckCapture[] = [];
    for (const [index, width] of widths.entries()) {
      // A script must see the original DOM at both widths, never the previous check's state.
      if (check && index > 0) await navigate(width);
      await sized(width);
      await Bun.sleep(100);
      let value: unknown;
      if (check?.script !== undefined) {
        const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
          expression: `(async () => {\n${check.script}\n})()\n//# sourceURL=boite-view-check.js`, returnByValue: true, awaitPromise: true, timeout: LOAD_MS,
        }, sessionId).catch(error => { note(`check script at ${width - 2 * VIEW_BLEED}px: ${String(error)}`); return null; });
        if (result?.exceptionDetails) note(`check script at ${width - 2 * VIEW_BLEED}px: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'failed'}`);
        else value = result?.result.value;
      }
      const { result } = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: VIEW_HEIGHT_EXPRESSION, returnByValue: true }, sessionId);
      heights.push(typeof result.value === 'number' && Number.isFinite(result.value) ? result.value : 0);
      const wide = await cdp.send<{ result: { value?: Overflow | null } }>('Runtime.evaluate', { expression: OVERFLOW_EXPRESSION, returnByValue: true }, sessionId);
      if (wide.result.value) note(overflowProblem(wide.result.value));
      if (check) {
        const height = clampViewHeight(heights.at(-1) || VIEW_DEFAULT_HEIGHT);
        await sized(width, height);
        // The transparent view normally sits on the conversation's background.
        await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.style.backgroundColor="var(--color-background)"; document.fonts.ready', awaitPromise: true }, sessionId);
        const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
        captures.push({ width: width - 2 * VIEW_BLEED, height, png: shot.data, ...(value === undefined ? {} : { value }) });
      }
    }
    return { errors, heights, ...(check ? { captures } : {}) };
  } finally { for (const stop of off) stop(); }
}

/**
 * The browsers started to check a page, one check at a time since each starts
 * a process. No conversation lists them, so they are closed here: when the
 * page answered, when the wait ran out, or on arrival for one that came up
 * after it.
 */
export class PageProbes<E extends { cdp: Cdp; dir: string }> {
  readonly #running = new Set<E>();
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly launch: () => Promise<E>, private readonly lost: (engine: E) => void, private readonly warn: (message: string) => void) {}

  /** Null when the browser did not answer in time or could not be started. */
  check(url: string, widths: readonly number[], timeoutMs: number): Promise<PageProbe | null> {
    return this.#enqueue(url, widths, timeoutMs);
  }

  inspect(url: string, widths: readonly number[], options: ViewCheckOptions, timeoutMs: number): Promise<PageProbe | null> {
    return this.#enqueue(url, widths, timeoutMs, options);
  }

  #enqueue(url: string, widths: readonly number[], timeoutMs: number, options?: ViewCheckOptions): Promise<PageProbe | null> {
    const run = this.#queue.then(() => this.#check(url, widths, timeoutMs, options));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Whether `dir` is the profile folder of a check still running: it is not a leftover to remove. */
  holds(dir: string): boolean {
    return [...this.#running].some(engine => engine.dir === dir);
  }

  close(): void {
    for (const engine of [...this.#running]) { this.#running.delete(engine); this.lost(engine); }
  }

  #check(url: string, widths: readonly number[], timeoutMs: number, options?: ViewCheckOptions): Promise<PageProbe | null> {
    let engine: E | null = null;
    let over = false;
    // Once, whoever asks first: the page answered, the wait ran out, or the browser came up too late.
    const end = () => {
      over = true;
      if (!engine) return;
      this.#running.delete(engine); this.lost(engine);
      engine = null;
    };
    const work = (async (): Promise<PageProbe> => {
      const started = engine = await this.launch();
      if (over) throw new Error('the browser started after the wait for it ran out');
      this.#running.add(started);
      return probePage(started.cdp, url, widths, options);
    })();
    return Promise.race([
      work.finally(end).catch(error => { this.warn(`a page could not be checked before it was shown: ${error instanceof Error ? error.message : String(error)}`); return null; }),
      // The browser is closed with the wait, not when a command it no longer answers gives up.
      Bun.sleep(timeoutMs).then(() => { end(); return null; }),
    ]);
  }
}
