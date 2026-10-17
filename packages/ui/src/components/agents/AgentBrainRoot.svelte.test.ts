import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentsView } from '../../lib/agents.svelte';
import AgentBrainRoot from './AgentBrainRoot.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const type = (selector: string, value: string) => { const input = document.querySelector<HTMLInputElement>(selector)!; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

test('the brain folder moves on the owner’s word, shows the core’s refusal beside it, and returns to the default', async () => {
  const view = $state({
    snapshot: { brainRoot: { path: '/data/agent-workspaces', custom: false } },
    store: { owner: true, pickerAvailable: false, browseProjects: vi.fn(async () => ({ path: '/home/me', parent: '/home', directories: [{ name: 'brains', path: '/home/me/brains' }] })) },
    pending: false,
    error: '',
    call: vi.fn(),
  });
  view.call.mockImplementationOnce(async () => { view.error = "path: /home/me holds the core's own data; choose a folder of its own"; return null; })
    .mockImplementationOnce(async () => { view.snapshot.brainRoot = { path: '/home/me/brains', custom: true }; return view.snapshot.brainRoot; })
    .mockImplementationOnce(async () => { view.snapshot.brainRoot = { path: '/data/agent-workspaces', custom: false }; return view.snapshot.brainRoot; });
  mounted = mount(AgentBrainRoot, { target: document.body, props: { view: view as unknown as AgentsView } });
  await settle();
  expect(document.querySelector('[data-testid="agents-brain-root-path"]')?.textContent).toBe('/data/agent-workspaces');
  expect(document.querySelector('[data-testid="agents-brain-root-default"]')).toBeNull();

  document.querySelector<HTMLButtonElement>('[data-testid="agents-brain-root-change"]')!.click(); await settle();
  // A remote core: its own folders, listed by the core.
  document.querySelector<HTMLButtonElement>('[data-testid="agents-brain-root-browse"]')!.click(); await settle();
  expect(view.store.browseProjects).toHaveBeenCalledWith(undefined);
  expect(document.querySelector('[data-testid="agents-brain-root-folders"]')?.textContent).toContain('brains');
  type('[data-testid="agents-brain-root-input"]', '/home/me'); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="agents-brain-root-save"]')!.click(); await settle();
  expect(view.call).toHaveBeenLastCalledWith('agents.brain.root', { path: '/home/me' });
  expect(document.querySelector('[data-testid="agents-brain-root-error"]')?.textContent).toContain("/home/me holds the core's own data");
  expect(view.error).toBe('');

  type('[data-testid="agents-brain-root-input"]', '/home/me/brains'); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="agents-brain-root-save"]')!.click(); await settle();
  expect(view.call).toHaveBeenLastCalledWith('agents.brain.root', { path: '/home/me/brains' });
  expect(document.querySelector('[data-testid="agents-brain-root-path"]')?.textContent).toBe('/home/me/brains');
  expect(document.querySelector('[data-testid="agents-brain-root-error"]')).toBeNull();

  document.querySelector<HTMLButtonElement>('[data-testid="agents-brain-root-default"]')!.click(); await settle();
  expect(view.call).toHaveBeenLastCalledWith('agents.brain.root', { path: null });
  expect(document.querySelector('[data-testid="agents-brain-root-path"]')?.textContent).toBe('/data/agent-workspaces');
});

test('a paired device sees no brain folder row', async () => {
  const view = { snapshot: { brainRoot: { path: '/data/agent-workspaces', custom: false } }, store: { owner: false }, pending: false, error: '', call: vi.fn() };
  mounted = mount(AgentBrainRoot, { target: document.body, props: { view: view as unknown as AgentsView } });
  await settle();
  expect(document.querySelector('[data-testid="agents-brain-root"]')).toBeNull();
});
