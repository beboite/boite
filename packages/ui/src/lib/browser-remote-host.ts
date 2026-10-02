import type { RemoteBrowserFrame, RemoteBrowserInput } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { automateBrowser } from './browser-automation';
import { isExperimentEnabled } from './experiments';

interface Page { width: number; height: number; title: string; href: string; origin: number }
interface Captured { frame: RemoteBrowserFrame; page: Page }
const captured = new Map<string, Captured>();
async function protocol(id: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isExperimentEnabled('remote-browser')) throw new Error('enable remote-browser on this desktop first');
  return await browserBridge.protocol!(id, method, params) as Record<string, unknown>;
}
async function evaluate(id: string, expression: string): Promise<unknown> {
  const result = await protocol(id, 'Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error('the shared page could not accept this action');
  return (result.result as { value?: unknown })?.value;
}
const pageInfo = '({width:innerWidth,height:innerHeight,title:document.title,href:location.href,origin:performance.timeOrigin})';
const samePage = (a: Page, b: Page) => a.width === b.width && a.height === b.height && a.href === b.href && a.origin === b.origin;

export async function captureRemoteBrowser(id: string): Promise<RemoteBrowserFrame> {
  const page = await evaluate(id, pageInfo) as Page;
  const shot = await protocol(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: false });
  if (!samePage(page, await evaluate(id, pageInfo) as Page)) throw new Error('the page changed during capture; retry');
  const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId: id, title: page.title.slice(0, 200), width: page.width, height: page.height, base64: String(shot.data), at: Date.now() };
  for (const [key, value] of captured) if (Date.now() - value.frame.at > 5000) captured.delete(key);
  if (captured.size >= 24) captured.delete(captured.keys().next().value!);
  captured.set(frame.id, { frame: { ...frame, base64: '' }, page });
  return frame;
}

export async function inputRemoteBrowser(id: string, frameId: string, input: RemoteBrowserInput): Promise<void> {
  const saved = captured.get(frameId);
  if (!saved || saved.frame.tabId !== id || Date.now() - saved.frame.at > 5000 || !samePage(saved.page, await evaluate(id, pageInfo) as Page)) throw new Error('the page changed; wait for a fresh frame before interacting');
  switch (input.kind) {
    case 'tap': {
      const point = { x: Math.min(saved.page.width - 1, input.x * saved.page.width), y: Math.min(saved.page.height - 1, input.y * saved.page.height), button: 'left', clickCount: 1 };
      await protocol(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
      await protocol(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
      break;
    }
    case 'text': {
      const editable = await evaluate(id, `(() => { let e=document.activeElement; while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement; return !!e && !e.disabled && !e.readOnly && (e.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea') || e.isContentEditable); })()`);
      if (!editable) throw new Error('tap a text field in the shared page first');
      await protocol(id, 'Input.insertText', { text: input.text }); break;
    }
    case 'key': await automateBrowser(id, { kind: 'press', key: input.key }); break;
    case 'scroll': await protocol(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: saved.page.width / 2, y: saved.page.height / 2, deltaX: input.x, deltaY: input.y }); break;
  }
}
