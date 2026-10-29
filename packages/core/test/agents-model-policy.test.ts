import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AgentProfile, AgentRuntimeConfig, ModelInfo } from '@boite/contracts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let client: Awaited<ReturnType<TestCore['connect']>>;
let agent: AgentProfile;
let config: AgentRuntimeConfig;
let approvedModels: ModelInfo[];

beforeEach(async () => {
  h = await startTestCore();
  client = await h.connect();
  h.core.workforce.setLimits({ paused: true });
  const provider = h.core.providers.require('echo');
  const original = provider.models[0]!;
  provider.models = [
    { ...original, effort: { levels: [{ id: 'high', label: 'High' }] } },
    { id: 'old-helper', name: 'Old helper' },
  ];
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  agent = await client.call('agents.profile.save', { value: {
    name: 'Ada', domain: '', instructions: '', avatar: '', status: 'active',
    selection: { providerId: 'echo', accountId: account.id, model: 'echo', effort: 'high', permissionMode: 'default' },
  } });
  config = {
    defaultRoute: agent.selection,
    allowedRoutes: [{ ...agent.selection, model: 'echo', id: 'main', name: 'Main' }],
    subagents: { enabled: true, paused: false, profiles: [{
      providerId: 'echo', accountId: account.id, model: 'old-helper', effort: null, id: 'helper', name: 'Helper',
    }] },
    autoMemory: false, dailyBudgetUsd: null,
  };
  agent = await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config });
  approvedModels = provider.models;
  // The provider's next catalog replaces both previously approved model IDs.
  provider.models = [{ id: 'current', name: 'Current', default: true }];
});
afterEach(async () => { await h?.stop(); });

const save = (value: AgentRuntimeConfig) => client.call('agents.runtime.configure', {
  agentId: agent.id, expectedRevision: agent.revision, config: value,
});

test('runtime settings keep approved models and effort after the provider replaces its catalog', async () => {
  const provider = h.core.providers.require('echo');
  const currentModels = provider.models;
  provider.models = approvedModels;
  const threadId = h.core.workforce.sessionOf(agent.id)!.threadId;
  await client.call('turns.start', { threadId, prompt: 'Hello' });
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  provider.models = currentModels;
  config.defaultRoute = { ...agent.selection, permissionMode: 'yolo' };
  agent = await save(config);
  expect(agent.selection).toMatchObject({ model: 'echo', effort: 'high', permissionMode: 'yolo' });
  let stored = await client.call('agents.runtime.get', { agentId: agent.id });
  expect(stored.allowedRoutes[0]).toMatchObject({ id: 'main', model: 'echo', effort: 'high' });
  expect(stored.subagents.profiles).toEqual(config.subagents.profiles);

  // Picking a listed replacement keeps the other approved routes intact.
  config = { ...stored, defaultRoute: { ...agent.selection, model: 'current', effort: null } };
  config.allowedRoutes.push({ ...config.defaultRoute, model: 'current', id: 'current', name: 'Current' });
  agent = await save(config);
  stored = await client.call('agents.runtime.get', { agentId: agent.id });
  expect(stored.defaultRoute).toMatchObject({ model: 'current', effort: null });
  expect(stored.allowedRoutes.map(route => route.model)).toEqual(['echo', 'current']);
  expect(stored.subagents.profiles[0]?.model).toBe('old-helper');
});

test('changed models, efforts and newly added routes still require the current catalog', async () => {
  const attempts: AgentRuntimeConfig[] = [
    { ...config, defaultRoute: { ...agent.selection, model: 'unknown' } },
    { ...config, defaultRoute: { ...agent.selection, effort: 'max' } },
    { ...config, allowedRoutes: [{ ...config.allowedRoutes[0]!, model: 'unknown' }] },
    { ...config, allowedRoutes: [...config.allowedRoutes, { ...config.allowedRoutes[0]!, id: 'added' }] },
    { ...config, subagents: { ...config.subagents, profiles: [{ ...config.subagents.profiles[0]!, model: 'unknown' }] } },
    { ...config, subagents: { ...config.subagents, profiles: [{ ...config.subagents.profiles[0]!, effort: 'max' }] } },
  ];
  for (const attempt of attempts) {
    const error = await save(attempt).catch(error => error);
    expect(error.message).toMatch(/does not offer this (model|reasoning effort)/);
    expect((await client.call('agents.runtime.get', { agentId: agent.id })).defaultRoute).toEqual(agent.selection);
  }
  // A previously approved choice never bypasses a withdrawn account grant.
  await client.call('agents.accounts.set', { grants: [{ accountId: agent.selection.accountId, agentIds: [] }] });
  const error = await save(config).catch(error => error);
  expect(error.message).toContain('account is not granted');
});
