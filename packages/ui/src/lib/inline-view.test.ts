import { afterEach, expect, test } from 'vitest';
import type { Message } from '@boite/contracts';
import { placeViews, viewPart, viewTheme } from './inline-view';

let at = 0;
const text = (id: string, turnId: string, role: Message['role'] = 'assistant'): Message =>
  ({ id, threadId: 't', turnId, role, state: 'complete', createdAt: ++at, parts: [{ type: 'text', text: id }] });
const view = (id: string, turnId: string, source: string): Message =>
  ({ id, threadId: 't', turnId, role: 'assistant', state: 'complete', createdAt: ++at, parts: [{ type: 'artifact', id: `a-${id}`, name: source.split('/').at(-1)!, mimeType: 'text/html', bytes: 10, view: { title: id, height: 300, source } }] });
const ids = (messages: Message[]) => messages.map((message) => message.id);
const idle = () => false;

afterEach(() => { document.documentElement.removeAttribute('style'); delete document.documentElement.dataset['motion']; });

test('a view is a message that is nothing but a published page', () => {
  expect(viewPart(view('v', 'turn', 'a.html'))?.view.title).toBe('v');
  expect(viewPart(text('m', 'turn'))).toBeNull();
  const file: Message = { ...view('f', 'turn', 'a.html'), parts: [{ type: 'artifact', id: 'a', name: 'a.html', mimeType: 'text/html', bytes: 10 }] };
  expect(viewPart(file)).toBeNull();
});

test('views are drawn after everything else their turn wrote, in the order they were published', () => {
  const plain = [text('u1', 'one', 'user'), text('a1', 'one')];
  expect(placeViews(plain, idle)).toBe(plain);
  // Published in the middle of the answer: a later part of the same turn was written after it.
  const timeline = [text('u1', 'one', 'user'), text('a1', 'one'), view('v1', 'one', 'orbit.html'), view('v2', 'one', 'bars.html'), text('a2', 'one'), text('u2', 'two', 'user'), text('b1', 'two')];
  expect(ids(placeViews(timeline, idle))).toEqual(['u1', 'a1', 'a2', 'v1', 'v2', 'u2', 'b1']);
});

test('a turn still running shows none of its views: they arrive with the finished answer', () => {
  const timeline = [text('u1', 'one', 'user'), text('a1', 'one'), view('v1', 'one', 'orbit.html'), text('u2', 'two', 'user'), view('v2', 'two', 'bars.html'), text('b1', 'two')];
  expect(ids(placeViews(timeline, (turn) => turn === 'two'))).toEqual(['u1', 'a1', 'v1', 'u2', 'b1']);
  expect(ids(placeViews(timeline, idle))).toEqual(['u1', 'a1', 'v1', 'u2', 'b1', 'v2']);
});

test('the same file published again in a turn takes the place of the earlier view', () => {
  const timeline = [text('u1', 'one', 'user'), view('v1', 'one', 'views/orbit.html'), view('v2', 'one', 'views/bars.html'), text('a1', 'one'), view('v3', 'one', 'views/orbit.html')];
  expect(ids(placeViews(timeline, idle))).toEqual(['u1', 'a1', 'v3', 'v2']);
  // In another turn it is another view.
  const later = [...timeline, text('u2', 'two', 'user'), text('b1', 'two'), view('v4', 'two', 'views/orbit.html')];
  expect(ids(placeViews(later, idle))).toEqual(['u1', 'a1', 'v3', 'v2', 'u2', 'b1', 'v4']);
});

test('a view whose turn has nothing else loaded keeps its own place', () => {
  const timeline = [view('v0', 'older', 'old.html'), view('v1', 'older', 'old.html'), text('u1', 'one', 'user'), text('a1', 'one')];
  expect(ids(placeViews(timeline, idle))).toEqual(['v1', 'u1', 'a1']);
  expect(ids(placeViews(timeline, (turn) => turn === 'older'))).toEqual(['u1', 'a1']);
});

test('a page is handed the tokens this device computes, and the reader\'s motion setting', () => {
  document.documentElement.style.setProperty('--color-foreground', '#ececf1');
  document.documentElement.style.setProperty('--font-sans', "'Inter', sans-serif");
  document.documentElement.style.setProperty('--titlebar', '44px');
  const theme = viewTheme();
  expect(theme.vars).toEqual({ '--color-foreground': '#ececf1', '--font-sans': "'Inter', sans-serif" });
  expect(theme.scheme).toBe('dark');
  expect(theme.reduced).toBeUndefined();
  document.documentElement.dataset['motion'] = 'reduced';
  expect(viewTheme().reduced).toBe(true);
});
