import { beforeEach, expect, test, vi } from 'vitest';
import type { ModelInfo } from '@boite/contracts';
import { INITIAL_MODEL_DEFAULTS, MODEL_DEFAULTS_KEY, readModelDefaults, resolveModelDefault, writeModelDefaults } from './model-defaults';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';

beforeEach(() => localStorage.clear());
const levels = ['low', 'medium', 'high'].map((id) => ({ id, label: id }));

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
});

test('a configured default survives reconnect and wins over the previous thread model', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  const provider = store.providerOf('claude')!;
  const account = store.accountsOf('claude')[0]!;
  const models = store.modelsOf('claude', account.id);
  const preferred = models.find((model) => model.id === 'claude-opus-5')!;
  expect(preferred).toBeTruthy();
  store.remember({ providerId: provider.id, accountId: account.id, model: models[0]!.id, effort: null, permissionMode: 'plan' });
  store.setModelDefault(provider.id, account.id, preferred.id, 'medium');
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
