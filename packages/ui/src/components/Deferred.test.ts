import { afterEach, expect, test } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import Deferred from './Deferred.svelte';
import { LazyComponent } from '../lib/lazy-component.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

const child = createRawSnippet((word: () => string) => ({ render: () => `<b data-testid="part">${word()}</b>` }));
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  flushSync();
};
const query = (id: string) => document.querySelector(`[data-testid=${id}]`);

test('a part on its way says so, one that failed offers a retry, and the retry draws it', async () => {
  const pending: Array<{ resolve: (value: { default: string }) => void; reject: (error: Error) => void }> = [];
  const part = new LazyComponent(() => new Promise<{ default: string }>((resolve, reject) => { pending.push({ resolve, reject }); }));
  running = mount(Deferred<string>, { target: document.body, props: { part, children: child } });
  flushSync();
  expect(query('deferred-loading')?.getAttribute('role')).toBe('status');
  expect(query('part')).toBeNull();

  pending[0]!.reject(new Error('offline'));
  await settle();
  expect(query('deferred-loading')).toBeNull();
  expect(query('deferred-failed')?.getAttribute('role')).toBe('alert');

  (query('deferred-retry') as HTMLButtonElement).click();
  flushSync();
  expect(pending).toHaveLength(2);
  expect(query('deferred-loading')).not.toBeNull();
  pending[1]!.resolve({ default: 'diff' });
  await settle();
  expect(query('part')?.textContent).toBe('diff');
  expect(query('deferred-failed')).toBeNull();
});

test('a quiet part draws nothing until it lands, and asks again once the browser is back online', async () => {
  let calls = 0;
  const part = new LazyComponent<string>(() => (calls += 1) === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ default: 'face' }));
  running = mount(Deferred<string>, { target: document.body, props: { part, children: child, quiet: true } });
  await settle();
  expect(part.failed).toBe(true);
  expect(document.body.textContent).toBe('');

  window.dispatchEvent(new Event('online'));
  await settle();
  expect(calls).toBe(2);
  expect(query('part')?.textContent).toBe('face');
});
