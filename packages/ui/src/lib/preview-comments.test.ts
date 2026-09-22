import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrowserSurface from '../components/BrowserSurface.svelte';
import { browserBridge, FakeBridge, type BrowserEvent } from './browser-bridge';
import { RightPanelStore } from './right-panel.svelte';
import { setExperiment } from './experiments';
import { strings } from './strings';
import { installPreviewPicker, previewReferenceLabel, validPreviewSelection } from './preview-comments';
import highlightPreviewElement from './preview-highlight.js';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';

afterEach(() => { document.body.innerHTML = ''; });

test('picking a page element captures context, prevents navigation, and removes its listeners', () => {
  document.body.innerHTML = '<main><a href="/elsewhere">Change this label</a></main>';
  const emit = vi.fn();
  installPreviewPicker(document, emit);
  const target = document.querySelector('a')!;
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(emit).toHaveBeenCalledOnce();
  expect(emit.mock.calls[0]?.[0]).toMatchObject({ selector: 'html > body > main > a', text: 'Change this label', url: document.URL });
  expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(emit).toHaveBeenCalledOnce();
});

test('Escape cancels selection without collecting page content', () => {
  const emit = vi.fn();
  installPreviewPicker(document, emit);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(emit).toHaveBeenCalledExactlyOnceWith(null);
  expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
});

test('open shadow roots report the clicked control rather than the retargeted host', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="shadow-save">Save inside shadow</button>';
  const target = shadow.querySelector('button')!;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 30, width: 80, height: 25 } as DOMRect);
  const emit = vi.fn();
  installPreviewPicker(document, emit);
  target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, composed: true }));
  expect(document.querySelector<HTMLElement>('[aria-hidden=true]')?.style.left).toBe('20px');
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
  expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    selector: '#shadow-save', text: 'Save inside shadow', bounds: { x: 20, y: 30, width: 80, height: 25 }
  }));
});

test('the second sibling in an open shadow root can be highlighted again and follows scrolling', () => {
  vi.useFakeTimers();
  try {
    const host = document.createElement('section');
    host.id = 'checkout';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>First</button><button>Second</button>';
    const target = shadow.querySelectorAll('button')[1]!;
    let left = 35;
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ x: left, y: 20, width: 60, height: 25 }) as DOMRect);
    const selected = vi.fn();
    installPreviewPicker(document, selected);
    target.dispatchEvent(new MouseEvent('click', { composed: true, bubbles: true, cancelable: true }));
    const reference = { ...selected.mock.calls[0]![0], id: 'second' };
    expect(reference.selector).toBe('button:nth-of-type(2)');
    expect(reference.shadowPath).toEqual(['#checkout']);
    const done = vi.fn();
    highlightPreviewElement(document, reference, done);
    expect(done).toHaveBeenCalledExactlyOnceWith(null);
    expect(document.querySelector<HTMLElement>('[data-boite-preview-highlight]')!.style.left).toBe('35px');
    left = 80;
    document.dispatchEvent(new Event('scroll'));
    expect(document.querySelector<HTMLElement>('[data-boite-preview-highlight]')!.style.left).toBe('80px');
    vi.advanceTimersByTime(3100);
    expect(document.querySelector('[data-boite-preview-highlight]')).toBeNull();
    highlightPreviewElement(document, { ...reference, url: 'https://other.test' }, done);
    expect(done).toHaveBeenLastCalledWith('stale');
    target.remove();
    highlightPreviewElement(document, reference, done);
    expect(done).toHaveBeenLastCalledWith('missing');
  } finally { vi.useRealTimers(); }
});

