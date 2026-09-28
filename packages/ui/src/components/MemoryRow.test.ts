import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import MemoryRow from './MemoryRow.svelte';
import MessageList from './MessageList.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; localStorage.clear(); });

test.each(['killed', 'thread-cap', 'budget'] as const)('renders a %s system row with known process and size', kind => {
  mounted = mount(MemoryRow, { target: document.body, props: { event: { threadId: 't', kind, state: 'critical', exe: 'C:\\bin\\cargo.exe', bytes: 2147483648, at: 1 } } });
  flushSync();
  const row = document.querySelector('[data-testid=memory-row]')!;
  expect(row.textContent).toContain(strings.resources[kind === 'killed' ? 'killed' : kind === 'thread-cap' ? 'threadCap' : 'budget']);
  expect(row.textContent).toContain('cargo.exe'); expect(row.textContent).toContain('2.0 GB');
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
    await store.open('t-trace'); flushSync();
    expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(2);
  } finally { store.detach(); client.close(); }
});
