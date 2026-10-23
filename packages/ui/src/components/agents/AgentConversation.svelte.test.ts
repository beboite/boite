import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ThreadSummary } from '@boite/contracts';
import type { AgentsView } from '../../lib/agents.svelte';
import { store as realStore } from '../../lib/store.svelte';
import { strings } from '../../lib/strings';
import AgentConversation from './AgentConversation.svelte';

let mounted: ReturnType<typeof mount> | undefined;
// The composer measures its box, and jsdom has no ResizeObserver.
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The real store, since the conversation's box is the thread's own composer:
 * getters answer the given values and methods run the given functions.
 */
function useStore(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { owner: true, threads: [], connection: 'ready', ...overrides };
  // The store's members by name, getters and methods alike.
  const spy = vi.spyOn as unknown as (target: object, name: string, access?: 'get') => { mockImplementation(run: unknown): void; mockReturnValue(value: unknown): void };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'function') spy(realStore, name).mockImplementation(value);
    else spy(realStore, name, 'get').mockReturnValue(value);
  }
  return realStore;
}

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const scope = { kind: 'agent' as const, id: 'a-ada' };
let at = Date.parse('2026-09-20T10:00:00Z');
const message = (id: string, senderId: string | null) => ({ id, scope, senderId, recipientIds: [], text: id, createdAt: at += 60_000 });

