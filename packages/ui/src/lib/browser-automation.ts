import type { BrowserAction, BrowserReply } from '@boite/contracts';
import { browserBridge as bridge } from './browser-bridge';

async function protocol(id: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!bridge.protocol) throw new Error('browser automation requires the Windows desktop app');
  return await bridge.protocol(id, method, params) as Record<string, unknown>;
}
async function evaluate(id: string, expression: string): Promise<unknown> {
  const reply = await protocol(id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 12000 });
  if (reply.exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 2000)}`);
  return (reply.result as { value?: unknown })?.value ?? null;
}

// The page is untrusted content. Return bounded text and selectors, never host APIs.
const snapshot = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const selector = el => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el !== document.documentElement) {
      const tag = el.localName; const siblings = Array.from(el.parentElement?.children ?? []).filter(s => s.localName === tag);
      parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')' : ''));
      el = el.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  };
  return { url: location.href, title: document.title, ready: document.readyState,
    viewport: { width: innerWidth, height: innerHeight }, text: (document.body?.innerText ?? '').slice(0, 20000),
    elements: Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(visible).slice(0, 150).map(el => ({ selector: selector(el), tag: el.localName, role: el.getAttribute('role'), label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').slice(0, 200), disabled: !!el.disabled })) };
})()`;

function target(selector: string, typing: boolean): string {
  return `(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)});
    if (nodes.length !== 1) throw new Error('selector must match exactly one element; matched ' + nodes.length);
    const el = nodes[0];
    if (el.disabled || el.readOnly) throw new Error('element is disabled or read-only');
    el.scrollIntoView({block:'center', inline:'center'});
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height || s.visibility === 'hidden') throw new Error('element is hidden');
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    if (!el.contains(document.elementFromPoint(x,y))) throw new Error('element is covered by another element');
    ${typing ? `if (!el.matches('input,textarea,[contenteditable="true"]')) throw new Error('element does not accept text');
    el.focus(); if (typeof el.select === 'function') el.select(); else { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }` : ''}
    return {x, y};
  })()`;
}

export async function automateBrowser(id: string, action: BrowserAction): Promise<BrowserReply> {
  switch (action.kind) {
    case 'snapshot': return { tabId: id, value: await evaluate(id, snapshot) };
    case 'evaluate': return { tabId: id, value: await evaluate(id, action.expression) };
    case 'click': {
      const point = await evaluate(id, target(action.selector, false)) as { x: number; y: number };
      await protocol(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await protocol(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      break;
    }
    case 'type':
      await evaluate(id, target(action.selector, true));
      if (action.text) await protocol(id, 'Input.insertText', { text: action.text });
      else { await protocol(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 }); await protocol(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 }); }
      break;
    case 'press': {
      const keyCode = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 }[action.key];
      await protocol(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, code: action.key, windowsVirtualKeyCode: keyCode, ...(action.key === 'Enter' ? { text: '\r' } : {}) });
      await protocol(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, code: action.key, windowsVirtualKeyCode: keyCode });
      break;
    }
    case 'scroll': await evaluate(id, `window.scrollBy(${action.x}, ${action.y})`); break;
    case 'resize':
      await protocol(id, 'Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false }); break;
    case 'reset-viewport': await protocol(id, 'Emulation.clearDeviceMetricsOverride', {}); break;
    case 'screenshot': {
      const result = await protocol(id, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (typeof result.data !== 'string') throw new Error('browser did not return a PNG screenshot');
      return { tabId: id, screenshot: { mime: 'image/png', base64: result.data } };
    }
    default: throw new Error(`unsupported native browser action ${action.kind}`);
  }
  return { tabId: id, value: { ok: true } };
}
