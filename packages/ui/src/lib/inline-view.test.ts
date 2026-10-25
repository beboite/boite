import { afterEach, expect, test } from 'vitest';
import type { Message } from '@boite/contracts';
import { answerPieces, placeViews, placedPath, turnViews, viewAt, viewPart, viewTheme, ViewPlacement } from './inline-view';

let at = 0;
const text = (id: string, turnId: string, role: Message['role'] = 'assistant', body = id): Message =>
  ({ id, threadId: 't', turnId, role, state: 'complete', createdAt: ++at, parts: [{ type: 'text', text: body }] });
const view = (id: string, turnId: string, source: string): Message =>
  ({ id, threadId: 't', turnId, role: 'assistant', state: 'complete', createdAt: ++at, parts: [{ type: 'artifact', id: `a-${id}`, name: source.split('/').at(-1)!, mimeType: 'text/html', bytes: 10, view: { title: id, height: 300, source } }] });
const ids = (messages: Message[]) => messages.map((message) => message.id);
const idle: { id: string; status: 'done' }[] = [];
const live = (id: string) => [{ id, status: 'running' as const }, { id: 'another', status: 'done' as const }];

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
  expect(ids(placeViews(timeline, live('two')))).toEqual(['u1', 'a1', 'v1', 'u2', 'b1']);
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
  expect(ids(placeViews(timeline, live('older')))).toEqual(['u1', 'a1']);
});

test('a line of its own naming a file as an image places a view, and nothing else does', () => {
  expect(placedPath('![Orbit](.boite/views/orbit.html)')).toBe('.boite/views/orbit.html');
  expect(placedPath('  ![](<views/two words.html>)  ')).toBe('views/two words.html');
  for (const line of ['See ![Orbit](orbit.html)', '![Orbit](orbit.html) here', '[Orbit](orbit.html)', '    ![Orbit](orbit.html)', '![Orbit](two words.html)']) expect(placedPath(line)).toBeNull();
  expect(answerPieces(['Plain.', 'A [link](https://example.com).'])).toBeNull();
  const pieces = answerPieces([
    'Intro.',
    'Above\n![Orbit](orbit.html)\nUnder',
    '```md\n![Shown](code.html)\n```',
    '![Bars](bars.html)',
  ]);
  expect(pieces).toEqual([
    { kind: 'text', key: '0', block: 'Intro.' },
    { kind: 'text', key: '1.0', block: 'Above' },
    { kind: 'view', key: '1.1', path: 'orbit.html', line: '![Orbit](orbit.html)' },
    { kind: 'text', key: '1.2', block: 'Under' },
    // In a fence it is code an answer quotes.
    { kind: 'text', key: '2', block: '```md\n![Shown](code.html)\n```' },
    { kind: 'view', key: '3.1', path: 'bars.html', line: '![Bars](bars.html)' },
  ]);
});

test('a placing line finds its view by the path the command printed, or a longer or shorter one', () => {
  const views = [view('v1', 'one', '.boite/views/orbit.html'), view('v2', 'one', 'notes/orbit.html'), view('v3', 'one', 'bars.html')];
  expect(viewAt(views, '.boite/views/orbit.html')?.id).toBe('v1');
  expect(viewAt(views, './notes/orbit.html')?.id).toBe('v2');
  expect(viewAt(views, '/home/me/project/.boite/views/orbit.html')?.id).toBe('v1');
  expect(viewAt(views, 'orbit.html')?.id).toBe('v1');
  expect(viewAt(views, 'views/bars.html')?.id).toBe('v3');
  expect(viewAt(views, 'my%20bars.html')).toBeNull();
  expect(viewAt(views, 'gone.html')).toBeNull();
});

test('a view its answer places is drawn there, even while the turn runs, and the others still go after the answer', () => {
  const answer = text('a1', 'one', 'assistant', 'The orbit:\n\n![Orbit](.boite/views/orbit.html)\n\nAnd that is all.\n\n```\n![Bars](bars.html)\n```');
  const timeline = [text('u1', 'one', 'user'), view('v1', 'one', '.boite/views/orbit.html'), view('v2', 'one', 'bars.html'), answer];
  const views = turnViews(timeline);
  expect(views.get('one')?.map((message) => message.id)).toEqual(['v1', 'v2']);
  // The same views keep the same array from one timeline to the next; another publish makes a new one.
  expect(turnViews([...timeline], views).get('one')).toBe(views.get('one'));
  expect(turnViews([...timeline, view('v4', 'one', 'bars.html')], views).get('one')?.map((message) => message.id)).toEqual(['v1', 'v4']);
  expect(ids(placeViews(timeline, idle, views))).toEqual(['u1', 'a1', 'v2']);
  expect(ids(placeViews(timeline, live('one'), views))).toEqual(['u1', 'a1']);
  // A streamed answer grows the same part in place: the line written last still places its page.
  const growing = text('a2', 'two', 'assistant', 'Bars first.');
  const second = [text('u2', 'two', 'user'), view('v3', 'two', 'bars.html'), growing];
  expect(ids(placeViews(second, idle))).toEqual(['u2', 'a2', 'v3']);
  const part = growing.parts[0]!;
  if (part.type === 'text') part.text += '\n\n![Bars](bars.html)';
  expect(ids(placeViews(second, idle))).toEqual(['u2', 'a2']);
  // A view of another turn is not this answer's to place.
  const later = [...timeline, text('u2', 'two', 'user'), text('b1', 'two', 'assistant', '![Bars](bars.html)')];
  expect(ids(placeViews(later, idle))).toEqual(['u1', 'a1', 'v2', 'u2', 'b1']);
});

test('view placement keeps the window until a streamed line, turn state or publish moves a view', () => {
  const placement = new ViewPlacement();
  const answer = text('a', 'one', 'assistant', 'Chart follows.');
  const timeline = [view('v', 'one', 'chart.html'), answer];
  const initial = placement.build(timeline, idle);
  const part = answer.parts[0]!;
  if (part.type !== 'text') throw new Error('expected text');
  part.text += ' More text.';
  expect(placement.build(timeline, idle)).toBe(initial);
  expect(placement.build(timeline, live('one'))).toEqual([answer]);
  expect(placement.build(timeline, idle)).toEqual(initial);

  part.text += '\n\n![Chart](chart.html)';
  const inline = placement.build(timeline, idle);
  expect(inline).toEqual([answer]);
  expect(inline).not.toBe(initial);
  part.text += '\n\nStill writing.';
  expect(placement.build(timeline, idle)).toBe(inline);
  // A refreshed page with a new object must reach the window too.
  const replacement = { ...answer };
  expect(placement.build([timeline[0]!, replacement], idle)).toEqual([replacement]);
  expect(placement.build([timeline[0]!, replacement], idle)).not.toBe(inline);
  part.text = 'No placement line.';
  const published = view('v-new', 'one', 'chart.html');
  expect(placement.build([...timeline, published], idle)).toEqual([answer, published]);
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
