import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message, QuestionRequest, RequestableKey } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import SettingRequestCard from './SettingRequestCard.svelte';
import { workspace, type Machine } from '../lib/workspace.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

async function setup(): Promise<{ client: FakeClient; store: Store }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  return { client, store };
}

function card(store: Store, question: QuestionRequest): void {
  mounted = mount(SettingRequestCard, {
    target: document.body,
    props: {
      store,
      text: question.text,
      setting: question.setting!,
      answer: null,
      pending: true,
      respond: (optionId: 'refuse' | 'open') => store.answerQuestion(question.threadId, question.id, [optionId])
    }
  });
  flushSync();
}

async function asked(store: Store, id: string): Promise<QuestionRequest> {
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === id)).toBe(true));
  return store.pendingQuestions.find((question) => question.id === id)!;
}

test('Apply writes the setting through settings.set, the card closes as applied and the agent is told', async () => {
  const { client, store } = await setup();
  try {
    const { questionId } = await client.call('settings.request', { threadId: 't-trace', reason: 'Builds stall under the cap', key: 'agentCpuCapPercent', value: 60 });
    card(store, await asked(store, questionId));

    expect(query('[data-testid=setting-reason]').textContent).toBe('Builds stall under the cap');
    expect(query('[data-testid=setting-previous]').textContent).toBe('75%');
    expect(query('[data-testid=setting-proposed]').textContent).toBe('60%');
    expect(query('[data-testid=setting-place]').textContent).toBe('Protection › Resource limits');

    query<HTMLButtonElement>('[data-testid=setting-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    expect((await client.call('settings.get', {})).agentCpuCapPercent).toBe(60);
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === '> Builds stall under the cap\n\napplied: agentCpuCapPercent is now 60'))).toBe(true));

    // The timeline keeps one quiet row saying what it came to.
    await unmount(mounted!);
    const host = store.openThread!.messages.find((message) => message.parts.some((part) => part.type === 'question' && part.questionId === questionId)) as Message;
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: host.threadId, message: host, signedOut: null, showModel: false } });
    // The timeline loads the card with the first one it draws.
    await vi.waitFor(() => expect(document.querySelector('[data-testid=setting-card]')).not.toBeNull());
    expect(query('[data-testid=setting-card]').getAttribute('data-outcome')).toBe('applied');
    expect(query('[data-testid=setting-subject]').textContent).toBe('CPU cap for all agents: 60%');
  } finally {
    store.detach();
    client.close();
  }
});

test('a sensitive switch is flipped in the card, with its warning, and the agent is told', async () => {
  const { client, store } = await setup();
  try {
    const { questionId } = await client.call('settings.request', { threadId: 't-trace', reason: 'A window keeps hiding', key: 'focusGuard', value: false });
    card(store, await asked(store, questionId));

    // The switch itself, showing the value now: no Apply, no trip to Settings.
    expect(document.querySelector('[data-testid=setting-apply]')).toBeNull();
    expect(document.querySelector('[data-testid=setting-delta]')).toBeNull();
    expect(query('[data-testid=setting-sensitive-hint]')).toBeTruthy();
    const toggle = query<HTMLInputElement>('[data-testid=setting-switch]');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.checked).toBe(true);
    expect(document.getElementById(toggle.getAttribute('aria-labelledby')!)?.textContent).toBe('Keep agent windows out of the foreground');

    toggle.click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    expect((await client.call('settings.get', {})).focusGuard).toBe(false);
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === '> A window keeps hiding\n\napplied: focusGuard is now false'))).toBe(true));
  } finally {
    store.detach();
    client.close();
  }
});

