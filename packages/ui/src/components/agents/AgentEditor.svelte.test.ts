import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentProfile } from '@boite/contracts';
import { AgentsView } from '../../lib/agents.svelte';
import { confirm } from '../../lib/confirm.svelte';
import { FakeClient } from '../../lib/fake-client';
import { Store } from '../../lib/store.svelte';
import { TYPING_MS } from '../../lib/autosave.svelte';
import AgentEditor from './AgentEditor.svelte';
import AgentRuntimeSettings from './AgentRuntimeSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  confirm.answer(false);
  if (mounted) await unmount(mounted);
  document.body.innerHTML = '';
});
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const profile: AgentProfile = {
  id: 'a-mira', name: 'Mira', domain: '', instructions: '', avatar: '', status: 'active',
  selection: { providerId: 'echo', accountId: 'echo', model: 'echo', effort: null, permissionMode: 'default' },
  revision: 1, createdAt: 1, updatedAt: 1,
};

/** A view whose saves go through `call`, each returning the record one revision on. */
function viewOf(record: AgentProfile, store: object) {
  const call = vi.fn(async (_method: string, params: { value: Partial<AgentProfile> }) => ({ ...record, ...params.value, revision: record.revision + call.mock.calls.length }));
  const view = { snapshot: { profiles: [record], limits: {} }, store, call, save: (method: string, params: () => { value: Partial<AgentProfile> }) => call(method, params()), pending: false };
  return { call, view: view as unknown as AgentsView };
}
async function pickArchived() {
  // jsdom runs no animation: end the closing one a previous pick started.
  for (const closing of document.querySelectorAll('.closing')) closing.dispatchEvent(new Event('animationend'));
  await settle();
  document.querySelector<HTMLButtonElement>('.agent-field .trigger')?.click();
  await settle();
  // The menu's public value selects the removal state on touch and desktop.
  document.querySelector<HTMLElement>('[data-value="archived"]')!.click();
  await settle();
}

test('archiving still asks for the stored agent name, a cancelled archive saves nothing, and a confirmed one saves by itself', async () => {
  const { call, view } = viewOf(profile, { accounts: [], providerOf: () => undefined, projects: [] });
  mounted = mount(AgentEditor, { target: document.body, props: { view, record: profile, embedded: true, ondone() {}, oncancel() {} } });
  await settle();
  expect(document.querySelector('[data-testid="agent-save"]')).toBeNull();
  const name = document.querySelector<HTMLInputElement>('[data-testid="agent-name"]')!;
  name.value = 'Renamed Mira';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  name.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0]![1]).toMatchObject({ id: profile.id, expectedRevision: 1, value: { name: 'Renamed Mira', status: 'active' } });

  await pickArchived();
  expect(call).toHaveBeenCalledOnce();
  expect(confirm.current?.requiredText).toBe('Mira');
  confirm.typed = 'Renamed Mira'; confirm.answer(true); await settle();
  expect(call).toHaveBeenCalledOnce();
  confirm.answer(false); await settle();
  expect(call).toHaveBeenCalledOnce();
  await pickArchived();
  confirm.typed = 'Mira'; confirm.answer(true); await settle();
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[1]![0]).toBe('agents.profile.save');
  expect(call.mock.calls[1]![1]).toMatchObject({ id: profile.id, expectedRevision: 2, value: { name: 'Renamed Mira', status: 'archived' } });
});

test('an agent is entrusted projects of its machine from its main options, the drafts aside', async () => {
  const projects = [{ id: 'p-game', name: 'Game', kind: 'project' }, { id: 'p-drafts', name: 'Drafts', kind: 'drafts' }, { id: 'p-site', name: 'Site', kind: 'project' }];
  const { call, view } = viewOf(profile, { accounts: [], providerOf: () => undefined, projects, draftsProject: projects[1] });
  mounted = mount(AgentEditor, { target: document.body, props: { view, record: { ...profile, projectIds: ['p-site'] }, embedded: true, ondone() {}, oncancel() {} } });
  await settle();
  const field = document.querySelector('[data-testid="agent-projects"]')!;
  // Main options: not folded under More options.
  expect(field.closest('details')).toBeNull();
  expect(Array.from(field.querySelectorAll('.agent-chip-check')).map(c => c.textContent?.trim())).toEqual(['Game', 'Site']);
  expect(field.textContent).toContain('follows their threads');
  expect(document.querySelector<HTMLInputElement>('[data-testid="agent-project-p-site"]')!.checked).toBe(true);
  document.querySelector<HTMLInputElement>('[data-testid="agent-project-p-game"]')!.click();
  document.querySelector<HTMLInputElement>('[data-testid="agent-project-p-site"]')!.click();
  // Both ticks land in one save, sent once the second is in.
  await settle();
  expect(call).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledWith('agents.profile.save', expect.objectContaining({ value: expect.objectContaining({ projectIds: ['p-game'] }) }));
});

