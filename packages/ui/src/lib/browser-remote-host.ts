import { remoteBrowserInputError, type RemoteBrowserFrame, type RemoteBrowserInput, type RemoteFrameOptions } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { isExperimentEnabled } from './experiments';

interface Page { width: number; height: number; title: string; href: string; origin: number; dpr: number }
interface Captured { frame: RemoteBrowserFrame; page: Page }
const captured = new Map<string, Captured>();
/** Recheck the owning conversation, tab and consent at every asynchronous boundary. */
function remotePage(id: string, assertCurrent: () => void) {
  const check = () => {
    assertCurrent();
    if (!isExperimentEnabled('remote-browser')) throw new Error('browser sharing is no longer enabled on this desktop');
  };
  const protocol = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    check();
    const result = await browserBridge.protocol!(id, method, params) as Record<string, unknown>;
    check();
    return result;
  };
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await protocol('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error('the shared page could not accept this action');
    return (result.result as { value?: unknown })?.value;
  };
  return { protocol, evaluate, check };
}
const pageInfo = '({width:innerWidth,height:innerHeight,title:document.title,href:location.href,origin:performance.timeOrigin,dpr:devicePixelRatio||1})';
const samePage = (a: Page, b: Page) => a.width === b.width && a.height === b.height && a.href === b.href && a.origin === b.origin;

/** The width a frame is shrunk to: what the viewer can show, never more than the page has. */
export function remoteWidth(pixels: number, maxWidth?: number): number | undefined {
  return maxWidth && pixels > maxWidth ? maxWidth : undefined;
}

/**
 * Shrinks a captured JPEG here, on the PC. Asking Chromium for a smaller image
 * (a screenshot `clip` with a `scale`) re-renders the live tab at that size
 * for the capture: the PC's browser flashed on every frame once the phone's
 * keyboard shrank the preview. Without canvas support the frame stays whole.
 */
async function shrinkFrame(base64: string, maxWidth: number, quality: number): Promise<string> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return base64;
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
  try {
    const width = remoteWidth(bitmap.width, maxWidth);
    if (!width) return base64;
    const canvas = new OffscreenCanvas(width, Math.max(1, Math.round(bitmap.height * width / bitmap.width)));
    const context = canvas.getContext('2d');
    if (!context) return base64;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  } finally { bitmap.close(); }
}

export async function captureRemoteBrowser(id: string, assertCurrent: () => void, options: RemoteFrameOptions = {}): Promise<RemoteBrowserFrame> {
  const { protocol, evaluate, check } = remotePage(id, assertCurrent);
  const page = await evaluate(pageInfo) as Page;
  const quality = options.quality ?? 55;
  // Never a clip: the visible viewport, at the scroll position, is what a plain capture takes.
  // An image shrunk here is captured at q75, not q90: a third fewer bytes to carry and decode
  // for the same frame once shrunk (docs/performance.md, the desktop browser on a phone).
  const shrink = remoteWidth(page.width * (page.dpr > 0 ? page.dpr : 1), options.maxWidth);
  const shot = await protocol('Page.captureScreenshot', { format: 'jpeg', quality: shrink ? Math.max(75, quality) : quality, captureBeyondViewport: false });
  if (!samePage(page, await evaluate(pageInfo) as Page)) throw new Error('the page changed during capture; retry');
  const base64 = shrink ? await shrinkFrame(String(shot.data), shrink, quality) : String(shot.data);
  check();
  const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId: id, title: page.title.slice(0, 200), width: page.width, height: page.height, base64, at: Date.now(), url: page.href.slice(0, 4096) };
  for (const [key, value] of captured) if (Date.now() - value.frame.at > 5000) captured.delete(key);
  if (captured.size >= 24) captured.delete(captured.keys().next().value!);
  captured.set(frame.id, { frame: { ...frame, base64: '' }, page });
  return frame;
}

/** Retire the tab's coordinates before anything that moves its page, even on failure. */
const retire = (id: string) => { for (const [key, value] of captured) if (value.frame.tabId === id) captured.delete(key); };

export async function inputRemoteBrowser(id: string, frameId: string, input: RemoteBrowserInput, assertCurrent: () => void, navigated?: (url: string) => void): Promise<void> {
  const problem = remoteBrowserInputError(input);
  if (problem) throw new Error(problem);
  const saved = captured.get(frameId);
  const changed = () => new Error('the page changed; wait for a fresh frame before interacting');
  if (!saved || saved.frame.tabId !== id) throw changed();
  const { protocol, evaluate, check } = remotePage(id, () => {
    assertCurrent();
    if (Date.now() - saved.frame.at > 5000) throw changed();
  });
  // The address bar and history buttons act on the tab, not on a point of the captured page.
  if (input.kind === 'navigate' || input.kind === 'history' || input.kind === 'reload') {
    check(); retire(id);
    if (input.kind === 'navigate') { browserBridge.navigate(id, input.url); navigated?.(input.url); }
    else if (input.kind === 'reload') browserBridge.reload(id);
    else if (input.direction === 'back') browserBridge.back(id);
    else browserBridge.forward(id);
    return;
  }
  if (!samePage(saved.page, await evaluate(pageInfo) as Page)) throw changed();
  const at = (x: number, y: number) => ({ x: Math.min(saved.page.width - 1, x * saved.page.width), y: Math.min(saved.page.height - 1, y * saved.page.height) });
  switch (input.kind) {
    case 'viewport':
    case 'reset-viewport': {
      retire(id);
      if (input.kind === 'viewport') await protocol('Emulation.setDeviceMetricsOverride', { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false });
      else await protocol('Emulation.clearDeviceMetricsOverride', {});
      break;
    }
    case 'tap': {
      const point = { ...at(input.x, input.y), button: 'left', clickCount: 1 };
      await protocol('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
      await protocol('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
      break;
    }
    case 'text': {
      const editable = await evaluate(`(() => { let e=document.activeElement; while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement; return !!e && !e.disabled && !e.readOnly && (e.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea') || e.isContentEditable); })()`);
      if (!editable) throw new Error('tap a text field in the shared page first');
      await protocol('Input.insertText', { text: input.text }); break;
    }
    case 'key': {
      const keyCode = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 }[input.key];
      await protocol('Input.dispatchKeyEvent', { type: 'keyDown', key: input.key, code: input.key, windowsVirtualKeyCode: keyCode, ...(input.key === 'Enter' ? { text: '\r' } : {}) });
      await protocol('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, code: input.key, windowsVirtualKeyCode: keyCode });
      break;
    }
    case 'scroll': {
      // The wheel lands where the finger started, so an inner scrolling panel moves instead of the page.
      const point = input.at ? at(input.at.x, input.at.y) : { x: saved.page.width / 2, y: saved.page.height / 2 };
      await protocol('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: input.x, deltaY: input.y });
      break;
    }
  }
}
