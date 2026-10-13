import { expect, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG, LIGHT_TOOLS } from '@boite/contracts';
import { waitFor } from './harness.ts';
import { answerEach, calls, claudeThread, harness, runTurn, scripted, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

/** A parent on the scripted Claude, its first turn done, and a spawn that returns the child's first query. */
async function team() {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(() => {}, answerEach('sess-team'));
  expect(await runTurn(client, threadId, 'plan the work')).toBe('done');
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  const spawn = async (requestId: string, context?: Parameters<typeof client.call<'delegation.spawn'>>[1]['context']) => {
    const before = calls.length;
    const child = await client.call('delegation.spawn', { threadId, task: 'Count the lines of README.md', requestId, ...(context === undefined ? {} : { context }) });
    // The child's own query: the parent may open one too, to hear about its child.
    const own = () => calls.slice(before).find(call => call.prompts[0]?.includes('Count the lines of README.md'));
    await waitFor(() => own() !== undefined, 10000);
    return { child: child.thread, call: own()! };
  };
  return { client, threadId, spawn };
}

test('a light child starts with its brief, its hooks and a few tools; a plain one keeps the whole setup', async () => {
  const { spawn } = await team();

  const { child, call } = await spawn('light', 'light');
  expect(child.contextMode).toMatchObject({ label: 'light', instructions: false, guides: false, mcp: false, hooks: true });
  expect(call.options).toMatchObject({ tools: [...LIGHT_TOOLS], strictMcpConfig: true, mcpServers: {}, disallowedTools: ['Agent', 'Task', 'Workflow'] });
  expect(call.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', BOITE_CONTEXT: 'light', BOITE_GUIDES: '0' });
  // The user's settings stay: their hooks still guard the child and their compaction window applies.
  expect(call.options.settingSources).toEqual(['user', 'project', 'local']);
  expect(call.options.settings).not.toHaveProperty('disableAllHooks');
  expect(call.prompts[0]).toContain('Count the lines of README.md');
  expect(call.prompts[0]).not.toContain('You are a Boite subagent of');

  const plain = await spawn('plain');
  expect(plain.child.contextMode).toBeUndefined();
  expect(plain.call.options.tools).toBeUndefined();
  expect(plain.call.options.strictMcpConfig).toBeUndefined();
  expect(plain.call.options.env?.['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined();
  expect(plain.call.options.env?.['BOITE_CONTEXT']).toBeUndefined();
  expect(plain.call.prompts[0]).toContain('You are a Boite subagent of');
});

test('a neutral child with rules runs no user hook, keeps every tool and reads the rules first', async () => {
  const { spawn } = await team();
  const rules = 'Review as a stranger: no house style, no prior decisions.';
  const { child, call } = await spawn('neutral', { preset: 'neutral', keep: ['mcp'], rules });
  expect(child.contextMode).toEqual({ label: 'custom', instructions: false, guides: false, mcp: true, hooks: false, tools: null, rules });
  expect(call.options.settings).toMatchObject({ disableAllHooks: true });
  expect(call.options.tools).toBeUndefined();
  expect(call.options.strictMcpConfig).toBeUndefined();
  expect(call.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', BOITE_CONTEXT: 'custom' });
  expect(call.prompts[0]!.startsWith('Rules for this conversation')).toBe(true);
  expect(call.prompts[0]).toContain(rules);
});

test('a conversation started in a context mode keeps it after a core restart', async () => {
  const client = await harness.connect();
  const parent = harness.core.threads.require(await claudeThread(client));
  const thread = await client.call('threads.create', {
    projectId: parent.projectId!, providerId: 'claude', accountId: parent.accountId, context: { preset: 'full', drop: ['guides'], rules: 'Answer in one word.' },
  });
  expect(thread.contextMode).toEqual({ label: 'custom', instructions: true, guides: false, mcp: true, hooks: true, tools: null, rules: 'Answer in one word.' });
  expect(harness.core.journal.getThread(thread.id)?.contextMode).toEqual(thread.contextMode);
  await expect(client.call('threads.create', { projectId: parent.projectId!, providerId: 'claude', accountId: parent.accountId, context: { preset: 'tiny' as never } }))
    .rejects.toThrow('context.preset: expected full, light, neutral');
});
