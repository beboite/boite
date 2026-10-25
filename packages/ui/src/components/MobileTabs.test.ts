import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { setExperiment } from '../lib/experiments';
import MobileTabs from './MobileTabs.svelte';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); flushSync(); } };
beforeEach(async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
});
afterEach(async () => { setExperiment('contacts', false); if (app) await unmount(app); app = undefined; store.detach(); client.close(); vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear(); });
const tab = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

test('the bar reaches every place, marks the current one and starts a conversation from the middle', async () => {
  const navigate = vi.fn(), onnew = vi.fn();
  app = mount(MobileTabs, { target: document.body, props: { store, screen: 'threads', waiting: 0, navigate, onnew } }); await settle();
  expect(tab('mobile-conversations')!.getAttribute('aria-current')).toBe('page');
  for (const [id, destination] of [['mobile-conversations', 'threads'], ['mobile-activity', 'activity']]) {
    tab(id!)!.click(); await settle();
    expect(navigate).toHaveBeenLastCalledWith(destination);
  }
  tab('mobile-new')!.click();
  expect(onnew).toHaveBeenCalledOnce();
  tab('mobile-settings')!.click(); await settle();
  expect(store.page).toBe('settings');
  expect(tab('mobile-settings')!.getAttribute('aria-current')).toBe('page');
  expect(tab('mobile-conversations')!.hasAttribute('aria-current')).toBe(false);
});

test('Activity carries the count of conversations waiting on the user, capped so the badge stays round', async () => {
  app = mount(MobileTabs, { target: document.body, props: { store, screen: 'threads', waiting: 0, navigate: () => {}, onnew: () => {} } }); await settle();
  expect(tab('mobile-activity-waiting')).toBeNull();
  await unmount(app);
  app = mount(MobileTabs, { target: document.body, props: { store, screen: 'threads', waiting: 140, navigate: () => {}, onnew: () => {} } }); await settle();
  expect(tab('mobile-activity-waiting')!.textContent).toBe('99+');
  expect(tab('mobile-activity')!.getAttribute('aria-label')).toContain('140');
});

test('Bots carries the count of bots at work, in the waiting colour once one asks the user', async () => {
  setExperiment('resident-agents', true);
  onTestFinished(() => setExperiment('resident-agents', false));
  const { agentDirectory } = await import('../lib/agent-directory.svelte');
  app = mount(MobileTabs, { target: document.body, props: { store, screen: 'threads', waiting: 0, navigate: () => {}, onnew: () => {} } }); await settle();
  const rest = { status: 'idle', openQuestions: 0, backgroundWork: null, unread: false } as const;
  store.threads = store.threads.map(thread => ({ ...thread, ...rest, ...(thread.id === 't-trace' ? { agentSessionId: 'session-1' } : {}) }));
  agentDirectory(store).snapshot = { profiles: [{ id: 'agent-1', name: 'Mira', status: 'active' }], sessions: [{ id: 'session-1', agentId: 'agent-1' }], work: [], runs: [], entrusted: [] } as never;
  await settle();
  expect(tab('mobile-agents-at-work')).toBeNull();
  store.threads = store.threads.map(thread => thread.id === 't-trace' ? { ...thread, status: 'running' } : thread); await settle();
  expect(tab('mobile-agents-at-work')!.textContent).toBe('1');
  expect(tab('mobile-agents-at-work')!.dataset.waiting).toBe('false');
  store.threads = store.threads.map(thread => thread.id === 't-trace' ? { ...thread, status: 'idle', openQuestions: 1 } : thread); await settle();
  expect(tab('mobile-agents-at-work')!.dataset.waiting).toBe('true');
  expect(tab('mobile-agents')!.getAttribute('aria-label')).toBe('Bots, 1 at work, something needs you');
});

test('a paired device, which may call no contacts method, is offered no way into Contacts; the owner is', async () => {
  setExperiment('contacts', true);
  app = mount(MobileTabs, { target: document.body, props: { store, screen: 'threads', waiting: 0, navigate: () => {}, onnew: () => {} } }); await settle();
  expect(tab('mobile-contacts')).toBeNull();
  await unmount(app); app = undefined; store.detach(); client.close();

  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  app = mount(MobileTabs, { target: document.body, props: { store, screen: 'threads', waiting: 0, navigate: () => {}, onnew: () => {} } }); await settle();
  tab('mobile-contacts')!.click(); await settle();
  expect(store.page).toBe('home');
});
