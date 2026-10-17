import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentProfile } from '@boite/contracts';
import type { AgentsView } from '../../lib/agents.svelte';
import { confirm } from '../../lib/confirm.svelte';
import AgentEditor from './AgentEditor.svelte';

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
  tools: [], revision: 1, createdAt: 1, updatedAt: 1,
};

test('archiving requires the stored agent name, cancellation saves nothing, and a confirmed retry archives', async () => {
  const call = vi.fn().mockResolvedValue({ ...profile, status: 'archived' });
  const view = { snapshot: { profiles: [profile], limits: {} }, store: { accounts: [], providerOf: () => undefined, projects: [] }, call, pending: false };
  mounted = mount(AgentEditor, { target: document.body, props: { view: view as unknown as AgentsView, kind: 'profile', record: profile, embedded: true, ondone() {}, oncancel() {} } });
  await settle();
  document.querySelector<HTMLButtonElement>('.agent-field .trigger')?.click();
  await settle();
  // The menu's public value selects the removal state on touch and desktop.
  document.querySelector<HTMLElement>('[data-value="archived"]')!.click();
  await settle();
  const name = document.querySelector<HTMLInputElement>('[data-testid="agent-name"]')!;
  name.value = 'Renamed Mira'; name.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const save = document.querySelector<HTMLButtonElement>('[data-testid="agent-save"]')!;
  save.click(); await settle();
  expect(call).not.toHaveBeenCalled();
  expect(confirm.current?.requiredText).toBe('Mira');
  confirm.typed = 'Renamed Mira'; confirm.answer(true); await settle();
  expect(call).not.toHaveBeenCalled();
  confirm.answer(false); await settle();
  expect(call).not.toHaveBeenCalled();
  save.click(); await settle();
  confirm.typed = 'Mira'; confirm.answer(true); await settle();
  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0]![0]).toBe('agents.profile.save');
  expect(call.mock.calls[0]![1]).toMatchObject({ id: profile.id, expectedRevision: 1, value: { name: 'Renamed Mira', status: 'archived' } });
});

test('an agent is entrusted projects of its machine from its main options, the drafts aside', async () => {
  const call = vi.fn().mockResolvedValue({ ...profile, projectIds: ['p-game'] });
  const projects = [{ id: 'p-game', name: 'Game', kind: 'project' }, { id: 'p-drafts', name: 'Drafts', kind: 'drafts' }, { id: 'p-site', name: 'Site', kind: 'project' }];
  const store = { accounts: [], providerOf: () => undefined, projects, draftsProject: projects[1] };
  const view = { snapshot: { profiles: [profile], limits: {} }, store, call, pending: false };
  mounted = mount(AgentEditor, { target: document.body, props: { view: view as unknown as AgentsView, kind: 'profile', record: { ...profile, projectIds: ['p-site'] }, embedded: true, ondone() {}, oncancel() {} } });
  await settle();
  const field = document.querySelector('[data-testid="agent-projects"]')!;
  // Main options: not folded under More options.
  expect(field.closest('details')).toBeNull();
  expect(Array.from(field.querySelectorAll('.agent-chip-check')).map(c => c.textContent?.trim())).toEqual(['Game', 'Site']);
  expect(field.textContent).toContain('follows their threads');
  expect(document.querySelector<HTMLInputElement>('[data-testid="agent-project-p-site"]')!.checked).toBe(true);
  document.querySelector<HTMLInputElement>('[data-testid="agent-project-p-game"]')!.click();
  document.querySelector<HTMLInputElement>('[data-testid="agent-project-p-site"]')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="agent-save"]')!.click();
  await settle();
  expect(call).toHaveBeenCalledWith('agents.profile.save', expect.objectContaining({ value: expect.objectContaining({ projectIds: ['p-game'] }) }));
});
