import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Attachment, QuestionAnswer } from '@boite/contracts';
import QuestionCard from './QuestionCard.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

const OPTIONS = [
  { id: 'short', label: 'Short', description: 'one line back' },
  { id: 'long', label: 'Long' }
];

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

function options(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid=question-option]'));
}

function submit(): HTMLButtonElement {
  return query<HTMLButtonElement>('[data-testid=question-submit]');
}

test('an option turns Answer on, and what was picked goes out once', () => {
  const sent: { optionIds: string[]; text: string }[] = [];
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which shape should the echo take?',
      options: OPTIONS,
      allowText: true,
      multiple: false,
      answer: null,
      pending: true,
      submit: (optionIds: string[], text: string) => sent.push({ optionIds, text })
    }
  });
  flushSync();

  expect(query('[data-testid=question-card]').getAttribute('data-state')).toBe('pending');
  expect(options()).toHaveLength(2);
  // Nothing picked and nothing typed: there is nothing to send yet.
  expect(submit().disabled).toBe(true);

  options()[0]?.click();
  flushSync();
  expect(submit().disabled).toBe(false);
  expect(options()[0]?.getAttribute('aria-checked')).toBe('true');

  // One choice only: the second option replaces the first.
  options()[1]?.click();
  flushSync();
  expect(options()[0]?.getAttribute('aria-checked')).toBe('false');
  expect(options()[1]?.getAttribute('aria-checked')).toBe('true');

  const field = query<HTMLInputElement>('[data-testid=question-text-input]');
  field.value = 'the whole thing please';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  submit().click();
  flushSync();
  expect(sent).toEqual([{ optionIds: ['long'], text: 'the whole thing please' }]);

  // A second press changes nothing: the card is already answered.
  submit().click();
  flushSync();
  expect(sent).toHaveLength(1);
});

test('Skip sends no answer, prevents duplicate presses and allows retry after failure', async () => {
  const submit = vi.fn();
  let settle!: (accepted: boolean) => void;
  const skip = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
  running = mount(QuestionCard, {
    target: document.body,
    props: { text: 'Which shape?', options: OPTIONS, allowText: true, multiple: false, answer: null, pending: true, submit, skip }
  });
  flushSync();
  const button = query<HTMLButtonElement>('[data-testid=question-skip]');
  expect(button.disabled).toBe(false);
  options()[0]!.click();
  flushSync();
  button.click();
  button.click();
  flushSync();
  expect(skip).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  expect(button.disabled).toBe(true);
  settle(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect(button.disabled).toBe(false);
  expect(options()[0]!.getAttribute('aria-checked')).toBe('true');
  button.click();
  flushSync();
  expect(skip).toHaveBeenCalledTimes(2);
  settle(true);
});

test('typing alone is enough when the question allows text and offers nothing', () => {
  const sent: { optionIds: string[]; text: string }[] = [];
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'What should the branch be called?',
      options: [],
      allowText: true,
      multiple: false,
      answer: null,
      pending: true,
      submit: (optionIds: string[], text: string) => sent.push({ optionIds, text })
    }
  });
  flushSync();

  expect(options()).toHaveLength(0);
  expect(submit().disabled).toBe(true);

  const field = query<HTMLInputElement>('[data-testid=question-text-input]');
  field.value = 'feat/question-part';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  expect(submit().disabled).toBe(false);
  submit().click();
  flushSync();
  expect(sent).toEqual([{ optionIds: [], text: 'feat/question-part' }]);
});

test.each([false, true])('Enter sends a typed answer once, including async questions (%s)', (async) => {
  const sent: { optionIds: string[]; text: string }[] = [];
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which shape?', options: OPTIONS, allowText: true, multiple: false,
      async, answer: null, pending: true,
      submit: (optionIds: string[], text: string) => sent.push({ optionIds, text })
    }
  });
  flushSync();
  const field = query<HTMLInputElement>('[data-testid=question-text-input]');
  const enter = (init: KeyboardEventInit = {}) => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
    flushSync();
  };
  enter();
  expect(sent).toEqual([]);
  options()[0]?.click();
  field.value = ' one line please ';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  enter({ isComposing: true });
  expect(sent).toEqual([]);
  enter();
  enter();
  expect(sent).toEqual([{ optionIds: ['short'], text: 'one line please' }]);
});

