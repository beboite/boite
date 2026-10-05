import { beforeEach, expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import type { ModelInfo } from '@boite/contracts';
import { INITIAL_MODEL_DEFAULTS, MODEL_DEFAULTS_KEY, readModelDefaults, resolveModelDefault, fallbackModelDefault, writeModelDefaults } from './model-defaults';

beforeEach(() => localStorage.clear());
const levels = ['low', 'medium', 'high'].map((id) => ({ id, label: id }));

test('a paired device discovers every available provider and the selected ACP model effort', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, principal: 'session' });
  try {
    expect(store.owner).toBe(false);
    for (const providerId of ['claude', 'codex', 'opencode', 'pi', 'grok', 'muse']) {
      const account = store.accountsOf(providerId)[0]!;
      await store.probeModels(providerId, account.id);
      expect(store.probedModels[`${providerId}::${account.id}`]?.length).toBeGreaterThan(0);
    }
    const models = [{ id: 'vendor/native-model', name: 'Native model' }];
    store.probedModels = { ...store.probedModels, 'opencode::a-opencode': models };
    const original = client.call.bind(client);
    const calls = vi.spyOn(client, 'call').mockImplementation((method, params) => {
      if (method === 'providers.probe') return Promise.resolve({ models: [{ ...models[0], effort: { levels, default: 'high' } }], probedAt: Date.now() }) as never;
      return original(method, params);
    });
    await store.probeModelEffort('opencode', 'a-opencode', models[0]!.id);
    expect(calls).toHaveBeenCalledWith('providers.probe', { providerId: 'opencode', accountId: 'a-opencode', model: models[0]!.id });
    expect(store.modelsOf('opencode', 'a-opencode')[0]?.effort?.default).toBe('high');
  } finally { vi.restoreAllMocks(); }
});

test('Claude never offers descriptor placeholders before discovery or after a failed read', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const provider = store.providerOf('claude')!;
  const account = store.accountsOf('claude')[0]!;
  provider.models = [{ id: 'placeholder', name: 'Placeholder model' }];
  const calls = vi.spyOn(client, 'call').mockRejectedValue(new Error('agent offline'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(store.modelsOf('claude', account.id)).toEqual([]);
    await store.probeModels('claude', account.id);
    expect(store.modelsOf('claude', account.id)).toEqual([]);
    expect(store.isProbing('claude', account.id)).toBe(false);
  } finally { calls.mockRestore(); warn.mockRestore(); }
});

test('an old default alias uses the configured target without changing an explicit model', async ({ ready }) => {
  const { store } = await ready({ delayMs: 0 });
  const account = store.accountsOf('codex')[0]!;
  const alias = { providerId: 'codex', accountId: account.id, model: 'default', effort: null, permissionMode: 'default' as const };
  expect(store.composerChoice(alias)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
  const explicit = { ...alias, model: 'codex-demo', effort: 'low' };
  expect(store.composerChoice(explicit)).toEqual(explicit);
  store.setModelDefault('codex', account.id, 'default', null);
  expect(store.modelDefaults.codex).toBeUndefined();
});

test('sending on an old alias saves the named preset before starting the turn', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
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

test('a configured default survives reconnect and wins over the previous thread model', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const provider = store.providerOf('claude')!;
  const account = store.accountsOf('claude')[0]!;
  await store.probeModels('claude', account.id);
  const models = store.modelsOf('claude', account.id);
  const preferred = models.find((model) => model.id === 'claude-opus-5-5')!;
  expect(preferred).toBeTruthy();
  store.remember({ providerId: provider.id, accountId: account.id, model: models[0]!.id, effort: null, permissionMode: 'plan' });
  store.setModelDefault(provider.id, account.id, preferred.id, 'medium');
  store.startDraft(store.projects[0]!.id);
  expect(store.defaultChoice()).toMatchObject({ model: preferred.id, effort: 'medium', permissionMode: 'plan' });
  store.detach();
  const { store: next } = await ready({ delayMs: 0 });
  expect(next.defaultChoice()).toMatchObject({ model: preferred.id, effort: 'medium' });
});

test('the first ACP draft probes its default model scale and preserves a later explicit selection', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const provider = store.providerOf('claude')!;
  provider.protocol = 'acp';
  provider.models = [{ id: 'default', name: 'Default', default: true }];
  const account = store.accountsOf(provider.id)[0]!;
  store.prefs.providerId = provider.id;
  store.prefs.accountId = account.id;
  store.startDraft();
  expect(store.defaultChoice()).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  // Before the catalog is read, the built-in default already offers its reasoning levels.
  expect(store.modelOf(store.defaultChoice())).toMatchObject({ name: 'Opus 5.5', effort: { default: 'high' } });
  expect(store.modelOf(store.defaultChoice())?.effort?.levels.map((level) => level.id)).toContain('max');
  expect(store.modelsOf(provider.id, account.id).map((model) => model.id)).toEqual(['default']);
  const call = vi.spyOn(client, 'call').mockResolvedValue({ models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', effort: { levels, default: 'low' } }
  ] } as never);
  // Changing permissions must not skip the first model probe.
  store.remember({ ...store.defaultChoice()!, permissionMode: 'bypassPermissions' });
  const prepared = await store.prepareDraftChoice(store.defaultChoice()!);
  expect(call).toHaveBeenCalledWith('providers.probe', { providerId: provider.id, accountId: account.id, model: 'claude-opus-5-5' });
  expect(prepared).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  const explicit = { ...prepared!, effort: 'low' };
  store.remember(explicit);
  expect(await store.prepareDraftChoice(explicit)).toEqual(explicit);
  expect(store.defaultChoice()).toEqual(explicit);
  store.startDraft();
  store.modelDefaults = { claude: { model: 'unavailable-model', effort: 'high' } };
  expect(await store.prepareDraftChoice(store.defaultChoice()!)).toBeNull();
  expect(store.error).toContain('unavailable-model');
  call.mockRestore();
});

