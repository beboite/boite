import type { RemoteBrowserFrame, RemoteBrowserInput } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { isExperimentEnabled } from './experiments';

interface Page { width: number; height: number; title: string; href: string; origin: number }
interface Captured { frame: RemoteBrowserFrame; page: Page }
const captured = new Map<string, Captured>();
/** Recheck the owning conversation, tab and consent at every asynchronous boundary. */
function remotePage(id: string, assertCurrent: () => void) {
  const check = () => {
    assertCurrent();
    if (!isExperimentEnabled('remote-browser') || !isExperimentEnabled('agent-browser-control')) throw new Error('browser sharing is no longer enabled on this desktop');
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
  return { protocol, evaluate };
}
const pageInfo = '({width:innerWidth,height:innerHeight,title:document.title,href:location.href,origin:performance.timeOrigin})';
const samePage = (a: Page, b: Page) => a.width === b.width && a.height === b.height && a.href === b.href && a.origin === b.origin;

export async function captureRemoteBrowser(id: string, assertCurrent: () => void): Promise<RemoteBrowserFrame> {
  const { protocol, evaluate } = remotePage(id, assertCurrent);
  const page = await evaluate(pageInfo) as Page;
  const shot = await protocol('Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: false });
  if (!samePage(page, await evaluate(pageInfo) as Page)) throw new Error('the page changed during capture; retry');
  const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId: id, title: page.title.slice(0, 200), width: page.width, height: page.height, base64: String(shot.data), at: Date.now() };
  for (const [key, value] of captured) if (Date.now() - value.frame.at > 5000) captured.delete(key);
  if (captured.size >= 24) captured.delete(captured.keys().next().value!);
  captured.set(frame.id, { frame: { ...frame, base64: '' }, page });
  return frame;
}

export async function inputRemoteBrowser(id: string, frameId: string, input: RemoteBrowserInput, assertCurrent: () => void): Promise<void> {
  const saved = captured.get(frameId);
  const changed = () => new Error('the page changed; wait for a fresh frame before interacting');
  if (!saved || saved.frame.tabId !== id) throw changed();
  const { protocol, evaluate } = remotePage(id, () => {
    assertCurrent();
    if (Date.now() - saved.frame.at > 5000) throw changed();
  });
  if (!samePage(saved.page, await evaluate(pageInfo) as Page)) throw changed();
  switch (input.kind) {
    case 'tap': {
      const point = { x: Math.min(saved.page.width - 1, input.x * saved.page.width), y: Math.min(saved.page.height - 1, input.y * saved.page.height), button: 'left', clickCount: 1 };
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
    case 'scroll': await protocol('Input.dispatchMouseEvent', { type: 'mouseWheel', x: saved.page.width / 2, y: saved.page.height / 2, deltaX: input.x, deltaY: input.y }); break;
  }
}