const idle = async () => { await settle(); await new Promise(resolve => setTimeout(resolve, 10)); await settle(); };
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

test('an agent\'s identity and model, edited side by side in its Settings tab, both save by themselves', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  // Claude's models are read when first asked for, as the picker would.
  await store.probeModels('claude', 'a-claude-main');
  await client.call('agents.profile.save', { value: { name: 'Ada', domain: '', instructions: '', avatar: '', selection: { providerId: 'claude', accountId: 'a-claude-main', model: 'claude-opus-5-5', effort: null, permissionMode: 'default' }, status: 'active' } });
  const view = new AgentsView(store);
  await view.refresh();
  const profile = () => view.snapshot!.profiles[0]!;
  const editor = mount(AgentEditor, { target: document.body, props: { view, record: profile(), embedded: true, ondone: () => {}, oncancel: () => {} } });
  const runtime = mount(AgentRuntimeSettings, { target: document.body, props: { view, agent: profile() } });
  cleanup = async () => { await unmount(runtime); await unmount(editor); view.close(); store.detach(); client.close(); };
  await idle();
  expect(document.querySelector('[data-testid=agent-editor] [data-testid=agent-save]')).toBeNull();

  const name = document.querySelector<HTMLInputElement>('[data-testid=agent-name]')!;
  name.value = 'Ada Lovelace';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  // Typing waits for a pause before it saves.
  await idle();
  expect(profile().name).toBe('Ada');
  await new Promise(resolve => setTimeout(resolve, TYPING_MS + 50));
  await idle();
  expect(profile().name).toBe('Ada Lovelace');

  // The runtime card moves the revision; the next identity edit still saves on top of it.
  document.querySelector<HTMLButtonElement>('[data-testid=agent-runtime] [data-testid=composer-picker]')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-model="claude-sonnet-5-5"]')!.click();
  await idle();
  const domain = document.querySelector<HTMLInputElement>('[data-testid=agent-editor] input[maxlength="500"]')!;
  domain.value = 'Review';
  domain.dispatchEvent(new Event('input', { bubbles: true }));
  domain.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  expect([profile().name, profile().domain, profile().selection.model]).toEqual(['Ada Lovelace', 'Review', 'claude-sonnet-5-5']);
  expect(document.querySelector<HTMLElement>('[data-testid=agent-editor] [data-testid=save-status]')?.dataset.state).toBe('saved');

  // A name cleared while typing is never sent.
  name.value = '  ';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  name.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  expect(document.querySelector<HTMLElement>('[data-testid=agent-editor] [data-testid=save-status]')?.dataset.state).toBe('invalid');
  expect(profile().name).toBe('Ada Lovelace');
});

test('a new bot is free to act: it is created with full access unless the owner picks another mode', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  const view = new AgentsView(store);
  await view.refresh();
  let created: AgentProfile | null = null;
  const editor = mount(AgentEditor, { target: document.body, props: { view, ondone: (agent: AgentProfile) => { created = agent; }, oncancel: () => {} } });
  cleanup = async () => { await unmount(editor); view.close(); store.detach(); client.close(); };
  await idle();
  expect(document.querySelector('[data-testid=agent-runtime]')?.textContent).toContain('Full access');
  const name = document.querySelector<HTMLInputElement>('[data-testid=agent-name]')!;
  name.value = 'Nova';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await idle();
  document.querySelector<HTMLButtonElement>('[data-testid=agent-save]')!.click();
  await idle();
  await vi.waitFor(() => expect(created).not.toBeNull());
  expect(created!.selection.permissionMode).toBe('bypassPermissions');
});