test('iframe bridge binds selections to the actual surface, cancels, and refuses inaccessible documents', () => {
  const bridge = new FakeBridge();
  const events: BrowserEvent[] = [];
  bridge.on(event => events.push(event));
  bridge.create('one', '');
  bridge.create('two', '');
  const frame = document.querySelector<HTMLIFrameElement>('[data-browser-id="one"]')!;
  frame.contentDocument!.body.innerHTML = '<button>Target</button>';
  bridge.annotate('one', 'request-one');
  // A message from an unrelated window has no receiver and cannot select.
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'selection', id: 'two' } }));
  frame.contentDocument!.querySelector('button')!.click();
  expect(events.filter(event => event.type === 'selection')).toEqual([
    expect.objectContaining({ id: 'one', requestId: 'request-one', selection: expect.objectContaining({ text: 'Target' }) })
  ]);
  bridge.annotate('one', 'cancelled');
  bridge.annotate('one', null);
  frame.contentDocument!.querySelector('button')!.click();
  expect(events.filter(event => event.type === 'selection')).toHaveLength(1);
  Object.defineProperty(frame, 'contentDocument', { get: () => null });
  bridge.annotate('one', 'blocked');
  expect(events.at(-1)).toEqual({ type: 'selection-failed', id: 'one', requestId: 'blocked', reason: 'inaccessible' });
  bridge.destroy('one'); bridge.destroy('two');
});

test('untrusted selection validation bounds URLs, text and geometry', () => {
  const selection = { url: 'https://example.test/page', selector: 'button', text: 'Save', bounds: { x: 10, y: 20, width: 80, height: 30 } };
  expect(validPreviewSelection(selection)).toBe(true);
  expect(validPreviewSelection({ ...selection, url: 'javascript:alert(1)' })).toBe(false);
  expect(validPreviewSelection({ ...selection, text: 'x'.repeat(1001) })).toBe(false);
  expect(validPreviewSelection({ ...selection, bounds: { ...selection.bounds, x: Infinity } })).toBe(false);
  expect(validPreviewSelection({ ...selection, bounds: { ...selection.bounds, width: -1 } })).toBe(false);
  expect(previewReferenceLabel({ ...selection, id: 'ref' })).toBe('@Save');
});

test('iframe picking reports invalid geometry and can pick again after failure', () => {
  const bridge = new FakeBridge();
  const events: BrowserEvent[] = [];
  bridge.on(event => events.push(event));
  bridge.create('invalid', '');
  try {
    const frame = document.querySelector<HTMLIFrameElement>('[data-browser-id="invalid"]')!;
    frame.contentDocument!.body.innerHTML = '<button>Target</button>';
    const target = frame.contentDocument!.querySelector('button')!;
    const rect = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ x: Infinity, y: 0, width: 80, height: 30 } as DOMRect);
    bridge.annotate('invalid', 'bad');
    target.click();
    expect(events.at(-1)).toEqual({ type: 'selection-failed', id: 'invalid', requestId: 'bad', reason: 'invalid' });
    rect.mockRestore();
    bridge.annotate('invalid', 'retry');
    target.click();
    expect(events.at(-1)).toMatchObject({ type: 'selection', id: 'invalid', requestId: 'retry', selection: { text: 'Target' } });
  } finally { bridge.destroy('invalid'); }
});

test('an invalid native selection settles the picker, reports failure and permits an immediate retry', async () => {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const panel = new RightPanelStore().for('t-trace');
  const surface = panel.open('browser', 'https://example.test');
  let handler: (event: BrowserEvent) => void = () => {};
  const subscription = vi.spyOn(browserBridge, 'on').mockImplementation(callback => { handler = callback; return () => {}; });
  const annotate = vi.spyOn(browserBridge, 'annotate').mockImplementation(() => {});
  setExperiment('preview-comments', true);
  const component = mount(BrowserSurface, { target: document.body, props: { store, panel, surface } });
  try {
    flushSync();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="preview-annotate"]')!;
    button.click();
    flushSync();
    const requestId = annotate.mock.calls.at(-1)![1]!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const selection = { url: `https://example.test/${'x'.repeat(4096)}`, selector: 'button', text: 'Target', bounds: { x: 0, y: 0, width: 80, height: 30 } };
    handler({ type: 'selection', id: surface.id, requestId, selection });
    flushSync();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.textContent).toContain(strings.previewComments.failed);
    expect(store.composerStates['t-trace']?.previewReferences ?? []).toEqual([]);
    button.click();
    flushSync();
    const retryId = annotate.mock.calls.at(-1)![1]!;
    expect(retryId).toBeTruthy();
    expect(retryId).not.toBe(requestId);
    handler({ type: 'selection', id: surface.id, requestId: retryId, selection: { ...selection, url: surface.url! } });
    flushSync();
    expect(store.composerStates['t-trace']?.previewReferences).toHaveLength(1);
  } finally {
    await unmount(component);
    setExperiment('preview-comments', false);
    subscription.mockRestore();
    annotate.mockRestore();
    store.detach();
    client.close();
  }
});

