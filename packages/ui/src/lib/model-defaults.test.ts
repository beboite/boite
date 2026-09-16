import { beforeEach, expect, test, vi } from 'vitest';
import type { ModelInfo } from '@boite/contracts';
import { INITIAL_MODEL_DEFAULTS, MODEL_DEFAULTS_KEY, readModelDefaults, resolveModelDefault, writeModelDefaults } from './model-defaults';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';

beforeEach(() => localStorage.clear());
const levels = ['low', 'medium', 'high'].map((id) => ({ id, label: id }));

test('an old default alias uses the configured target without changing an explicit model', async () => {
  const store = new Store();
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  const account = store.accountsOf('codex')[0]!;
  const alias = { providerId: 'codex', accountId: account.id, model: 'default', effort: null, permissionMode: 'default' as const };
  expect(store.composerChoice(alias)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'medium' });
  const explicit = { ...alias, model: 'codex-demo', effort: 'low' };
  expect(store.composerChoice(explicit)).toEqual(explicit);
  store.setModelDefault('codex', account.id, 'default', null);
  expect(store.modelDefaults.codex).toBeUndefined();
  store.detach();
});

test('sending on an old alias saves the named preset before starting the turn', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  const account = store.accountsOf('codex')[0]!;
  await store.probeModels('codex', account.id);
  store.setModelDefault('codex', account.id, 'codex-demo', 'high');
  const thread = await store.createThread({ projectId: store.projects[0]!.id, providerId: 'codex', accountId: account.id,
    model: 'default', permissionMode: 'default' });
  expect(thread).toBeTruthy();
  const call = vi.spyOn(client, 'call');
  expect(await store.send('Use the named model', thread!.id)).toBe(true);
  const names = call.mock.calls.map(([name]) => name);
  expect(names.indexOf('threads.update')).toBeLessThan(names.indexOf('turns.start'));
  expect(store.openThread).toMatchObject({ model: 'codex-demo', effort: 'high' });
  expect(store.openThread!.turns.at(-1)?.execution).toMatchObject({ model: 'codex-demo', effort: 'high' });
  store.detach();
});

test.each(Object.entries(INITIAL_MODEL_DEFAULTS))('resolves the requested %s default after the account offers it', (provider, choice) => {
  const models: ModelInfo[] = [{ id: 'default', name: 'Default', default: true },
    { id: choice.model, name: choice.model, effort: { levels, default: 'low' } }];
  expect(resolveModelDefault(provider, models, {})).toEqual(choice);
  expect(resolveModelDefault(provider, models.slice(0, 1), {})).toEqual({ model: 'default', effort: null });
});

test('persists an override and drops an effort the account no longer offers', () => {
  writeModelDefaults({ codex: { model: 'custom', effort: 'high' } });
  const models: ModelInfo[] = [{ id: 'custom', name: 'Custom', effort: { levels: levels.slice(0, 2), default: 'medium' } }];
  expect(resolveModelDefault('codex', models, readModelDefaults())).toEqual({ model: 'custom', effort: 'medium' });
  localStorage.setItem(MODEL_DEFAULTS_KEY, '{');
  expect(readModelDefaults()).toEqual({});
  localStorage.setItem(MODEL_DEFAULTS_KEY, JSON.stringify({ codex: { model: 'default', effort: null } }));
  expect(readModelDefaults()).toEqual({});
});

test('a configured default survives reconnect and wins over the previous thread model', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  const provider = store.providerOf('claude')!;
  const account = store.accountsOf('claude')[0]!;
  await store.probeModels('claude', account.id);
  const models = store.modelsOf('claude', account.id);
  const preferred = models.find((model) => model.id === 'claude-opus-5')!;
  expect(preferred).toBeTruthy();
  store.remember({ providerId: provider.id, accountId: account.id, model: models[0]!.id, effort: null, permissionMode: 'plan' });
  store.setModelDefault(provider.id, account.id, preferred.id, 'medium');
  store.startDraft(store.projects[0]!.id);
  expect(store.defaultChoice()).toMatchObject({ model: preferred.id, effort: 'medium', permissionMode: 'plan' });
  store.detach();
  const next = new Store();
  next.attach(new FakeClient({ delayMs: 0 }));
  await next.connect();
  expect(next.defaultChoice()).toMatchObject({ model: preferred.id, effort: 'medium' });
  next.detach();
});

test('the first draft probes its default and preserves a later explicit selection', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  const provider = store.providerOf('claude')!;
  provider.protocol = 'codex-appserver';
  provider.models = [{ id: 'default', name: 'Default', default: true }];
  const account = store.accountsOf(provider.id)[0]!;
  store.prefs.providerId = provider.id;
  store.prefs.accountId = account.id;
  store.startDraft();
  expect(store.defaultChoice()).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
  expect(store.modelOf(store.defaultChoice())?.name).toBe('Claude Opus 5');
  expect(store.modelsOf(provider.id, account.id).map((model) => model.id)).toEqual(['default']);
  const call = vi.spyOn(client, 'call').mockResolvedValue({ models: [
    { id: 'claude-opus-5', name: 'Opus 5', effort: { levels, default: 'low' } }
  ] } as never);
  // Changing permissions must not skip the first model probe.
  store.remember({ ...store.defaultChoice()!, permissionMode: 'bypassPermissions' });
  const prepared = await store.prepareDraftChoice(store.defaultChoice()!);
  expect(call).toHaveBeenCalledWith('providers.probe', { providerId: provider.id, accountId: account.id });
  expect(prepared).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
  const explicit = { ...prepared!, effort: 'low' };
  store.remember(explicit);
  expect(await store.prepareDraftChoice(explicit)).toEqual(explicit);
  expect(store.defaultChoice()).toEqual(explicit);
  store.startDraft();
  store.modelDefaults = { claude: { model: 'unavailable-model', effort: 'high' } };
  expect(await store.prepareDraftChoice(store.defaultChoice()!)).toBeNull();
  expect(store.error).toContain('unavailable-model');
  call.mockRestore();
  store.detach();
});
