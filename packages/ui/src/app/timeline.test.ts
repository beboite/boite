import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { store } from '../lib/store.svelte';
import { count } from '../lib/format';
import { SEEDED_THINKING, STREAMED_TOOL_INPUT, query, sendPrompt, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('a thinking part is folded, opens on its toggle, and a new turn shows it before the answer', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  await waitFor(() => document.querySelector('[data-testid=thinking-part]') !== null);

  const toggle = query<HTMLButtonElement>('[data-testid=thinking-toggle]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  // The folded row names the thought: its first sentence, not the bare word.
  expect(query('[data-testid=thinking-label]').textContent).toContain(SEEDED_THINKING);
  expect(document.querySelector('[data-testid=thinking-text]')).toBeNull();

  toggle.click();
  await waitFor(() => document.querySelector('[data-testid=thinking-text]') !== null);
  expect(query('[data-testid=thinking-text]').textContent).toContain(SEEDED_THINKING);
  expect(query<HTMLButtonElement>('[data-testid=thinking-toggle]').getAttribute('aria-expanded')).toBe('true');

  // A new turn on the same thread: the reasoning part comes before the answer.
  const before = store.openThread?.messages.length ?? 0;
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'what the trace panel needs';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => (store.openThread?.messages.length ?? 0) === before + 2);
  const answer = store.openThread?.messages.at(-1);
  await waitFor(() => answer?.state === 'complete');
  expect(answer?.parts[0]).toEqual({
    type: 'thinking',
    text: 'thinking about: what the trace panel needs',
    startedAt: expect.any(Number), finishedAt: expect.any(Number)
  });
  expect(answer?.parts[1]).toEqual({ type: 'text', text: 'what the trace panel needs' });
  expect(document.querySelectorAll('[data-testid=thinking-part]').length).toBe(2);
});

test('an async question waits in the dock above the composer, stacked, and the timeline keeps a line to it', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  await sendPrompt('[ask] one');
  await waitFor(() => document.querySelectorAll('[data-testid=activity-question]').length === 1);
  await waitFor(() => store.openThread?.status === 'idle');
  // The composer answers the docked question until it is set aside for an ordinary prompt.
  query<HTMLButtonElement>('[data-testid=composer-reply-ignore]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-reply]') === null);
  query<HTMLButtonElement>('[data-testid=activity-question-toggle]').click();
  await waitFor(() => query('[data-testid=activity-question-toggle]').getAttribute('aria-expanded') === 'false');
  await sendPrompt('[ask] two');
  await waitFor(() => document.querySelectorAll('[data-testid=activity-question]').length === 2);
  expect(query('[data-testid=activity-question-toggle]').getAttribute('aria-expanded')).toBe('false');
  query<HTMLButtonElement>('[data-testid=activity-question-toggle]').click();
  await waitFor(() => query('[data-testid=activity-question-toggle]').getAttribute('aria-expanded') === 'true');

  // New arrivals leave the oldest up; the timeline holds a line per question, no card.
  expect(query('[data-testid=activity-question-index]').textContent).toBe('1 of 2');
  expect(document.querySelectorAll('[data-testid=question-docked]').length).toBe(2);
  expect(document.querySelector('[data-testid=timeline] [data-testid=question-card]')).toBeNull();
  const visible = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid=activity-question]')).filter((el) => !el.hidden);
  expect(visible().length).toBe(1);
  const oldest = visible()[0]?.dataset.question;
  query<HTMLButtonElement>('[data-testid=activity-question-next]').click();
  await waitFor(() => query('[data-testid=activity-question-index]').textContent === '2 of 2');
  expect(visible()[0]?.dataset.question).not.toBe(oldest);
  query<HTMLButtonElement>('[data-testid=activity-question-prev]').click();
  await waitFor(() => query('[data-testid=activity-question-index]').textContent === '1 of 2');
  expect(visible()[0]?.dataset.question).toBe(oldest);

  // Answered from the dock, it leaves it and folds to its answer in the timeline.
  const first = visible()[0]!;
  first.querySelector<HTMLButtonElement>('[data-testid=question-option]')?.click();
  await waitFor(() => !first.querySelector<HTMLButtonElement>('[data-testid=question-submit]')?.disabled);
  first.querySelector<HTMLButtonElement>('[data-testid=question-submit]')?.click();
  await waitFor(() => document.querySelectorAll('[data-testid=activity-question]').length === 1);
  expect(document.querySelector('[data-testid=activity-question-index]')).toBeNull();
  await waitFor(() => document.querySelectorAll('[data-testid=question-docked]').length === 1);

  // Folded, a click on its line in the timeline opens it again.
  query<HTMLButtonElement>('[data-testid=activity-question-toggle]').click();
  await waitFor(() => query('[data-testid=activity-question-toggle]').getAttribute('aria-expanded') === 'false');
  query<HTMLButtonElement>('[data-testid=question-docked]').click();
  await waitFor(() => query('[data-testid=activity-question-toggle]').getAttribute('aria-expanded') === 'true');

  // Passing the remaining question removes the dock without sending another prompt.
  await waitFor(() => store.openThread?.status === 'idle');
  const beforeSkip = await store.client!.call('threads.get', { threadId: store.openThread!.id });
  query<HTMLButtonElement>('[data-testid=question-skip]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=activity-question]').length === 0);
  expect(document.querySelector('[data-testid=question-docked]')).toBeNull();
  const afterSkip = await store.client!.call('threads.get', { threadId: beforeSkip.id });
  expect(afterSkip.turns).toEqual(beforeSkip.turns);
  expect(afterSkip.messages.filter(message => message.role === 'user')).toEqual(beforeSkip.messages.filter(message => message.role === 'user'));
});