test('Escape in the address field cancels active picking and restores the current URL', async () => {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const panel = new RightPanelStore().for('t-trace');
  const surface = panel.open('browser', 'https://example.test');
  const annotate = vi.spyOn(browserBridge, 'annotate').mockImplementation(() => {});
  setExperiment('preview-comments', true);
  const component = mount(BrowserSurface, { target: document.body, props: { store, panel, surface } });
  try {
    flushSync();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="preview-annotate"]')!;
    const address = document.querySelector<HTMLInputElement>('[data-testid="browser-url"]')!;
    button.click();
    flushSync();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    address.focus();
    address.value = 'https://unsaved.test';
    address.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    flushSync();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(annotate).toHaveBeenLastCalledWith(surface.id, null);
    expect(address.value).toBe(surface.url);
    expect(document.activeElement).not.toBe(address);
    expect(store.composerStates['t-trace']?.previewReferences ?? []).toEqual([]);
  } finally {
    await unmount(component);
    setExperiment('preview-comments', false);
    annotate.mockRestore();
    store.detach();
    client.close();
  }
});

test('adding context preserves each machine and thread draft without sending or queueing', () => {
  const first = new Store();
  const second = new Store();
  first.composerStates.same = { text: 'Existing draft', attachments: [], queued: [{ text: 'Queued', attachments: [] }], sending: false, paused: true };
  second.composerStates.same = { text: 'Other machine', attachments: [], queued: [], sending: false, paused: false };
  const reference = { id: 'ref', url: 'https://example.test', selector: 'button', text: 'Save', bounds: { x: 0, y: 0, width: 1, height: 1 } };
  first.addPreviewReference('same', reference);
  expect(first.composerStates.same.text).toBe('Existing draft');
  expect(first.composerStates.same.previewReferences).toEqual([reference]);
  expect(first.composerStates.same.queued).toHaveLength(1);
  expect(first.composerStates.same.paused).toBe(true);
  expect(second.composerStates.same.text).toBe('Other machine');
  first.addPreviewReference('different', reference);
  expect(first.composerStates.different?.previewReferences).toEqual([reference]);
  expect(first.composerStates.different?.queued).toEqual([]);
});

test('accepted sends retry the same reference request and changed references receive a new request id', async () => {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const reference = { id: 'retry-ref', url: 'https://example.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const real = client.call.bind(client);
  const requests: string[] = [];
  let lose = true;
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await real(method, params);
    if (method === 'turns.start') {
      requests.push((params as { clientRequestId: string }).clientRequestId);
      if (lose) { lose = false; throw new Error('response lost'); }
    }
    return result;
  });
  try {
    expect(await store.send('Change it', 't-trace', [], [reference])).toBe(false);
    expect(await store.send('Change it', 't-trace', [], [reference])).toBe(true);
    expect(requests[0]).toBe(requests[1]);
    await client.settled();
    expect(await store.send('Change it', 't-trace', [], [{ ...reference, selector: '#other' }])).toBe(true);
    expect(requests[2]).not.toBe(requests[1]);
    expect(await store.send('/goal Change it', 't-trace', [], [reference])).toBe(false);
    expect(store.error).toContain('references');
  } finally { store.detach(); client.close(); }
});
