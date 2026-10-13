import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ThreadSummary } from '@boite/contracts';
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
    seen: { messages: [], deliveries: [], decisions: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '' }], groups: [], work: [], sessions: [] },
    store: { owner: true }, pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call,
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

/** A direct conversation holding one agent reply, from a run of `work`. */
function replyView(work: Record<string, unknown>, reply: Record<string, unknown> = {}, store: Record<string, unknown> = {}) {
  return {
    seen: {
      messages: [{ ...message('m-reply', 'a-ada'), text: 'Here it is.', replyTo: null, sourceRunId: 'r-1', ...reply }],
      deliveries: [], decisions: [], runs: [{ id: 'r-1', workId: 'w-1' }],
      work: [{ id: 'w-1', messageId: null, taskId: null, ...work }],
    },
    snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '' }], groups: [], work: [], sessions: [], routines: [] },
    store: { owner: true, threads: [], ...store }, pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call: async () => null,
  } as unknown as AgentsView;
}

test('an agent reply carries the files it attached, read from its own thread and message', async () => {
  const readArtifact = vi.fn(async () => ({ ok: true, value: { name: 'shot.png', mimeType: 'image/png', bytes: 2048, url: 'data:image/png;base64,iVBORw0KGgo=' } }));
  const part = { type: 'artifact', id: 'art-1', name: 'shot.png', mimeType: 'image/png', bytes: 2048 };
  const view = replyView({ purpose: 'work', messageId: 'm-ask' }, { replyTo: 'm-ask', files: [{ threadId: 't-agent', messageId: 'm-thread', part }] }, { readArtifact });
  mounted = mount(AgentConversation, { target: document.body, props: { view, scope } });
  await settle();
  const files = document.querySelector('[data-testid="agent-files"]');
  expect(files).not.toBeNull();
  expect(readArtifact).toHaveBeenCalledWith('t-agent', 'm-thread', 'art-1', undefined);
  // The picture draws inline with its zoom, inside the agent's reply.
  expect(files!.closest('.agent-message.from-agent')).not.toBeNull();
  expect(files!.querySelector('img[alt="shot.png"]')).not.toBeNull();
});

test('a notice about entrusted projects is labelled as one, not as a planned task', async () => {
  mounted = mount(AgentConversation, { target: document.body, props: { view: replyView({ purpose: 'notice' }), scope } });
  await settle();
  expect(document.querySelector('[data-testid="agent-notice"]')?.textContent).toContain('About your projects');
  expect(document.querySelector('[data-testid="agent-planned-result"]')).toBeNull();
});

test('the memory pass shows quietly under a reply: its summary on a tap, dimmed while it runs, nothing otherwise', async () => {
  const at = Date.now();
  mounted = mount(AgentConversation, { target: document.body, props: { view: replyView({ purpose: 'work', memory: { threadId: 't', status: 'done', summary: 'Noted your favourite colour.', at } }), scope } });
  await settle();
  const chip = document.querySelector<HTMLButtonElement>('[data-testid="agent-memory"] button')!;
  expect(chip.textContent).toContain('Memory updated');
  expect(chip.title).toBe('Noted your favourite colour.');
  expect(document.querySelector('[data-testid="agent-memory-summary"]')).toBeNull();
  chip.click(); await settle();
  expect(document.querySelector('[data-testid="agent-memory-summary"]')?.textContent).toBe('Noted your favourite colour.');
  await unmount(mounted); mounted = undefined;

  mounted = mount(AgentConversation, { target: document.body, props: { view: replyView({ purpose: 'work', memory: { threadId: 't', status: 'running', summary: null, at } }), scope } });
  await settle();
  expect(document.querySelector<HTMLElement>('[data-testid="agent-memory"]')?.dataset.status).toBe('running');
  expect(document.querySelector('[data-testid="agent-memory"]')?.textContent).toContain('Updating memory');
  for (const status of ['unchanged', 'error']) {
    await unmount(mounted); mounted = undefined;
    mounted = mount(AgentConversation, { target: document.body, props: { view: replyView({ purpose: 'work', memory: { threadId: 't', status, summary: null, at } }), scope } });
    await settle();
    expect(document.querySelector('[data-testid="agent-memory"]')).toBeNull();
  }
});

test('the agent at work shows no way into its thread from the conversation', async () => {
  const live = { id: 't-live', status: 'running' } as unknown as ThreadSummary;
  mounted = mount(AgentConversation, { target: document.body, props: { view: replyView({ purpose: 'work' }), scope, live } });
  await settle();
  expect(document.querySelector('[data-testid="agent-live"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="agent-live-open"]')).toBeNull();
});