test('a tool card stays folded while its input arrives and reveals parsed details on demand', async ({ app: _app }) => {

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'call [tool-stream] please';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => document.querySelector('[data-testid=tool-card][data-streaming=true]') !== null);
  const card = query('[data-testid=tool-card][data-streaming=true]');
  let samples = 0;
  while (card.dataset.streaming === 'true') {
    expect(card.querySelector('[data-testid=tool-toggle]')?.getAttribute('aria-expanded')).toBe('false');
    expect(card.querySelector('[data-testid=tool-input]')).toBeNull();
    expect(card.querySelector('.line')?.textContent).toBe('Running a command');
    samples++;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(samples).toBeGreaterThan(1);

  await waitFor(() => card.dataset.streaming === 'false');
  expect(card.querySelector('[data-testid=tool-toggle]')?.getAttribute('aria-expanded')).toBe('false');
  expect(card.querySelector('.disclosure-fold')?.classList.contains('open')).toBe(false);
  expect(card.querySelector('.line')?.textContent).toBe('Ran 1 command');

  card.querySelector<HTMLButtonElement>('[data-testid=tool-toggle]')?.click();
  await waitFor(() => card.querySelector('[data-testid=tool-input]') !== null);
  const shown = card.querySelector('[data-testid=tool-input]')?.textContent ?? '';
  expect(shown).toContain('"command": "echo streamed"');
  expect(shown).not.toBe(STREAMED_TOOL_INPUT);
});

