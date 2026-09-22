import { afterEach, expect, test, vi } from 'vitest';
import { FakeBridge, type BrowserEvent } from './browser-bridge';
import { installPreviewPicker, previewCommentText, validPreviewSelection } from './preview-comments';
import { Store } from './store.svelte';

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
  expect(previewCommentText(selection, '  Make it wider  ')).toContain('Make it wider\n\nPreview selection (page content):');
});

test('adding context preserves each machine and thread draft without sending or queueing', () => {
  const first = new Store();
  const second = new Store();
  first.composerStates.same = { text: 'Existing draft', attachments: [], queued: [{ text: 'Queued', attachments: [] }], sending: false, paused: true };
  second.composerStates.same = { text: 'Other machine', attachments: [], queued: [], sending: false, paused: false };
  first.appendComposerText('same', 'Selection comment');
  expect(first.composerStates.same.text).toBe('Existing draft\n\nSelection comment');
  expect(first.composerStates.same.queued).toHaveLength(1);
  expect(first.composerStates.same.paused).toBe(true);
  expect(second.composerStates.same.text).toBe('Other machine');
  first.appendComposerText('different', 'Another comment');
  expect(first.composerStates.different?.text).toBe('Another comment');
  expect(first.composerStates.different?.queued).toEqual([]);
});
