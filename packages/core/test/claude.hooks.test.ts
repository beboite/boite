import { describe, expect, test } from 'bun:test';
import { hookEndPart, hookReport } from '../src/drivers/claude/hooks.ts';
import { claudeThread, calls, harness, init, runTurn, scripted, sdk, success, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

/** `hook_response` as CLI 2.1.267 writes it with `includeHookEvents`. */
function hookResponse(fields: { name: string; event: string; exit: number; outcome?: string; stdout?: string; stderr?: string }) {
  return sdk({
    type: 'system',
    subtype: 'hook_response',
    hook_id: `hook-${fields.name}`,
    hook_name: fields.name,
    hook_event: fields.event,
    output: fields.stderr ?? fields.stdout ?? '',
    stdout: fields.stdout ?? '',
    stderr: fields.stderr ?? '',
    exit_code: fields.exit,
    outcome: fields.outcome ?? (fields.exit === 0 ? 'success' : 'error'),
    uuid: 'u',
    session_id: 'sess-hooks',
  });
}

/** The CLI's own words when a UserPromptSubmit hook exits 2 (CLI 2.1.267, probed live). */
const BLOCKED = 'UserPromptSubmit operation blocked by hook:\n[node -e "process.exit(2)"]: blocked by test hook\n\nOriginal prompt: BLOCKME say hi';

describe('claude hooks', () => {
  test('a prompt a hook refused shows why in the thread, and Settings counts every run', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted(() => undefined, (fake) => {
      fake.emit(hookResponse({ name: 'SessionStart:startup', event: 'SessionStart', exit: 0, stdout: '{"systemMessage":"hi"}' }));
      fake.emit(hookResponse({ name: 'UserPromptSubmit', event: 'UserPromptSubmit', exit: 2, stderr: 'blocked by test hook' }));
      fake.emit(init('sess-hooks'));
      fake.emit(sdk({ type: 'system', subtype: 'informational', content: BLOCKED, level: 'warning', prevent_continuation: true, uuid: 'u', session_id: 'sess-hooks' }));
      fake.emit(success('sess-hooks'));
    });

    const changed = client.next('hooks.changed', () => true, 10000);
    expect(await runTurn(client, threadId, 'BLOCKME say hi')).toBe('done');
    await changed;

    expect(calls[0]?.options.includeHookEvents).toBe(true);
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'hook', event: 'UserPromptSubmit', outcome: 'blocked', message: 'blocked by test hook' },
    ]);

    const status = await client.call('hooks.status', {});
    const claude = status.providers.find((provider) => provider.providerId === 'claude');
    expect(claude).toMatchObject({ runsHooks: true, reports: true, runs: 2, blocked: 1, failed: 0, skipped: 0 });
    // A test core never reads the developer's own profile: the path, no count.
    expect(claude?.sources).toEqual([{ path: expect.stringMatching(/settings.json$/), format: 'events', count: null, error: null }]);
    expect(claude?.accounts.map((account) => account.problems)).toEqual([[]]);
    expect(status.recent).toEqual([expect.objectContaining({
      providerId: 'claude',
      threadId,
      event: 'UserPromptSubmit',
      name: 'UserPromptSubmit',
      outcome: 'blocked',
      message: 'blocked by test hook',
    })]);
  });

  test('a hook_response reads as the ledger counts it', () => {
    const report = (fields: Parameters<typeof hookResponse>[0]) => hookReport(hookResponse(fields) as Parameters<typeof hookReport>[0]);
    expect(report({ name: 'PreToolUse:Bash', event: 'PreToolUse', exit: 2, stderr: 'no bash here' }))
      .toEqual({ event: 'PreToolUse', name: 'PreToolUse:Bash', outcome: 'blocked', message: 'no bash here' });
    expect(report({ name: 'Stop', event: 'Stop', exit: 1, stderr: 'stop hook broke' }))
      .toEqual({ event: 'Stop', name: 'Stop', outcome: 'failed', message: 'stop hook broke' });
    expect(report({ name: 'Stop', event: 'Stop', exit: 0, outcome: 'cancelled' }))
      .toMatchObject({ outcome: 'failed', message: 'cancelled before it answered' });
    expect(report({
      name: 'PreToolUse:Write', event: 'PreToolUse', exit: 0,
      stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"not in this repo"}}',
    })).toMatchObject({ outcome: 'blocked', message: 'not in this repo' });
    expect(report({ name: 'Stop', event: 'Stop', exit: 0, stdout: '{"continue":false,"stopReason":"budget spent"}' }))
      .toMatchObject({ outcome: 'stopped', message: 'budget spent' });
    expect(report({ name: 'SessionStart:startup', event: 'SessionStart', exit: 0, stdout: '{"systemMessage":"hi"}' }))
      .toEqual({ event: 'SessionStart', name: 'SessionStart:startup', outcome: 'ok', message: null });
  });

  test('the end of a turn by a hook keeps the reason and drops the command', () => {
    expect(hookEndPart(BLOCKED)).toEqual({ type: 'hook', event: 'UserPromptSubmit', outcome: 'blocked', message: 'blocked by test hook' });
    expect(hookEndPart('Stop operation blocked by hook:\n[./stop.sh]: tests are red'))
      .toEqual({ type: 'hook', event: 'Stop', outcome: 'stopped', message: 'tests are red' });
    expect(hookEndPart('something the CLI said')).toEqual({ type: 'hook', event: 'Stop', outcome: 'stopped', message: 'something the CLI said' });
  });
});
