import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentProfile } from '@boite/contracts';
import { FakeClient } from '../../lib/fake-client';
import { Store } from '../../lib/store.svelte';
import { AgentsView } from '../../lib/agents.svelte';
import { strings } from '../../lib/strings';
import AgentRuntimeSettings from './AgentRuntimeSettings.svelte';

const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
const idle = async () => { await settle(); await new Promise(resolve => setTimeout(resolve, 10)); await settle(); };
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; document.body.innerHTML = ''; });

/** A persistent agent on the fake core, on Opus, and its Settings card mounted. */
async function open() {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  // Claude's models are read when first asked for, as the picker would.
  await store.probeModels('claude', 'a-claude-main');
  await client.call('agents.profile.save', { value: { name: 'Ada', domain: '', instructions: '', avatar: '', selection: { providerId: 'claude', accountId: 'a-claude-main', model: 'claude-opus-5-5', effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
  const view = new AgentsView(store);
  await view.refresh();
  const agent = (): AgentProfile => view.snapshot!.profiles[0]!;
  let card: ReturnType<typeof mount> | null = null;
  const show = async () => { card = mount(AgentRuntimeSettings, { target: document.body, props: { view, agent: agent() } }); await idle(); };
  const hide = async () => { if (card) await unmount(card); card = null; document.body.innerHTML = ''; };
  cleanup = async () => { await hide(); view.close(); store.detach(); client.close(); };
  await show();
  return { client, view, agent, show, hide };
}

async function pick(model: string) {
  // jsdom runs no animation: end the closing one the last pick started.
  for (const closing of document.querySelectorAll('.closing')) closing.dispatchEvent(new Event('animationend'));
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=agent-runtime] [data-testid=composer-picker]')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>(`[data-model="${model}"]`)!.click();
  // A pick first asks the core for the account's models.
  await idle();
}
const status = () => document.querySelector<HTMLElement>('[data-testid=agent-runtime] [data-testid=save-status]');

test('a model picked for an agent is saved without a Save button and is still there when its settings reopen', async () => {
  const { client, agent, show, hide } = await open();
  await pick('claude-sonnet-5-5');
  await idle();
  // Leaving the tab and coming back reads the core again.
  await hide();
  expect((await client.call('agents.runtime.get', { agentId: agent().id })).defaultRoute.model).toBe('claude-sonnet-5-5');
  expect(agent().selection.model).toBe('claude-sonnet-5-5');
  await show();
  expect(document.querySelector('[data-testid=agent-runtime] [data-testid=composer-picker]')!.textContent).toContain('Sonnet');
  await pick('claude-fable-5-1');
  await idle();
  expect(status()?.dataset.state).toBe('saved');
  expect(status()!.textContent).toContain('Saved');
});

test('picks made while a save is in flight are written once after it, in order, on the revision it returned', async () => {
  const { client, agent } = await open();
  const real = client.call.bind(client);
  const sent: { model: string | null; revision: number }[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  client.call = (async (method: string, params: never) => {
    if (method === 'agents.runtime.configure') {
      const p = params as { expectedRevision: number; config: { defaultRoute: { model: string | null } } };
      sent.push({ model: p.config.defaultRoute.model, revision: p.expectedRevision });
      if (sent.length === 1) await held;
    }
    return real(method as never, params);
  }) as typeof client.call;
  const before = agent().revision;
  await pick('claude-sonnet-5-5');
  await pick('claude-opus-5-5');
  await pick('claude-fable-5-1');
  expect(status()?.dataset.state).toBe('saving');
  release();
  await idle();
  expect(sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-fable-5-1']);
  expect(sent[1]!.revision).toBe(before + 1);
  expect((await real('agents.runtime.get', { agentId: agent().id })).defaultRoute.model).toBe('claude-fable-5-1');
  expect(status()?.dataset.state).toBe('saved');
});

test('a refused save never reads as saved, keeps the pick on screen and saves it on Retry', async () => {
  const { client, agent } = await open();
  const real = client.call.bind(client);
  let refuse = true;
  client.call = (async (method: string, params: never) => {
    if (method === 'agents.runtime.configure' && refuse) throw new Error('core unavailable');
    return real(method as never, params);
  }) as typeof client.call;
  await pick('claude-sonnet-5-5');
  await idle();
  expect(status()?.dataset.state).toBe('error');
  expect(status()!.textContent).toContain('core unavailable');
  expect(agent().selection.model).toBe('claude-opus-5-5');
  expect((await real('agents.runtime.get', { agentId: agent().id })).defaultRoute.model).toBe('claude-opus-5-5');
  refuse = false;
  status()!.querySelector('button')!.click();
  await idle();
  expect(status()?.dataset.state).toBe('saved');
  expect(agent().selection.model).toBe('claude-sonnet-5-5');
});

test('a route name being cleared is not saved until it is valid again', async () => {
  const { client, agent } = await open();
  const name = document.querySelector<HTMLInputElement>('[data-testid=agent-runtime] .agent-route input')!;
  name.value = '';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  name.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  expect(status()?.dataset.state).toBe('invalid');
  expect((await client.call('agents.runtime.get', { agentId: agent().id })).allowedRoutes[0]!.name).toBe('Default');
  name.value = 'Main';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  name.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  expect(status()?.dataset.state).toBe('saved');
  expect((await client.call('agents.runtime.get', { agentId: agent().id })).allowedRoutes[0]!.name).toBe('Main');
});

test('a model picked after another writer changed the agent keeps that writer\'s changes and shows them', async () => {
  const { client, view, agent } = await open();
  const config = await client.call('agents.runtime.get', { agentId: agent().id });
  // Another window saves the background settings while this card is open.
  await client.call('agents.runtime.configure', { agentId: agent().id, expectedRevision: agent().revision, config: { ...config, autoMemory: false, maxRunMinutes: 37 } });
  await view.refresh();
  await idle();
  await pick('claude-sonnet-5-5');
  await idle();
  const saved = await client.call('agents.runtime.get', { agentId: agent().id });
  expect([saved.defaultRoute.model, saved.autoMemory, saved.maxRunMinutes]).toEqual(['claude-sonnet-5-5', false, 37]);
  expect(status()?.dataset.state).toBe('saved');
  expect(document.querySelector<HTMLInputElement>('[data-testid=agent-auto-memory]')!.checked).toBe(false);
});

test('a route name cleared just before the card closes is never sent', async () => {
  const { client, agent, hide } = await open();
  const name = document.querySelector<HTMLInputElement>('[data-testid=agent-runtime] .agent-route input')!;
  name.value = '';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  // Leaving within the typing pause sends what waits, once checked.
  await hide();
  await idle();
  expect((await client.call('agents.runtime.get', { agentId: agent().id })).allowedRoutes[0]!.name).toBe('Default');
});

test('a field changed here and elsewhere to different values is a conflict the card reports, not an overwrite', async () => {
  const { client, view, agent } = await open();
  const config = await client.call('agents.runtime.get', { agentId: agent().id });
  await client.call('agents.runtime.configure', { agentId: agent().id, expectedRevision: agent().revision, config: { ...config, maxRunMinutes: 37 } });
  await view.refresh();
  await idle();
  const minutes = document.querySelectorAll<HTMLInputElement>('[data-testid=agent-runtime] input[type=number]')[1]!;
  minutes.value = '50';
  minutes.dispatchEvent(new Event('input', { bubbles: true }));
  minutes.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  const engine = document.querySelector<HTMLElement>('[data-testid=agent-runtime] [data-testid=save-status]');
  expect(engine?.dataset.state).toBe('error');
  expect(engine!.textContent).toContain(strings.settings.autosave.conflict);
  expect((await client.call('agents.runtime.get', { agentId: agent().id })).maxRunMinutes).toBe(37);
});

test('another writer saving while this card\'s last save comes back still conflicts with the edit made meanwhile', async () => {
  const { client, view, agent } = await open();
  const real = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let configured = 0;
  client.call = (async (method: string, params: never) => {
    const result = await real(method as never, params);
    // The first save is stored; its answer is held while the rest happens.
    if (method === 'agents.runtime.configure' && ++configured === 1) await gate;
    return result;
  }) as typeof client.call;
  await pick('claude-sonnet-5-5');
  const minutes = document.querySelectorAll<HTMLInputElement>('[data-testid=agent-runtime] input[type=number]')[1]!;
  minutes.value = '50';
  minutes.dispatchEvent(new Event('input', { bubbles: true }));
  minutes.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  const current = await real('agents.runtime.get', { agentId: agent().id });
  const revision = (await real('agents.snapshot', {})).profiles[0]!.revision;
  await real('agents.runtime.configure', { agentId: agent().id, expectedRevision: revision, config: { ...current, maxRunMinutes: 37 } });
  await view.refresh();
  release();
  await idle();
  expect((await real('agents.runtime.get', { agentId: agent().id })).maxRunMinutes).toBe(37);
  expect(document.querySelector<HTMLElement>('[data-testid=agent-runtime] [data-testid=save-status]')?.dataset.state).toBe('error');
});
