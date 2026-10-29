import { expect, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG, LIGHT_TOOLS, TOOL_FREE_CONTEXT } from '@boite/contracts';
import { waitFor } from './harness.ts';
import { answerEach, calls, claudeThread, harness, runTurn, scripted, useClaudeHarness } from './fixtures/claude-query.ts';
import { thrown } from './settle.ts';

useClaudeHarness();

/** Synthetic profile flags reach only this test core's isolated accounts. */
function accountFlags(disabled: boolean): void {
  for (const profile of Object.values(harness.core.providers.require('claude').profiles)) {
    if (profile) profile.env = { ...profile.env, BOITE_GUIDES: disabled ? '0' : '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: disabled ? '1' : '0', BOITE_CONTEXT: 'profile-context', BOITE_TEST_CONTEXT_KEEP: 'kept' };
  }
}

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
  accountFlags(false);
  const { spawn } = await team();

  const { child, call } = await spawn('light', 'light');
  expect(child.contextMode).toMatchObject({ label: 'light', instructions: false, guides: false, mcp: false, hooks: true });
  expect(call.options).toMatchObject({ tools: [...LIGHT_TOOLS], strictMcpConfig: true, mcpServers: {}, disallowedTools: ['Agent', 'Task', 'Workflow'] });
  expect(call.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', BOITE_CONTEXT: 'light', BOITE_GUIDES: '0', BOITE_TEST_CONTEXT_KEEP: 'kept' });
  // The user's settings stay: their hooks still guard the child and their compaction window applies.
  expect(call.options.settingSources).toEqual(['user', 'project', 'local']);
  expect(call.options.settings).not.toHaveProperty('disableAllHooks');
  // Claude Code's model-tuned prompt stays (Haiku's own autonomy section rides on it); Boite's guide does not.
  expect(call.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', excludeDynamicSections: true });
  expect(call.prompts[0]).toContain('Count the lines of README.md');
  expect(call.prompts[0]).not.toContain('You are a Boite subagent of');

  const plain = await spawn('plain');
  expect(plain.child.contextMode).toBeUndefined();
  expect(plain.call.options.tools).toBeUndefined();
  expect(plain.call.options.strictMcpConfig).toBeUndefined();
  expect(plain.call.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0', BOITE_GUIDES: '1', BOITE_CONTEXT: 'profile-context', BOITE_TEST_CONTEXT_KEEP: 'kept' });
  expect(plain.call.prompts[0]).toContain('You are a Boite subagent of');

  accountFlags(true);
  // Rules keep this otherwise full request as an explicit, non-null context mode.
  const kept = await spawn('kept', { preset: 'full', rules: 'Keep all configured context.' });
  expect(kept.child.contextMode).toMatchObject({ instructions: true, guides: true });
  expect(kept.call.options.env?.['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined();
  expect(kept.call.options.env?.['BOITE_GUIDES']).toBeUndefined();
  expect(kept.call.options.env).toMatchObject({ BOITE_CONTEXT: 'custom', BOITE_TEST_CONTEXT_KEEP: 'kept' });

  const plainDisabled = await spawn('plain-disabled');
  expect(plainDisabled.child.contextMode).toBeUndefined();
  expect(plainDisabled.call.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', BOITE_GUIDES: '0',
    BOITE_CONTEXT: 'profile-context', BOITE_TEST_CONTEXT_KEEP: 'kept' });
});

test('a neutral child with rules runs no user hook, keeps every tool and reads the rules first', async () => {
  accountFlags(false);
  const { spawn } = await team();
  const rules = 'Review as a stranger: no house style, no prior decisions.';
  const { child, call } = await spawn('neutral', { preset: 'neutral', keep: ['mcp'], rules });
  expect(child.contextMode).toEqual({ label: 'custom', instructions: false, guides: false, mcp: true, hooks: false, tools: null, rules });
  expect(call.options.settings).toMatchObject({ disableAllHooks: true });
  expect(call.options.tools).toBeUndefined();
  expect(call.options.strictMcpConfig).toBeUndefined();
  expect(call.options.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', BOITE_GUIDES: '0', BOITE_CONTEXT: 'custom', BOITE_TEST_CONTEXT_KEEP: 'kept' });
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
  expect(await thrown(client.call('threads.create', { projectId: parent.projectId!, providerId: 'claude', accountId: parent.accountId, context: { preset: 'tiny' as never } })))
    .toThrow('context.preset: expected full, light, neutral');
});

test('a tool-free child, as a memory pass runs, starts with no built-in tool, MCP server or hook and approves nothing', async () => {
  accountFlags(false);
  const client = await harness.connect();
  const parent = harness.core.threads.require(await claudeThread(client));
  scripted(() => {}, answerEach('sess-free'));
  const child = harness.core.delegation.createChild(parent, { id: 'memory', name: 'Memory', providerId: 'claude', accountId: parent.accountId, model: parent.model, effort: null },
    'Memory', () => {}, undefined, false, { contextMode: TOOL_FREE_CONTEXT, permissionMode: 'dontAsk' });
  expect(harness.core.threads.require(child)).toMatchObject({ permissionMode: 'dontAsk', contextMode: { tools: [], mcp: false, hooks: false, instructions: false, guides: false } });
  const before = calls.length;
  harness.core.threads.startTurn(child, 'Rewrite the memory');
  const own = () => calls.slice(before).find(call => call.prompts[0]?.includes('Rewrite the memory'));
  await waitFor(() => own() !== undefined, 10000);
  expect(own()!.options).toMatchObject({ tools: [], strictMcpConfig: true, mcpServers: {}, permissionMode: 'dontAsk' });
  expect(own()!.options.settings).toMatchObject({ disableAllHooks: true });
});
