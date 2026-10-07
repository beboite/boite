import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { MessagePart } from '@boite/contracts';
import InlineView from './InlineView.svelte';
import { viewHeights } from '../lib/inline-view';
import type { Store } from '../lib/store.svelte';

let running: Record<string, unknown> | null = null;
afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  viewHeights.clear();
  vi.useRealTimers();
});

const part: Extract<MessagePart, { type: 'artifact' }> = {
  type: 'artifact', id: 'artifact-orbit', name: 'orbit.html', mimeType: 'text/html', bytes: 2048,
  view: { title: 'Orbit of the Moon', height: 420, narrowHeight: 610, source: '.boite/views/orbit.html' },
};

function show(readArtifact: Store['readArtifact']): { reads: ReturnType<typeof vi.fn> } {
  const reads = vi.fn(readArtifact);
  running = mount(InlineView, { target: document.body, props: { part, store: { readArtifact: reads } as unknown as Store, threadId: 't1', messageId: 'm1', partIndex: 0 } });
  flushSync();
  return { reads };
}
const served = (url: string): Store['readArtifact'] => async () => ({ ok: true, value: { url, name: 'orbit.html', bytes: 2048, mimeType: 'text/html' } });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); flushSync(); };
const frame = () => document.querySelector<HTMLIFrameElement>('[data-testid=inline-view-frame]');
const box = () => document.querySelector<HTMLElement>('[data-testid=inline-view]')!;
const stage = () => document.querySelector<HTMLElement>('[data-testid=inline-view-stage]')!;
const say = (data: unknown, source: unknown = frame()!.contentWindow) => { window.dispatchEvent(new MessageEvent('message', { data, source: source as MessageEventSource })); flushSync(); };

test('the page is framed on an opaque origin at the room the core measured, themed from its address, with no card around it', async () => {
  const { reads } = show(served('http://core.test/view/ticket-1'));
  expect(stage().style.height).toBe('420px');
  expect(frame()).toBeNull();
  await settle();
  expect(reads).toHaveBeenCalledWith('t1', 'm1', 'artifact-orbit', undefined, true);
  const shown = frame()!;
  expect(shown.getAttribute('sandbox')).toBe('allow-scripts');
  expect(shown.getAttribute('title')).toBe('Orbit of the Moon');
  expect(shown.getAttribute('referrerpolicy')).toBe('no-referrer');
  const [address, fragment] = shown.src.split('#');
  expect(address).toBe('http://core.test/view/ticket-1');
  expect(JSON.parse(decodeURIComponent(fragment!.replace('boite-view=', '')))).toMatchObject({ scheme: 'dark', vars: {} });
  // Nothing but the frame: no name, no size, no card, and no actions before the page is up.
  expect(box().textContent?.trim()).toBe('');
  expect(document.querySelector('[data-testid=chat-file]')).toBeNull();
  expect(document.querySelector('[data-testid=inline-view-replay]')).toBeNull();
  expect(shown.classList.contains('ready')).toBe(false);
});

test('the frame takes the height the page reports, shows once the page says it is up, and Play again loads it afresh', async () => {
  let ticket = 0;
  const { reads } = show(async () => ({ ok: true, value: { url: `http://core.test/view/ticket-${++ticket}`, name: 'orbit.html', bytes: 2048, mimeType: 'text/html' } }));
  await settle();
  // Another window's message, or one that is not the bootstrap's, moves nothing.
  say({ boiteView: 1, type: 'size', height: 900 }, window);
  say({ type: 'size', height: 900 });
  expect(stage().style.height).toBe('420px');
  say({ boiteView: 1, type: 'ready' });
  say({ boiteView: 1, type: 'size', height: 455.4 });
  expect(stage().style.height).toBe('455px');
  expect(box().dataset.ready).toBe('true');
  expect(frame()!.classList.contains('ready')).toBe(true);
  expect(viewHeights.get('artifact-orbit')).toBe(455.4);

  const first = frame()!.src;
  document.querySelector<HTMLButtonElement>('[data-testid=inline-view-replay]')!.click();
  flushSync();
  await settle();
  expect(reads).toHaveBeenCalledTimes(2);
  expect(frame()!.src).not.toBe(first);
  expect(frame()!.src.startsWith('http://core.test/view/ticket-2#')).toBe(true);
  // The room it already took is kept while the new frame loads.
  expect(stage().style.height).toBe('455px');
});

test('a link opens only from the frame the reader is in', async () => {
  const opened = vi.spyOn(window, 'open').mockReturnValue(null);
  show(served('http://core.test/view/ticket-1'));
  await settle();
  say({ boiteView: 1, type: 'ready' });
  say({ boiteView: 1, type: 'link', url: 'https://example.com/docs' });
  expect(opened).not.toHaveBeenCalled();
  say({ boiteView: 1, type: 'link', url: 'javascript:alert(1)' });
  expect(opened).not.toHaveBeenCalled();
  opened.mockRestore();
});

test('a page that cannot be loaded, never comes up or leaves its address becomes the file card, without an error', async () => {
  show(async () => ({ ok: false, error: 'the core refused' }));
  await settle();
  expect(document.querySelector('[data-testid=inline-view]')).toBeNull();
  expect(document.querySelector('[data-testid=chat-file]')?.textContent).toContain('orbit.html');
  expect(document.body.textContent).not.toContain('the core refused');
  expect(document.querySelector('[role=alert]')).toBeNull();
  unmount(running!, { outro: false }); running = null; document.body.innerHTML = '';

  vi.useFakeTimers();
  show(served('http://core.test/view/expired'));
  await settle();
  frame()!.dispatchEvent(new Event('load'));
  vi.advanceTimersByTime(2100); flushSync();
  expect(document.querySelector('[data-testid=inline-view]')).toBeNull();
  expect(document.querySelector('[data-testid=chat-file]')).not.toBeNull();
  unmount(running!, { outro: false }); running = null; document.body.innerHTML = '';
  vi.useRealTimers();

  show(served('http://core.test/view/ticket-1'));
  await settle();
  frame()!.dispatchEvent(new Event('load'));
  say({ boiteView: 1, type: 'ready' });
  expect(document.querySelector('[data-testid=inline-view]')).not.toBeNull();
  frame()!.dispatchEvent(new Event('load'));
  flushSync();
  expect(document.querySelector('[data-testid=inline-view]')).toBeNull();
  expect(document.querySelector('[data-testid=chat-file]')).not.toBeNull();
});
