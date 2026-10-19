import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import { modelsFor } from '../src/threads/selection.ts';
import { probedModelsOf } from '../src/drivers/index.ts';
import type { TestCore } from './harness.ts';

/**
 * A real `/goal2` on the user's own Claude login: Haiku does the work and
 * reviews it, the checklist runs on Automatic (Opus at medium). Both children
 * start after the account check that forgets Claude's model list, so each
 * reads it again first. Opt-in, it spends a few
 * cents of the subscription.
 */
const live = process.env['BOITE_E2E_CLAUDE'] === '1' ? describe : describe.skip;

live('goal checklist, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-live-goal-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test('Opus writes the checklist with the correction kept, and checks both items done', async () => {
    const client = await harness.connect();
    const project = await client.call('projects.add', { path: projectDir, name: 'live goal' });
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'claude' && entry.label === 'Default');
    if (account === undefined) throw new Error('no default claude account on this machine');
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'claude', accountId: account.id, model: 'claude-haiku-5-5', cwd: projectDir, permissionMode: 'bypassPermissions', title: 'live goal' });

    await client.call('threads.activity.set', { threadId: thread.id, goal: { objective: 'crée hello.txt avec hi dedans. et aussi bye.txt avec bye, ou plutot au revoir dedans', review: true } });
    const report = () => {
      const goal = harness.core.activity.get(thread.id).goal;
      const family = [thread.id, ...harness.core.journal.listThreads().filter((row) => row.parentThreadId === thread.id).map((row) => row.id)];
      console.log(JSON.stringify({ goal: { ...goal, objective: undefined }, threads: family.map((id) => ({ id, model: harness.core.threads.get(id).model, effort: harness.core.threads.get(id).effort, status: harness.core.threads.get(id).status, turns: harness.core.journal.listTurns(id).map((turn) => [turn.status, turn.error]) })), permissions: harness.core.threads.listPermissions().map((request) => [request.threadId, request.toolName]), listed: modelsFor(harness.core.providers.require('claude'), account.id).map((model) => model.id), probed: probedModelsOf('claude-sdk', 'claude', account.id)?.map((model) => model.id) ?? null }, null, 1));
    };
    try {
      await waitFor(() => { const goal = harness.core.activity.get(thread.id).goal; return goal?.status === 'complete' || goal?.status === 'paused'; }, 240_000);
    } finally { report(); }

    const goal = harness.core.activity.get(thread.id).goal!;
    expect(goal.status).toBe('complete');
    const list = goal.checklist!;
    expect(list).toMatchObject({ model: 'claude/claude-opus-5-5', effort: 'medium', error: null, phase: 'idle' });
    expect(harness.core.threads.get(list.threadId!).contextMode).toMatchObject({ tools: ['Read'], guides: false });
    expect(list.items.length).toBeGreaterThanOrEqual(2);
    expect(list.items.every((item) => item.status === 'done')).toBe(true);
    // The correction keeps its final meaning.
    expect(list.items.some((item) => /au revoir/i.test(item.text))).toBe(true);
    expect(readFileSync(join(projectDir, 'bye.txt'), 'utf8')).toMatch(/au revoir/i);
    expect(existsSync(join(projectDir, 'hello.txt'))).toBe(true);
  }, 300_000);
});