test('a cached remote model waits for the restarted core catalog before creating its thread', async ({ ready }) => {
  const { store: first } = await ready({ delayMs: 0 });
  const accountId = first.accountsOf('codex')[0]!.id;
  await first.probeModels('codex', accountId);
  const choice = { providerId: 'codex', accountId, model: 'codex-demo', effort: 'high', speed: 'fast', permissionMode: 'plan' as const };
  first.remember(choice);
  first.detach();

  // The browser retains its catalog while a restarted remote core has none.
  const { store, client } = await ready({ delayMs: 0 });
  expect(store.modelsOf('codex', accountId).some(model => model.id === choice.model)).toBe(true);
  store.startDraft(store.projects[0]!.id);
  store.remember(choice);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'providers.probe') await gate;
    return original(method, params);
  });
  try {
    const submitted = store.submit('Create without opening the picker', choice);
    expect(calls).toHaveBeenCalledWith('providers.probe', { providerId: 'codex', accountId });
    expect(calls.mock.calls.some(([method]) => method === 'threads.create')).toBe(false);
    release();
    expect(await submitted).toBe(true);
    expect(store.error).toBeNull();
    expect(store.openThread).toMatchObject(choice);
    expect(store.openThread!.turns.at(-1)?.execution).toMatchObject(choice);
  } finally {
    release();
  }
});

test('a failed catalog read preserves the draft and its cached selection', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const accountId = store.accountsOf('codex')[0]!.id;
  await store.probeModels('codex', accountId);
  const choice = { providerId: 'codex', accountId, model: 'codex-demo', effort: 'high', permissionMode: 'default' as const };
  store.startDraft(store.projects[0]!.id);
  store.remember(choice);
  const draft = store.draft;
  const original = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'providers.probe') throw new Error('remote catalog unavailable');
    return original(method, params);
  });
  expect(await store.submit('Keep this draft', choice)).toBe(false);
  expect(store.error).toBe('remote catalog unavailable');
  expect(store.draft).toBe(draft);
  expect(store.draftChoice).toEqual(choice);
  expect(calls.mock.calls.some(([method]) => method === 'threads.create' || method === 'turns.start')).toBe(false);
  expect(store.modelsOf('codex', accountId).some(model => model.id === choice.model)).toBe(true);
});

test('an ACP effort probe that fails still keeps a model the catalog already lists', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const provider = store.providerOf('claude')!;
  provider.protocol = 'acp';
  provider.models = [{ id: 'claude-opus-5', name: 'Opus 5' }];
  const account = store.accountsOf(provider.id)[0]!;
  const choice = { providerId: provider.id, accountId: account.id, model: 'claude-opus-5', effort: 'high' as const, permissionMode: 'default' as const };
  vi.spyOn(client, 'call').mockRejectedValue(new Error('effort scale unavailable'));
  expect(await store.prepareDraftChoice(choice)).toEqual(choice);
  expect(store.error).toBeNull();
});

test('a built-in default the account no longer lists moves to its later revision instead of refusing the send', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const provider = store.providerOf('claude')!;
  const account = store.accountsOf('claude')[0]!;
  const catalog: ModelInfo[] = [
    { id: 'claude-fable-5-1', name: 'Fable 5.1', effort: { levels, default: 'low' } },
    { id: 'claude-opus-5-5-20261101', name: 'Opus 5.5', effort: { levels, default: 'low' } }
  ];
  const stale = { providerId: provider.id, accountId: account.id, model: 'claude-opus-5-5', effort: 'high', speed: 'fast', permissionMode: 'default' as const };
  const call = vi.spyOn(client, 'call').mockResolvedValue({ models: catalog } as never);
  expect(await store.prepareDraftChoice(stale)).toEqual({ ...stale, model: 'claude-opus-5-5-20261101', speed: null });
  expect(store.error).toBeNull();
  // The catalog is read: the composer and Settings open on the same model.
  expect(store.defaultModelOf(provider, account.id)).toBe('claude-opus-5-5-20261101');
  expect(store.defaultEffortOf(provider.id, account.id, 'claude-opus-5-5-20261101')).toBe('high');
  // A draft that remembered the built-in before discovery shows what the send uses.
  store.startDraft();
  store.remember(stale);
  expect(store.draftChoice?.model).toBe('claude-opus-5-5');
  expect(store.defaultChoice()).toMatchObject({ model: 'claude-opus-5-5-20261101', effort: 'high', speed: null });
  expect(fallbackModelDefault('claude', catalog.slice(0, 1))).toEqual({ model: 'claude-fable-5-1', effort: 'high' });
  expect(fallbackModelDefault('claude', [{ id: 'default', name: 'Default', default: true }])).toBeNull();
  // A default the user configured is still refused, never replaced.
  store.modelDefaults = { claude: { model: 'claude-opus-5-5', effort: 'high' } };
  expect(await store.prepareDraftChoice(stale)).toBeNull();
  expect(store.error).toContain('claude-opus-5-5');
  call.mockRestore();
});
