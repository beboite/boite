import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const calls: { method: string; params: Record<string, unknown> }[] = [];
// The desktop's WebView2 channel, played by jsdom: page scripts run here, native input is recorded.
vi.mock('./browser-bridge', () => ({
  browserBridge: {
    protocol: async (_id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') return {};
      try { return { result: { value: await (0, eval)(params.expression as string) } }; }
      catch (error) { return { exceptionDetails: { exception: { description: `Error: ${(error as Error).message}` } } }; }
    },
  },
}));
const { automateBrowser } = await import('./browser-automation');

let hidden = false;
const native = () => calls.filter(call => call.method.startsWith('Input.')).map(call => call.method);
const run = async (action: Parameters<typeof automateBrowser>[1]) => (await automateBrowser('browser:t', action)).value as Record<string, unknown>;

beforeEach(() => {
  calls.length = 0; hidden = false;
  delete (window as unknown as Record<symbol, unknown>)[Symbol.for('boite.agent.v1')];
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  // jsdom lays nothing out: every element has a box and is visible unless display:none.
  Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value(this: HTMLElement) { return !this.closest('[style*="display: none"]'); } });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, toJSON: () => ({}) });
  document.elementFromPoint = () => document.querySelector('[data-target]');
  Element.prototype.scrollIntoView = () => {};
  window.scrollBy = () => {};
  document.body.innerHTML = `
    <h1>Shop</h1>
    <form id="f"><label>Name <input id="name"></label><button>Send</button></form>
    <select id="size"><option>Small</option><option value="l">Large</option></select>
    <label><input type="checkbox" id="gift" checked> Gift</label>
    <a href="https://shop.test/cart">Cart</a>
    <button id="ask" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
    <p>Free delivery</p>`;
});
afterEach(() => { vi.restoreAllMocks(); });

test('a snapshot lists the page as agent-browser does, with refs on what can be acted on', async () => {
  const full = await run({ kind: 'snapshot', urls: true });
  expect(full.text).toBe([
    '- heading "Shop" [ref=e1] [level=1]',
    '- form',
    '  - text: Name',
    '  - textbox "Name" [ref=e2]',
    '  - button "Send" [ref=e3]',
    '- combobox [ref=e4]: "Small" [options=["Small","Large"]]',
    '- checkbox "Gift" [ref=e5] [checked]',
    '- text: Gift',
    '- link "Cart" [ref=e6] [url=https://shop.test/cart]',
    '- button "Ask" [ref=e7]',
    '- text: Free delivery',
  ].join('\n'));
  const interactive = await run({ kind: 'snapshot', interactive: true });
  expect(interactive.text).not.toContain('text:');
  expect(interactive.refs).toBe(7);
});

test('a tab the desktop does not display is driven through DOM events, never native input that would hang', async () => {
  hidden = true;
  await run({ kind: 'snapshot', interactive: true });
  let submitted = 0;
  document.querySelector('#f')!.addEventListener('submit', event => { event.preventDefault(); submitted++; });
  await run({ kind: 'fill', selector: '@e2', text: 'Ada' });
  await run({ kind: 'type', selector: '@e2', text: ' L.' });
  expect((document.querySelector('#name') as HTMLInputElement).value).toBe('Ada L.');
  await run({ kind: 'press', key: 'Enter' });
  expect(submitted).toBe(1);
  await run({ kind: 'uncheck', selector: '@e5' });
  expect((document.querySelector('#gift') as HTMLInputElement).checked).toBe(false);
  expect(await run({ kind: 'select', selector: '@e4', values: ['Large'] })).toMatchObject({ value: ['Large'] });
  expect((document.querySelector('#size') as HTMLSelectElement).value).toBe('l');
  await expect(automateBrowser('browser:t', { kind: 'screenshot' })).rejects.toThrow('not displayed on the desktop');
  expect(native()).toEqual([]);
});

test('a displayed tab gets native input at the element, and a page dialog is answered and reported', async () => {
  await run({ kind: 'snapshot', interactive: true });
  document.querySelector('#ask')!.setAttribute('data-target', '');
  const clicked = run({ kind: 'click', selector: '@e7' });
  // jsdom has no compositor: the recorded native click stands for the page's own.
  await vi.waitFor(() => expect(native()).toContain('Input.dispatchMouseEvent'));
  (document.querySelector('#ask') as HTMLButtonElement).click();
  expect(await clicked).toMatchObject({ ok: true, dialogs: [{ type: 'confirm', message: 'Sure?', accepted: true }] });
  expect(calls.find(call => call.params.type === 'mousePressed')?.params).toMatchObject({ x: 60, y: 35, button: 'left' });
  await run({ kind: 'dialog', decision: 'dismiss' });
  (document.querySelector('#ask') as HTMLButtonElement).click();
  expect(document.querySelector('#ask')!.textContent).toBe('no');
});

test('a covered element is clicked through the DOM and says what covered it', async () => {
  await run({ kind: 'snapshot', interactive: true });
  document.querySelector('h1')!.setAttribute('data-target', '');
  let clicks = 0;
  document.querySelector('#ask')!.addEventListener('click', () => clicks++);
  expect(await run({ kind: 'click', selector: '@e7' })).toMatchObject({ note: expect.stringContaining('covered by h1') });
  expect(clicks).toBe(1);
  expect(native().filter(method => method === 'Input.dispatchMouseEvent')).toEqual([]);
});

test('refs tell a removed element and a page without a snapshot apart from a typo', async () => {
  await expect(run({ kind: 'click', selector: '@e1' })).rejects.toThrow('belongs to an earlier page');
  await run({ kind: 'snapshot' });
  document.querySelector('#ask')!.remove();
  await expect(run({ kind: 'click', selector: '@e7' })).rejects.toThrow('stale');
  await expect(run({ kind: 'click', selector: '@e70' })).rejects.toThrow('unknown ref @e70');
  await expect(run({ kind: 'click', selector: 'input' })).rejects.toThrow('matched 2');
  expect(await run({ kind: 'get', what: 'text', selector: 'text=Free' })).toBe('Free delivery');
});
