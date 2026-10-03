import { remoteBrowserInputError, type RemoteBrowserFrame, type RemoteBrowserInput, type RemoteFrameOptions } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { isExperimentEnabled } from './experiments';

interface Page { width: number; height: number; title: string; href: string; origin: number; dpr: number; left: number; top: number }
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
const pageInfo = '({width:innerWidth,height:innerHeight,title:document.title,href:location.href,origin:performance.timeOrigin,dpr:devicePixelRatio||1,left:visualViewport?visualViewport.pageLeft:scrollX,top:visualViewport?visualViewport.pageTop:scrollY})';
const samePage = (a: Page, b: Page) => a.width === b.width && a.height === b.height && a.href === b.href && a.origin === b.origin;

/**
 * The screenshot clip is in page coordinates, so it follows the scroll position;
 * `scale` shrinks a high-density desktop page to what the viewer can show.
 */
export function remoteClip(page: Pick<Page, 'width' | 'height' | 'dpr' | 'left' | 'top'>, maxWidth?: number) {
  const pixels = page.width * (page.dpr > 0 ? page.dpr : 1);
  if (!maxWidth || !(pixels > maxWidth)) return undefined;
  return { x: page.left || 0, y: page.top || 0, width: page.width, height: page.height, scale: maxWidth / pixels };
}

export async function captureRemoteBrowser(id: string, assertCurrent: () => void, options: RemoteFrameOptions = {}): Promise<RemoteBrowserFrame> {
  const { protocol, evaluate } = remotePage(id, assertCurrent);
  const page = await evaluate(pageInfo) as Page;
  const clip = remoteClip(page, options.maxWidth);
  const shot = await protocol('Page.captureScreenshot', { format: 'jpeg', quality: options.quality ?? 55, captureBeyondViewport: false, ...(clip ? { clip } : {}) });
  if (!samePage(page, await evaluate(pageInfo) as Page)) throw new Error('the page changed during capture; retry');
  const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId: id, title: page.title.slice(0, 200), width: page.width, height: page.height, base64: String(shot.data), at: Date.now(), url: page.href.slice(0, 4096) };
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
