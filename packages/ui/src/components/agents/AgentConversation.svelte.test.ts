import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentsView } from '../../lib/agents.svelte';
import AgentConversation from './AgentConversation.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const scope = { kind: 'agent' as const, id: 'a-ada' };
let at = Date.parse('2026-09-20T10:00:00Z');
const message = (id: string, senderId: string | null) => ({ id, scope, senderId, recipientIds: [], text: id, createdAt: at += 60_000 });

test('an agent message follows a reader at the bottom and leaves one reading older messages alone', async () => {
  const view = $state({
    seen: { messages: [message('m1', 'a-ada')], deliveries: [] },
    snapshot: { profiles: [{ id: 'a-ada', name: 'Ada' }], groups: [] },
    pending: false,
    loadingOlder: null,
    fill() {},
    markRead() {},
    hasOlder: () => false,
    loadOlder: async () => {},
    call: async () => null,
  });
  // The transcript's scroll box, with the geometry a browser would give it.
  const box = document.createElement('div');
  document.body.append(box);
  let top = 0;
  // Each message drawn is 200 px: the height a pre-effect reads is the one before the new message.
  const height = () => 800 + box.querySelectorAll('article').length * 200;
  Object.defineProperty(box, 'clientHeight', { get: () => 400 });
  Object.defineProperty(box, 'scrollHeight', { get: height });
  // A browser clamps scrollTop to the scrollable range.
  Object.defineProperty(box, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight)); } });

  mounted = mount(AgentConversation, { target: box, props: { view: view as unknown as AgentsView, scope } });
  await settle();
  expect(top).toBe(600);

  // Reading older messages: the next reply does not pull the reader down.
  top = 100;
  view.seen.messages = [...view.seen.messages, message('m2', 'a-ada')];
  await settle();
  expect(top).toBe(100);

  // At the bottom: the next reply keeps the reader there.
  top = height() - 400;
  view.seen.messages = [...view.seen.messages, message('m3', 'a-ada')];
  await settle();
  expect(top).toBe(1000);

  // The user's own message always shows, wherever they were.
  top = 0;
  view.seen.messages = [...view.seen.messages, message('m4', null)];
  await settle();
  expect(top).toBe(1200);
});