test('Show in Settings opens the card it names without answering, and Refuse tells the agent', async () => {
  const { client, store } = await setup();
  try {
    const { questionId } = await client.call('settings.request', { threadId: 't-trace', reason: 'Fewer threads at once', key: 'agentCpuCapPercent', value: 40 });
    card(store, await asked(store, questionId));

    query<HTMLButtonElement>('[data-testid=setting-show]').click();
    flushSync();
    expect(store.page).toBe('settings');
    expect(store.settingsTab).toBe('resources');
    expect(store.settingsSection).toMatchObject({ id: 'limits', flash: true });
    // Opening the page answers nothing: the card waits for the setting to move.
    expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(true);

    query<HTMLButtonElement>('[data-testid=setting-refuse]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === '> Fewer threads at once\n\nrefused: agentCpuCapPercent stays 75'))).toBe(true));
    expect((await client.call('settings.get', {})).agentCpuCapPercent).toBe(75);
  } finally {
    store.detach();
    client.close();
  }
});

test('the app tells its core the language and experiments it has, and an experiment card flips this device\'s switch', async () => {
  localStorage.setItem('boite.experiments', JSON.stringify(['resident-agents']));
  const { client, store } = await setup();
  try {
    // The agent reads what the user sees: on, and named as the Experiments page names it.
    await vi.waitFor(async () => expect((await client.call('agent.settings', { threadId: 't-trace' })).app).toEqual({ language: 'en', device: null, client: null }));
    const read = await client.call('agent.settings', { threadId: 't-trace' });
    expect(read.settings.find((reading) => reading.key === 'experiment.resident-agents')).toMatchObject({ value: true, label: 'Bots', page: 'experiments', section: 'resident-agents' });
    await expect(client.call('settings.request', { threadId: 't-trace', reason: 'x', key: 'experiment.resident-agents', value: true })).rejects.toThrow('already true');

    const { questionId } = await client.call('settings.request', { threadId: 't-trace', reason: 'Try the whip', key: 'experiment.whip', value: true });
    card(store, await asked(store, questionId));
    const toggle = query<HTMLInputElement>('[data-testid=setting-switch]');
    expect(toggle.checked).toBe(false);
    expect(document.getElementById(toggle.getAttribute('aria-labelledby')!)?.textContent).toBe('Whip');

    toggle.click();
    flushSync();
    expect(JSON.parse(localStorage.getItem('boite.experiments')!)).toEqual(['resident-agents', 'whip']);
    // This device's switch is never held: a flip the core does not hear yet must not freeze it.
    expect(toggle.disabled).toBe(false);
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === '> Try the whip\n\napplied: experiment.whip is now true'))).toBe(true));
  } finally {
    localStorage.removeItem('boite.experiments');
    store.detach();
    client.close();
  }
});

test('a card about a graduated experiment can only be refused: it writes no core setting', async () => {
  const { client, store } = await setup();
  const save = vi.spyOn(store, 'saveSettings');
  try {
    mounted = mount(SettingRequestCard, {
      target: document.body,
      props: {
        store,
        text: 'Open links in their apps',
        setting: { kind: 'change', key: 'experiment.open-chat-links' as RequestableKey, value: true, previous: false, page: 'experiments', section: 'open-chat-links', sensitive: false, app: 'app-12345678' },
        answer: null,
        pending: true,
        respond: async () => undefined
      }
    });
    flushSync();
    expect(query('[data-testid=setting-retired-hint]').textContent).toContain('own switch');
    // It keeps the name the user knows the switch by, not the raw key.
    expect(document.body.textContent).toContain('Open chat links in their apps');
    expect(document.body.textContent).not.toContain('experiment.open-chat-links');
    expect(query<HTMLInputElement>('[data-testid=setting-switch]').disabled).toBe(true);
    expect(document.querySelector('[data-testid=setting-apply]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  } finally {
    store.detach();
    client.close();
  }
});

test('a card about another machine of the group flips that machine\'s switch, and says where to go when it is not here', async () => {
  const machines: Machine[] = [];
  for (const id of ['desk', 'printer-pc']) {
    const store = new Store();
    store.attach(new FakeClient({ delayMs: 0, coreId: id, coreName: id, publicUrl: `https://${id}.test` }));
    await store.connect();
    machines.push({ id, label: id, store });
  }
  const [desk, pc] = machines.map((machine) => machine.store) as [Store, Store];
  try {
    workspace.machines = machines;
    await desk.client!.call('group.create', { name: 'Home' });
    await pc.client!.call('group.join', { invite: (await desk.client!.call('group.invite', {})).invite });
    await vi.waitFor(() => expect(desk.group?.cores).toHaveLength(2));
    await desk.open('t-trace');
    const { questionId } = await desk.client!.call('settings.request', { threadId: 't-trace', reason: 'Print on the USB printer', key: 'groupThreads', value: true, machine: 'printer-pc' });
    const question = await asked(desk, questionId);
    expect(question.setting).toMatchObject({ kind: 'change', key: 'groupThreads', previous: false, machine: { coreId: 'printer-pc', name: 'printer-pc' } });

    // Not connected in this window: no switch, only where to change it.
    workspace.machines = [machines[0]!];
    card(desk, question);
    expect(document.querySelector('[data-testid=setting-switch]')?.hasAttribute('disabled') ?? true).toBe(true);
    expect(query('[data-testid=setting-machine-away]').textContent).toBe('printer-pc is not connected here: change it from printer-pc.');
    await unmount(mounted!);
    mounted = undefined;

    // Connected: the switch writes that machine's setting, never this one's, and the card settles.
    workspace.machines = machines;
    card(desk, question);
    expect(query('[data-testid=setting-place]').textContent).toContain('printer-pc');
    const toggle = query<HTMLInputElement>('[data-testid=setting-switch]');
    expect(toggle.checked).toBe(false);
    toggle.click();
    await vi.waitFor(() => expect(pc.settings?.groupThreads).toBe(true));
    expect(desk.settings?.groupThreads ?? false).toBe(false);
    await vi.waitFor(() => expect(desk.pendingQuestions.some((pending) => pending.id === questionId)).toBe(false));
  } finally {
    workspace.machines = [];
    for (const store of [desk, pc]) { store.client?.close(); store.detach(); }
  }
});
