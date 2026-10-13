import { expect, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import { LIGHT_CHILD_TOOLS } from '../src/drivers/claude/session.ts';
import { waitFor } from './harness.ts';
import { answerEach, calls, claudeThread, harness, runTurn, scripted, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

/** The scripted catalog's Haiku. */
const HAIKU = 'claude-haiku-4-5-20251001';

test('a delegated Haiku child starts light and an Opus child keeps the whole setup', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const accountId = harness.core.threads.require(threadId).accountId;
  scripted(() => {}, answerEach('sess-team'));
  // The parent's own turn: the reference for what a full session receives.
  expect(await runTurn(client, threadId, 'plan the work')).toBe('done');
  const profile = (id: string, model: string) => ({ id, name: id, providerId: 'claude', accountId, model, effort: null });
  await client.call('delegation.configure', {
    threadId,
    config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [profile('small', HAIKU), profile('deep', 'claude-opus-5')] },
  });
  const run = async (profileId: string, model: string) => {
    await client.call('delegation.spawn', { threadId, profileId, task: 'Count the lines of README.md', requestId: profileId });
    await waitFor(() => calls.some(call => call.options.model === model && call.prompts.length > 0), 10000);
    return calls.find(call => call.options.model === model)!;
  };

  const light = await run('small', HAIKU);
  expect(light.options).toMatchObject({ tools: [...LIGHT_CHILD_TOOLS], strictMcpConfig: true, mcpServers: {}, disallowedTools: ['Agent', 'Task', 'Workflow'] });
  expect(light.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', BOITE_LIGHT: '1' });
  // The user's settings stay: their hooks guard the child and their compaction window applies.
  expect(light.options.settingSources).toEqual(['user', 'project', 'local']);
  expect(light.prompts[0]).toContain('Count the lines of README.md');
  // The brief alone: the team reminder that repeats it stays out too.
  expect(light.prompts[0]).not.toContain('You are a Boite subagent of');

  const full = await run('deep', 'claude-opus-5');
  expect(full.options.tools).toBeUndefined();
  expect(full.options.strictMcpConfig).toBeUndefined();
  expect(full.options.env?.['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined();
  expect(full.options.env?.['BOITE_LIGHT']).toBeUndefined();
  expect(full.prompts[0]).toContain('You are a Boite subagent of');
}, 20000);