test('several options are kept at once when the question takes several', () => {
  const sent: { optionIds: string[]; text: string }[] = [];
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which files should it read?',
      options: OPTIONS,
      allowText: false,
      multiple: true,
      answer: null,
      pending: true,
      submit: (optionIds: string[], text: string) => sent.push({ optionIds, text })
    }
  });
  flushSync();

  expect(document.querySelector('[data-testid=question-text-input]')).toBeNull();
  options()[0]?.click();
  options()[1]?.click();
  flushSync();
  submit().click();
  flushSync();
  expect(sent).toEqual([{ optionIds: ['short', 'long'], text: '' }]);
});

test('an answered card folds to one line and asks nothing more', () => {
  const answer: QuestionAnswer = { optionIds: ['short'], text: 'one line please' };
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which shape should the echo take?',
      options: OPTIONS,
      allowText: true,
      multiple: false,
      answer,
      pending: false,
      submit: () => undefined
    }
  });
  flushSync();

  expect(query('[data-testid=question-card]').getAttribute('data-state')).toBe('answered');
  expect(query('[data-testid=question-answer]').textContent).toBe('Short: one line please');
  expect(options()).toHaveLength(0);
  expect(document.querySelector('[data-testid=question-submit]')).toBeNull();
  const toggle = query<HTMLButtonElement>('[data-testid=question-toggle]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[data-testid=question-text]')).toBeNull();
  toggle.click();
  flushSync();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(query('[data-testid=question-text]').textContent).toBe('Which shape should the echo take?');
  toggle.click();
  flushSync();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(query('[data-testid=question-text]').closest<HTMLElement>('.fold')?.inert).toBe(true);
});

test('a question whose turn ended says so instead of offering a button', () => {
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which shape should the echo take?',
      options: OPTIONS,
      allowText: true,
      multiple: false,
      answer: null,
      pending: false,
      submit: () => undefined
    }
  });
  flushSync();

  expect(query('[data-testid=question-card]').getAttribute('data-state')).toBe('cancelled');
  expect(document.querySelector('[data-testid=question-submit]')).toBeNull();
  expect(query('[data-testid=question-cancelled]').textContent).toContain('No longer waiting');
  expect(options()[0]?.disabled).toBe(true);
});

test('a card asked without waiting says so until it is answered', () => {
  running = mount(QuestionCard, {
    target: document.body,
    props: { text: 'Which port?', options: OPTIONS, allowText: true, multiple: false, async: true, answer: null, pending: true, submit: () => {} }
  });
  flushSync();
  const card = query('[data-testid=question-card]');
  expect(card.getAttribute('data-async')).toBe('true');
  expect(card.textContent).toContain('Asks you, without waiting');
  expect(document.querySelector('[data-testid=question-async-hint]')).not.toBeNull();
});

test('a send that failed gives the card back, and a second press sends again', async () => {
  const sent: string[][] = [];
  let answer!: (delivered: boolean) => void;
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which shape should the echo take?',
      options: OPTIONS,
      allowText: true,
      multiple: false,
      answer: null,
      pending: true,
      submit: (optionIds: string[]) => {
        sent.push(optionIds);
        return new Promise<boolean>((resolve) => { answer = resolve; });
      }
    }
  });
  flushSync();
  options()[0]?.click();
  flushSync();
  submit().click();
  flushSync();
  // In flight: nothing can be pressed twice.
  expect(submit().disabled).toBe(true);
  expect(options()[0]?.disabled).toBe(true);

  answer(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  expect(submit().disabled).toBe(false);
  expect(options()[0]?.disabled).toBe(false);
  expect(options()[0]?.getAttribute('aria-checked')).toBe('true');

  submit().click();
  flushSync();
  expect(sent).toEqual([['short'], ['short']]);
  answer(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  expect(submit().disabled).toBe(true);
});

