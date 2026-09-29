import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import { setLocaleSetting } from '../lib/i18n.svelte';
import MemoryRow from './MemoryRow.svelte';
import MessageList from './MessageList.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; await setLocaleSetting('en'); document.body.innerHTML = ''; localStorage.clear(); });

test.each([['en', 'thread-quota'], ['en', 'budget'], ['en', 'machine'], ['fr', 'thread-quota'], ['fr', 'budget'], ['fr', 'machine']] as const)('renders a %s %s kill with its process, size and crossed limit', async (locale, reason) => {
  await setLocaleSetting(locale);
  mounted = mount(MemoryRow, { target: document.body, props: { event: { threadId: 't', kind: 'killed', reason, limitBytes: 9728 * 1048576, state: 'critical', exe: 'C:\\bin\\cargo.exe', bytes: 2147483648, at: 1 } } });
  flushSync();
  const row = document.querySelector('[data-testid=memory-row]')!;
  expect(row.querySelector('.title')?.textContent).toBe(strings.resources.killTitle);
  expect(row.querySelector('p')?.textContent).toBe(strings.resources.killReason[reason](locale === 'fr' ? '9,5 Go' : '9.5 GB'));
  expect(row.querySelector('.process')?.textContent).toBe('cargo.exe');
  expect(row.querySelector('.size')?.textContent).toBe(locale === 'fr' ? '2,0 Go' : '2.0 GB');
  expect(row.textContent).not.toContain('C:\\bin');
});

test('unknown process and size are omitted', () => {
  mounted = mount(MemoryRow, { target: document.body, props: { event: { threadId: 't', kind: 'thread-cap', state: 'ok', at: 1 } } });
  flushSync(); expect(document.querySelector('.details')).toBeNull();
});

test('thread history and live notices appear in the timeline and survive reopening', async () => {
  const client = new FakeClient({ delayMs: 0 }); const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    expect((await client.call('threads.list', {})).find(thread => thread.id === 't-trace')).not.toHaveProperty('memoryEvents');
    mounted = mount(MessageList, { target: document.body, props: { store, threadId: 't-trace', messages: store.openThread!.messages } });
    flushSync();
    expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(1);
    client.emitMemory({ threadId: 't-trace', kind: 'budget', state: 'critical', at: Date.now() });
    flushSync(); expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(2);
    store.openThread!.messages.push({ id: 'after-memory', threadId: 't-trace', turnId: 'after-memory', role: 'user', parts: [{ type: 'text', text: 'Continue after the memory warning' }], state: 'complete', createdAt: Date.now() + 1 });
    flushSync();
    const notice = [...document.querySelectorAll('[data-testid=memory-row]')].at(-1)!;
    expect(notice.closest('[data-testid=timeline]')).not.toBeNull();
    expect(notice.closest('article')?.nextElementSibling?.textContent).toContain('Continue after the memory warning');
    await store.open('t-trace'); flushSync();
    expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(2);
  } finally { store.detach(); client.close(); }
});