test.each([null, 1])('a failed delivery reports whether the agent had started (%s)', async (startedAt) => {
  const work = { id: 'w-timeout', revision: 3, agentId: scope.id, scope, status: 'paused', runId: 'r-timeout', error: 'Execution time limit reached.' };
  const call = vi.fn(async () => null);
  const view = {
    seen: {
      messages: [message('m-timeout', null)],
      deliveries: [{ id: 'd-timeout', messageId: 'm-timeout', agentId: scope.id, workId: work.id, status: 'failed' }],
      decisions: [], runs: [{ id: work.runId, workId: work.id, startedAt, threadId: 't-timeout' }], work: [work],
    },
    snapshot: { profiles: [{ id: scope.id, name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [work], sessions: [] },
    store: useStore(), pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call,
  };
  mounted = mount(AgentConversation, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await settle();
  expect(document.querySelector('.from-user .failed')?.textContent ?? null).toBe(startedAt === null ? 'Ada did not get it' : null);
  expect(document.querySelector('[data-testid="receipt-responded"]')?.classList.contains('received')).toBe(startedAt !== null);
  const card = document.querySelector('[data-testid="agent-work-w-timeout"]');
  expect(card?.textContent).toContain('Execution time limit reached.');
  const resume = Array.from(card!.querySelectorAll('button')).find(b => b.textContent === strings.agents.resume)!;
  resume.click(); await settle();
  expect(call).toHaveBeenCalledWith('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'resume' });
});

test('an agent message follows a reader at the bottom and leaves one reading older messages alone', async () => {
  const view = $state({
    seen: { messages: [message('m1', 'a-ada')], deliveries: [], decisions: [] },
    snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [], sessions: [] },
    store: useStore(),
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
    seen: { messages: [], deliveries: [], decisions: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [], sessions: [] },
    store: useStore(), pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call,
  };
  mounted = mount(AgentConversation, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await settle();
  const input = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
  input.value = 'Keep the original request'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const send = document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!;
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
    snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [], sessions: [], routines: [] },
    store: useStore(store), pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call: async () => null,
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

test('a question the agent asked in its hidden session thread stands in its conversation and answers through the store', async () => {
  const answerQuestion = vi.fn(async () => true);
  const asked = (id: string, threadId: string) => ({ id, threadId, turnId: 'turn-1', text: `Which port? ${id}`, options: [{ id: '1', label: '5173' }, { id: '2', label: '4173' }], allowText: true, multiple: false, async: true, createdAt: 1 });
  const view = replyView({ purpose: 'work' }, {}, { answerQuestion, pendingQuestions: [asked('q-own', 't-ada'), asked('q-group', 't-group'), asked('q-other', 't-user')] });
  // Ada's session of this conversation, and another of hers in a group.
  view.snapshot!.sessions = [
    { id: 's-1', agentId: 'a-ada', scope, threadId: 't-ada' },
    { id: 's-2', agentId: 'a-ada', scope: { kind: 'group', id: 'g-1' }, threadId: 't-group' },
  ] as never;
  mounted = mount(AgentConversation, { target: document.body, props: { view, scope } });
  await settle();
  const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="agent-question"]')];
  expect(cards.map(card => card.dataset.question)).toEqual(['q-own']);
  expect(cards[0]!.textContent).toContain('Ada asks you');
  (document.querySelector('[data-testid="agent-question-text"]') as HTMLInputElement).value = 'the free one';
  document.querySelector('[data-testid="agent-question-text"]')!.dispatchEvent(new Event('input'));
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="agent-question-send"]')!.click();
  await settle();
  expect(answerQuestion).toHaveBeenLastCalledWith('t-ada', 'q-own', [], 'the free one');
  document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-question-option"]')[1]!.click();
  await settle();
  // Once answered the card only waits to leave the list: a second press sends nothing.
  expect(answerQuestion).toHaveBeenCalledOnce();
});

test('the conversation types into the thread composer: attach, dictation and the agent\'s model chips stay, the worktree and plan chips go', async () => {
  const call = vi.fn().mockResolvedValue({ id: 'm-sent' });
  const view = {
    seen: { messages: [], deliveries: [], decisions: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [], sessions: [] },
    store: useStore(), pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call,
  };
  mounted = mount(AgentConversation, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await settle();
  const composer = document.querySelector('.agent-chat [data-testid="composer"]')!;
  expect(composer).not.toBeNull();
  expect(composer.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.placeholder).toBe('Message Ada');
  expect(composer.querySelector('[data-testid="composer-attach"]')).not.toBeNull();
  // The microphone, or its stand-in while its chunk loads.
  expect(composer.querySelector(`[data-testid="dictation"], button[aria-label="${strings.speech.start}"]`)).not.toBeNull();
  // The agent's model and mode, where a thread's are; a thread's worktree and the old Plan chip stay out.
  for (const shown of ['composer-picker', 'composer-mode']) expect(composer.querySelector(`[data-testid="${shown}"]`)).not.toBeNull();
  for (const gone of ['agent-schedule-message', 'composer-worktree']) expect(composer.querySelector(`[data-testid="${gone}"]`)).toBeNull();
  expect(document.querySelector('[data-testid="agent-message-input"]')).toBeNull();
  // A picture goes with the words to the agent.
  const picture = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' } as const;
  realStore.composerStates['agent:agent:a-ada'] = { text: 'Look at this', attachments: [picture], queued: [], sending: false, paused: false };
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
  await settle();
  expect(call).toHaveBeenCalledWith('agents.message.send', expect.objectContaining({ scope, text: 'Look at this', recipientIds: ['a-ada'], attachments: [picture] }));
  expect(realStore.composerStates['agent:agent:a-ada']).toMatchObject({ text: '', attachments: [] });
  delete realStore.composerStates['agent:agent:a-ada'];
});

test('a retry keeps its request id only for the same bytes: another file of the same size is a new message', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const call = vi.fn().mockResolvedValue(null);
  const view = {
    seen: { messages: [], deliveries: [], decisions: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [], sessions: [] },
    store: useStore(), pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call,
  };
  mounted = mount(AgentConversation, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await settle();
  const file = (text: string) => ({ kind: 'file', mimeType: 'text/plain', data: btoa(text), name: 'notes.txt' } as const);
  const sendWith = async (attachment: ReturnType<typeof file>) => {
    realStore.composerStates['agent:agent:a-ada'] = { text: 'Read it', attachments: [attachment], queued: [], sending: false, paused: false };
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await settle();
  };
  await sendWith(file('first'));
  await sendWith(file('first'));
  await sendWith(file('other'));
  const ids = call.mock.calls.map(c => (c[1] as { requestId: string }).requestId);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
  delete realStore.composerStates['agent:agent:a-ada'];
});

test('the chips pick the agent\'s own mode, saved as its Settings tab saves it, even while a message is being sent; a paired device sees none', async () => {
  const selection = { providerId: 'claude', accountId: 'acc-ada', model: 'opus', effort: null, permissionMode: 'default' };
  const config = { defaultRoute: selection, allowedRoutes: [{ ...selection, id: 'default', name: 'Default' }], subagents: { enabled: true, paused: false, profiles: [], anyModel: true }, compactAfterTurns: 12, maxRunMinutes: 10, autoMemory: true };
  const call = vi.fn(async (method: string, _params?: unknown) => method === 'agents.runtime.get' ? structuredClone(config) : { id: 'a-ada' });
  const view = (owner: boolean) => {
    // As the page: saves wait in one queue, and each refreshes the snapshot, the agent's revision with it.
    let saves = Promise.resolve();
    const v = {
      seen: { messages: [], deliveries: [], decisions: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', revision: 7, selection }], groups: [], work: [], sessions: [] },
      store: useStore({ owner, client: { call } }), pending: true, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {},
      // A message is on its way: the page's one-shot calls are refused until it lands.
      call: vi.fn(async () => null),
      save(method: string, params: () => Promise<unknown>) {
        const run = saves.then(async () => { const result = await call(method, await params()); v.snapshot.profiles[0]!.revision++; return result; });
        saves = run.then(() => undefined, () => undefined);
        return run;
      },
    };
    return v as unknown as AgentsView;
  };
  mounted = mount(AgentConversation, { target: document.body, props: { view: view(true), scope } });
  await settle();
  const pickMode = async (mode: string) => {
    document.querySelector<HTMLButtonElement>('[data-testid="composer-mode"]')!.click();
    await settle();
    document.querySelector<HTMLButtonElement>(`[data-testid="composer-mode-menu"] [data-value="${mode}"]`)!.click();
    await settle();
  };
  await pickMode('acceptEdits');
  expect(call).toHaveBeenCalledWith('agents.runtime.get', { agentId: 'a-ada' });
  expect(call).toHaveBeenLastCalledWith('agents.runtime.configure', { agentId: 'a-ada', expectedRevision: 7, config: { ...config, defaultRoute: { ...selection, permissionMode: 'acceptEdits' } } });
  // The next pick reads the revision the first save left, not the one the chips were drawn with.
  await pickMode('bypassPermissions');
  expect(call).toHaveBeenLastCalledWith('agents.runtime.configure', expect.objectContaining({ expectedRevision: 8 }));
  await unmount(mounted);
  mounted = mount(AgentConversation, { target: document.body, props: { view: view(false), scope } });
  await settle();
  for (const gone of ['composer-picker', 'composer-mode']) expect(document.querySelector(`[data-testid="${gone}"]`)).toBeNull();
});

test('a picture the user sent shows as a thread\'s does once the agent\'s turn holds it, and opens its original', async () => {
  const data = 'iVBORw0KGgo=';
  const loadMessageAttachment = vi.fn(async () => data);
  const loadDisplayImage = vi.fn(async () => `data:image/png;base64,${data}`);
  const source = { threadId: 't-agent', messageId: 'm-prompt', partIndex: 1 };
  const sent = { ...message('m-sent', null), text: 'Look', attachments: [{ kind: 'image', mimeType: 'image/png', name: 'shot.png', bytes: 8, source }] };
  const waiting = { ...message('m-waiting', null), text: 'And this', attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'notes.txt', bytes: 5 }] };
  const view = {
    seen: { messages: [sent, waiting], deliveries: [], decisions: [] }, snapshot: { profiles: [{ id: 'a-ada', name: 'Ada', avatar: '', selection: { accountId: 'acc-ada' } }], groups: [], work: [], sessions: [] },
    store: useStore({ loadMessageAttachment, loadDisplayImage }), pending: false, loadingOlder: null, fill() {}, markRead() {}, hasOlder: () => false, loadOlder: async () => {}, call: async () => null,
  } as unknown as AgentsView;
  mounted = mount(AgentConversation, { target: document.body, props: { view, scope } });
  await settle();
  const [first, second] = [...document.querySelectorAll('[data-testid="agent-user-message"]')];
  // The thread's own row of thumbnails, under the words, read from the agent's thread.
  expect(first!.querySelector('[data-testid="message-images"]')).not.toBeNull();
  expect(first!.querySelector('[data-testid="agent-attachment"]')).toBeNull();
  first!.querySelector<HTMLButtonElement>('[data-testid="image-open"]')!.click();
  await settle();
  expect(loadMessageAttachment).toHaveBeenCalledWith('t-agent', 'm-prompt', 1);
  await vi.waitFor(() => expect(document.querySelector('[data-testid="image-viewer"] img')?.getAttribute('src')).toBe(`data:image/png;base64,${data}`));
  // Before a turn took them, their names and sizes.
  expect(second!.querySelector('[data-testid="message-images"]')).toBeNull();
  expect(second!.querySelector('[data-testid="agent-attachment"]')?.textContent).toContain('notes.txt');
});
