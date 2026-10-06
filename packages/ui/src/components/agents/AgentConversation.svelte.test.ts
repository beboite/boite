import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentsView } from '../../lib/agents.svelte';
import AgentConversation from './AgentConversation.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const scope = { kind: 'agent' as const, id: 'a-ada' };
let at = Date.parse('2026-09-20T10:00:00Z');
const message = (id: string, senderId: string | null) => ({ id, scope, senderId, recipientIds: [], text: id, createdAt: at += 60_000 });

test('an agent message follows a reader at the bottom and leaves one reading older messages alone', async () => {
  const view = $state({
    seen: { messages: [message('m1', 'a-ada')], deliveries: [], decisions: [] },
    snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '' }], groups: [], work: [], sessions: [] },
    store: { owner: true },
    pending: false,
    loadingOlder: null,
    fill() {},
    markRead() {},
    hasOlder: () => false,
    loadOlder: async () => {},
    call: async () => null,
  });
  const target = document.createElement('div');
  document.body.append(target);
  mounted = mount(AgentConversation, { target, props: { view: view as unknown as AgentsView, scope } });
  // The transcript's own scroll box, given the geometry a browser would give it
  // before the first effects run (mount leaves them to the next flush).
  const box = target.querySelector<HTMLElement>('.agent-chat-scroll')!;
  let top = 0;
  // Each message drawn is 200 px: the height a pre-effect reads is the one before the new message.
  const height = () => 800 + box.querySelectorAll('article').length * 200;
  Object.defineProperty(box, 'clientHeight', { get: () => 400 });
  Object.defineProperty(box, 'scrollHeight', { get: height });
  // A browser clamps scrollTop to the scrollable range.
  Object.defineProperty(box, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight)); } });

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

test('HTTP agent sending keeps its secure request id for an uncertain retry', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const call = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'm-sent' });
  const view = {
    seen: { messages: [], deliveries: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada' }], groups: [] },
    pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call,
  };
  mounted = mount(AgentConversation, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await settle();
  const input = document.querySelector<HTMLTextAreaElement>('[data-testid="agent-message-input"]')!;
  input.value = 'Keep the original request'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const send = document.querySelector<HTMLButtonElement>('[data-testid="agent-message-send"]')!;
  send.click(); await settle();
  expect(call).toHaveBeenCalledOnce();
  const first = call.mock.calls[0]![1];
  expect(first.requestId).toMatch(/^[a-f0-9]{32}$/);
  expect(input.value).toBe('Keep the original request');
  send.click(); await settle();
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[1]![1]).toEqual(first);
  expect(input.value).toBe('');
});