test('a finished answer lists the files it changed, and a row opens one in the panel', async ({ app: _app }) => {

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'fix it [diff]';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  await waitFor(() => document.querySelector('[data-testid=turn-files]') !== null);
  // Folded: the count and the lines added and removed, the list on a click.
  const toggle = query<HTMLButtonElement>('[data-testid=turn-files-toggle]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.querySelector('[data-testid=turn-lines]')?.textContent).toBe('+2-1');
  expect(document.querySelector('[data-testid=turn-file-folder]')).toBeNull();
  toggle.click();
  await waitFor(() => document.querySelector('[data-testid=turn-file-folder]') !== null);
  const folder = query<HTMLButtonElement>('[data-testid=turn-file-folder]');
  expect(folder.textContent).toContain('src');
  expect(folder.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[data-testid=turn-file]')).toBeNull();
  folder.click();
  await waitFor(() => document.querySelector('[data-testid=turn-file]') !== null);
  expect(folder.getAttribute('aria-expanded')).toBe('true');
  query<HTMLButtonElement>('[data-testid=turn-files-expand]').click();
  await waitFor(() => query('[data-testid=turn-files-expand]').getAttribute('aria-label') === 'Collapse all folders');
  query<HTMLButtonElement>('[data-testid=turn-files-expand]').click();
  await waitFor(() => document.querySelector('[data-testid=turn-file]') === null);
  folder.click();
  await waitFor(() => document.querySelector('[data-testid=turn-file]') !== null);
  const row = query('[data-testid=turn-files] li[data-change]');
  expect(row.querySelector('.name')?.textContent).toBe('app.ts');
  expect(row.querySelector('[data-testid=turn-file-change]')?.textContent?.trim()).toBe('Changed');
  // A browser has no file manager to hand the path to.
  expect(row.querySelector('[data-testid=turn-file-reveal]')).toBeNull();

  row.querySelector<HTMLButtonElement>('[data-testid=turn-file]')?.click();
  await waitFor(() => document.querySelector('[data-testid=file-text]') !== null);
  expect(query('[data-testid=file-path]').textContent).toContain('src/app.ts');

  // A text file downloads as what the editor shows.
  const created: Blob[] = [];
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => { created.push(blob); return 'blob:turn-file'; };
  URL.revokeObjectURL = () => {};
  const click = HTMLAnchorElement.prototype.click;
  let downloaded = '';
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloaded = this.download; };
  try {
    query<HTMLButtonElement>('[data-testid=file-download-text]').click();
  } finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    HTMLAnchorElement.prototype.click = click;
  }
  expect(downloaded).toBe('app.ts');
  expect(await created[0]?.text()).toBe(query<HTMLTextAreaElement>('[data-testid=file-text]').value);
  store.panel.closeAll();
});

test('a tool card shows the diff, the markdown and the image it produced', async ({ app: _app }) => {

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'show me [diff] [doc] [image]';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();

  // Changes and produced documents keep their previews behind a disclosure.
  await waitFor(() => document.querySelectorAll('[data-testid=tool-document-chip]').length === 2);
  expect(
    Array.from(document.querySelectorAll('[data-testid=tool-document-chip]')).map((el) => el.textContent)
  ).toEqual(['1 doc', '1 doc']);
  expect(query('[data-testid=tool-diff-counts]').textContent?.replace(/\s+/g, ' ').trim()).toBe('+2 -1');
  expect(query('[data-testid=tool-card][data-family=edit] [data-testid=tool-toggle]').getAttribute('aria-expanded')).toBe('false');
  query<HTMLButtonElement>('[data-testid=tool-card][data-family=edit] [data-testid=tool-toggle]').click();
  flushSync();
  // A diff says it all: no raw input under it.
  expect(document.querySelector('[data-testid=tool-card][data-family=edit] [data-testid=tool-input]')).toBeNull();

  // Open every card that carries documents.
  for (const chip of Array.from(document.querySelectorAll('[data-testid=tool-document-chip]'))) {
    chip.closest('[data-testid=tool-card]')?.querySelector<HTMLButtonElement>('[data-testid=tool-toggle]')?.click();
  }
  await waitFor(() => document.querySelectorAll('[data-testid=tool-document]').length === 3);
  expect(
    Array.from(document.querySelectorAll('[data-testid=tool-document]')).map((el) => el.getAttribute('data-kind'))
  ).toEqual(['diff', 'markdown', 'image']);

  // The diff: one removed line and one added line, each on its own gutter.
  const diff = query('[data-testid=tool-document][data-kind=diff]');
  const gutters = Array.from(diff.querySelectorAll('[data-testid=diff-row]')).map(
    (row) => row.querySelector('.gutter')?.textContent ?? ''
  );
  expect(gutters).toContain('-');
  expect(gutters).toContain('+');
  expect(query('[data-testid=diff-row][data-kind=remove] .text').textContent).toContain('return start();');
  expect(query('[data-testid=diff-row][data-kind=add] .text').textContent).toContain('warm: true');

  // The markdown: its title above, its heading and its list rendered.
  const markdown = query('[data-testid=tool-document][data-kind=markdown]');
  expect(markdown.querySelector('.section-label')?.textContent).toBe('README.md');
  expect(markdown.querySelector('h3')?.textContent).toBe('README');
  expect(markdown.querySelector('li')?.textContent).toBe('the first item');

  // The image: a data url built from the base64, and the alt the core sent.
  const image = query<HTMLImageElement>('[data-testid=tool-document][data-kind=image] img');
  expect(image.getAttribute('src')?.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
  expect(image.alt).toBe('one pixel');
});