async function settle(until: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !until(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync();
  }
}

test('a photo goes with the answer: picked, pasted or dropped, shown, removable, and alone enough to answer', async () => {
  const sent: { optionIds: string[]; text: string; attachments: Attachment[] }[] = [];
  running = mount(QuestionCard, {
    target: document.body,
    props: {
      text: 'Which layout?',
      options: OPTIONS,
      allowText: true,
      multiple: false,
      answer: null,
      pending: true,
      submit: (optionIds: string[], text: string, attachments: Attachment[]) => sent.push({ optionIds, text, attachments })
    }
  });
  flushSync();
  expect(submit().disabled).toBe(true);
  const picker = query<HTMLInputElement>('[data-testid=question-file]');
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['png'], 'mockup.png', { type: 'image/png' })] });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(() => document.querySelectorAll('[data-testid=question-file-item]').length === 1);
  expect(query<HTMLImageElement>('[data-testid=question-file-item] img').alt).toBe('mockup.png');
  // A file alone answers the question.
  expect(submit().disabled).toBe(false);

  const field = query<HTMLInputElement>('[data-testid=question-text-input]');
  const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  const pasted = new File(['log'], 'trace.txt', { type: 'text/plain' });
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => pasted }] } });
  field.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  await settle(() => document.querySelectorAll('[data-testid=question-file-item]').length === 2);

  const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  const dropped = new File(['b'], 'second.png', { type: 'image/png' });
  const list = Object.assign([dropped], { item: (at: number) => [dropped][at] ?? null });
  Object.setPrototypeOf(list, FileList.prototype);
  Object.defineProperty(drop, 'dataTransfer', { value: { files: list, items: [{ kind: 'file' }] } });
  query('[data-testid=question-card]').dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
  await settle(() => document.querySelectorAll('[data-testid=question-file-item]').length === 3);

  query<HTMLButtonElement>('[data-testid=question-file-remove]').click();
  flushSync();
  expect(Array.from(document.querySelectorAll('[data-testid=question-file-item]')).map((item) => item.getAttribute('title'))).toEqual(['trace.txt', 'second.png']);

  submit().click();
  flushSync();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.optionIds).toEqual([]);
  expect(sent[0]!.attachments.map((one) => [one.kind, one.mimeType, one.name])).toEqual([
    ['file', 'text/plain', 'trace.txt'],
    ['image', 'image/png', 'second.png']
  ]);
});

test('a question without a free field takes no files', () => {
  running = mount(QuestionCard, {
    target: document.body,
    props: { text: 'Allow?', options: OPTIONS, allowText: false, multiple: false, answer: null, pending: true, submit: () => undefined }
  });
  flushSync();
  expect(document.querySelector('[data-testid=question-attach]')).toBeNull();
  const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], items: [] } });
  query('[data-testid=question-card]').dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(false);
});

test('an answer given with files lists them, and a files-only answer says how many', () => {
  const answer: QuestionAnswer = {
    optionIds: [],
    attachments: [
      { kind: 'image', mimeType: 'image/jpeg', name: 'IMG_0042.jpg', bytes: 420_000 },
      { kind: 'file', mimeType: 'text/plain', name: 'trace.txt', bytes: 3 }
    ]
  };
  running = mount(QuestionCard, {
    target: document.body,
    props: { text: 'Which layout?', options: OPTIONS, allowText: true, multiple: false, answer, pending: false, submit: () => undefined }
  });
  flushSync();
  expect(query('[data-testid=question-answer]').textContent).toBe('2 files');
  expect(query('[data-testid=question-answer-files]').getAttribute('title')).toBe('IMG_0042.jpg, trace.txt');
  query<HTMLButtonElement>('[data-testid=question-toggle]').click();
  flushSync();
  expect(query('.answer-detail').textContent).toContain('Files given: IMG_0042.jpg, trace.txt');
});