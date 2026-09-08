import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { QuestionAnswer } from '@boite/contracts';
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
  expect(query('[data-testid=question-cancelled]').textContent).toContain('turn ended');
  expect(options()[0]?.disabled).toBe(true);
});
