import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Turn } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { waitFor } from './harness.ts';
import {
  answerEach,
  assistant,
  calls,
  claudeThread,
  harness,
  init,
  queries,
  runTurn,
  scripted,
  sdk,
  success,
  useClaudeHarness,
} from './fixtures/claude-query.ts';

useClaudeHarness();

describe('claude driver', () => {
  test.each([false, true])('an unfinished live control cannot change the next turn after Stop=%s', async stop => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    const control = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    let changing = false;
    scripted(fake => {
      fake.emit(init('sess-control-owner'));
      if (queries.length !== 1) return;
      const apply = fake.applyFlagSettings.bind(fake);
      fake.applyFlagSettings = async settings => {
        if (settings.disableAllHooks === true) {
          changing = true;
          await control.promise;
        }
        await apply(settings);
        answered.resolve();
      };
    });
    const first = await client.call('turns.start', { threadId, prompt: 'First task' });
    await waitFor(() => calls[0]?.prompts.length === 1);
    await client.call('threads.update', { threadId, permissionMode: 'yolo' });
    await waitFor(() => changing);
    const previous = queries[0]!;
    if (stop) await client.call('turns.stop', { threadId });
    else previous.emit(success('sess-control-owner'));
    await waitFor(() => harness.core.journal.getTurn(first.id)?.status === (stop ? 'stopped' : 'done'));

    await client.call('threads.update', { threadId, permissionMode: 'default' });
    const next = await client.call('turns.start', { threadId, prompt: 'Next task' });
    // A control that never answers must not hold the next prompt or the finished turn.
    await waitFor(() => calls.some(call => call.prompts.some(prompt => prompt.endsWith('Next task'))));
    if (stop) expect(calls.at(-1)!.prompts.at(-1)).toContain('First task');
    expect(harness.core.journal.getTurn(next.id)?.status).toBe('running');
    control.resolve();
    await answered.promise;
    await Bun.sleep(0);
    // The former owner's delayed overlay must not issue its second native control.
    expect(previous.setters).not.toContain('setPermissionMode bypassPermissions');
    expect(calls.at(-1)!.options.permissionMode).toBe('default');
    expect(queries.at(-1)!.setters).not.toContain('disableAllHooks true');
    expect(harness.core.threads.require(threadId).permissionMode).toBe('default');
    expect(harness.core.journal.getTurn(next.id)?.execution?.permissionMode).toBe('default');
    queries.at(-1)!.emit(success('sess-control-owner'));
    await waitFor(() => harness.core.journal.getTurn(next.id)?.status === 'done');
  });

  test('permission mode and hook changes reach a running query without another prompt', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted(fake => fake.emit(init('sess-live-mode')));
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => calls[0]?.prompts.length === 1);
    for (const mode of ['bypassPermissions', 'yolo', 'default'] as const) {
      await client.call('threads.update', { threadId, permissionMode: mode });
      const expected = mode === 'yolo' ? 'disableAllHooks true' : `setPermissionMode ${mode}`;
      await waitFor(() => queries[0]!.setters.includes(expected));
    }
    expect(queries[0]!.setters).toContain('disableAllHooks the default');
    expect(queries).toHaveLength(1);
    expect(calls[0]!.prompts).toEqual(['Keep working']);
    expect(queries[0]!.interrupts).toBe(0);
    const snapshot = await client.call('threads.get', { threadId });
    expect(snapshot.turns[0]).toMatchObject({ id: turn.id, status: 'running' });
    queries[0]!.emit(success('sess-live-mode'));
    await waitFor(() => harness.core.journal.getTurn(turn.id)?.status === 'done');
  });
  test('effort and fast mode off reach a running query; fast mode on waits for the next turn', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    harness.core.providers.require('claude').models.find(model => model.id === 'claude-opus-5')!.speeds = [{ id: 'fast', label: 'Fast' }];
    await client.call('threads.update', { threadId, model: 'claude-opus-5', effort: 'low', speed: 'fast' });
    scripted(fake => fake.emit(init('sess-live-effort')), (fake, _prompt, index) => { if (index > 0) fake.emit(success('sess-live-effort')); });
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => calls[0]?.prompts.length === 1);
    expect(calls[0]!.options).toMatchObject({ effort: 'low', settings: { fastMode: true } });

    await client.call('threads.update', { threadId, effort: 'high' });
    await waitFor(() => queries[0]!.setters.includes('effortLevel high'));
    await client.call('threads.update', { threadId, speed: null });
    await waitFor(() => harness.core.journal.getTurn(turn.id)?.execution?.speed === null);
    expect(harness.core.journal.getTurn(turn.id)?.execution).toMatchObject({ effort: 'high', speed: null });
    // A running CLI cannot be trusted to switch fast mode on: nothing is sent,
    // and the effort change queued behind it shows the speed one was handled.
    await client.call('threads.update', { threadId, speed: 'fast' });
    await client.call('threads.update', { threadId, effort: 'xhigh' });
    await waitFor(() => queries[0]!.setters.includes('effortLevel xhigh'));
    expect(queries[0]!.setters).toEqual(['effortLevel high', 'fastMode false', 'effortLevel xhigh']);
    expect(queries[0]!.interrupts).toBe(0);
    expect(calls[0]!.prompts).toEqual(['Keep working']);
    queries[0]!.emit(success('sess-live-effort'));
    await waitFor(() => harness.core.journal.getTurn(turn.id)?.status === 'done');
    expect(harness.core.journal.getTurn(turn.id)?.execution).toMatchObject({ effort: 'xhigh', speed: null });

    // The next turn carries the speed, on the same process when the CLI reports it on.
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.setters).toEqual(['effortLevel high', 'fastMode false', 'effortLevel xhigh', 'fastMode true']);
  });

  test('a running CLI that keeps fast mode off moves the turn to a process launched with it', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    harness.core.providers.require('claude').models.find(model => model.id === 'claude-opus-5')!.speeds = [{ id: 'fast', label: 'Fast' }];
    await client.call('threads.update', { threadId, model: 'claude-opus-5' });
    scripted((fake) => { fake.fastStaysOff = true; }, answerEach('sess-fast-off'));
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    await client.call('threads.update', { threadId, speed: 'fast' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    // The setter was accepted and the frame that followed still said `off`.
    expect(queries[0]!.setters).toEqual(['fastMode true']);
    expect(queries).toHaveLength(2);
    expect(calls[1]!.options).toMatchObject({ resume: 'sess-fast-off', settings: { fastMode: true } });
    expect(calls.map(call => call.prompts)).toEqual([['first'], ['second']]);
    // Switching it off again needs no new process.
    await client.call('threads.update', { threadId, speed: null });
    expect(await runTurn(client, threadId, 'third')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(queries[1]!.setters).toEqual(['fastMode false']);
  });

  test('viewing initializes a prompt-free query and retains it across real turns at zero minutes', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted(fake => fake.emit(init('sess-prepared')), answerEach('sess-prepared'));
    await client.call('threads.focus', { threadId });
    await waitFor(() => queries.length === 1);
    expect(calls[0]!.prompts).toEqual([]);
    expect(harness.core.journal.listTurns(threadId)).toHaveLength(0);
    expect(harness.core.journal.listMessages(threadId)).toHaveLength(0);
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(queries).toHaveLength(1);
    expect(calls[0]!.prompts).toEqual(['first', 'second']);
    await client.call('threads.focus', { threadId: null });
    await client.call('threads.focus', { threadId });
    expect(await runTurn(client, threadId, 'back')).toBe('done');
    expect(queries).toHaveLength(1);
    await client.call('threads.archive', { threadId });
    await waitFor(() => queries[0]!.closes > 0);
  });

  test('a prepared query applies the effort and speed selected before the first prompt', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    harness.core.providers.require('claude').models.find(model => model.id === 'claude-opus-5')!.speeds = [{ id: 'fast', label: 'Fast' }];
    await client.call('threads.update', { threadId, model: 'claude-opus-5' });
    scripted(fake => fake.emit(init('sess-prepared')), answerEach('sess-prepared'));
    await client.call('threads.focus', { threadId });
    await waitFor(() => queries.length === 1);
    await client.call('threads.update', { threadId, effort: 'high', speed: 'fast' });
    expect(await runTurn(client, threadId, 'real prompt')).toBe('done');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.setters).toContain('effortLevel high');
    expect(queries[0]!.setters).toContain('fastMode true');
    expect(calls[0]!.options.settings).toEqual({ fastMode: false, autoMemoryEnabled: false });
    expect(calls[0]!.prompts).toHaveLength(1);
  });

  /** One plain turn on a thread set to `effort`, so the test can read what the SDK got. */
  async function turnWithEffort(effort: string | null): Promise<{ options: Options; prompt: string }> {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const updated = await client.call('threads.update', { threadId, effort });
    expect(updated.effort).toBe(effort);

    scripted((fake) => {
      fake.emit(init('sess-effort'));
      fake.emit(success('sess-effort'));
      fake.end();
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'ping' });
    expect((await finished).status).toBe('done');

    const call = calls[0];
    if (call === undefined) throw new Error('the driver never called the SDK');
    await waitFor(() => call.prompts.length > 0);
    return { options: call.options, prompt: call.prompts[0] ?? '' };
  }

  test('a named effort level goes to the SDK as an option and leaves the prompt alone', async () => {
    const { options, prompt } = await turnWithEffort('xhigh');
    expect(options.effort).toBe('xhigh');
    expect(prompt).toBe('ping');
  });

  test('ultrathink passes no effort option and appends the word to the prompt once', async () => {
    const { options, prompt } = await turnWithEffort('ultrathink');
    expect(options.effort).toBeUndefined();
    expect(prompt).toBe('ping ultrathink');
  });

  test('a thread with no effort sends none, so the CLI keeps its own default', async () => {
    const { options, prompt } = await turnWithEffort(null);
    expect(options.effort).toBeUndefined();
    expect(prompt).toBe('ping');
  });
  // -- warm sessions --------------------------------------------------------

  test('two turns on a warm thread share one query and one prompt stream', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-warm'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(1);
    expect(calls[0]?.prompts).toEqual(['first', 'second']);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe('sess-warm');
  });

  test('a warm query reports a running total, and each turn is charged its own share', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    // The CLI counts `total_cost_usd` from the start of its process: 0.25, then 0.25 + 0.05.
    scripted(() => undefined, (fake, _prompt, index) => {
      fake.emit(init('sess-cost'));
      fake.emit(sdk({ ...(success('sess-cost') as object), total_cost_usd: index === 0 ? 0.25 : 0.3 }));
    });

    const costs: (number | null)[] = [];
    for (const prompt of ['first', 'second']) {
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt });
      costs.push((await finished).usage?.costUsdEquivalent ?? null);
    }

    expect(queries).toHaveLength(1);
    expect(costs[0]).toBeCloseTo(0.25, 10);
    expect(costs[1]).toBeCloseTo(0.05, 10);
  });

  test('a cold query that resumes a session is charged its own share, whether or not the CLI restored its totals', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    // Each turn uses 26 tokens. The second process restores the session (52 tokens held, 0.25 + 0.05);
    // the third has lost it and counts from zero. The fourth restores only what the third saved
    // (0.07 + 0.04), less than the session's turns add up to; the fifth restores the fourth's totals
    // and makes no request. The sixth reports zeroed totals, as a startup error does, and the seventh
    // still restores the fifth's (0.11 + 0.02). The eighth gets an older save back (52 tokens restored
    // where the last total held 78), so its own share is unknown.
    const held = (tokens: number) => ({ 'claude-test': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 } });
    const idle = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const results = [
      { total_cost_usd: 0.25, modelUsage: held(26) },
      { total_cost_usd: 0.3, modelUsage: held(52) },
      { total_cost_usd: 0.07, modelUsage: held(26) },
      { total_cost_usd: 0.11, modelUsage: held(52) },
      { total_cost_usd: 0.11, modelUsage: held(52), usage: idle },
      { total_cost_usd: 0, modelUsage: {}, usage: idle },
      { total_cost_usd: 0.13, modelUsage: held(78) },
      { total_cost_usd: 0.14, modelUsage: held(78) },
    ];
    let turn = 0;
    scripted(() => undefined, (fake) => {
      fake.emit(init('sess-resumed'));
      fake.emit(sdk({ ...(success('sess-resumed') as object), ...results[turn++] }));
    });

    const costs: (number | null)[] = [];
    for (const prompt of ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']) {
      const finished = client.next('turn.finished', (finishedTurn) => finishedTurn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt });
      costs.push((await finished).usage?.costUsdEquivalent ?? null);
    }

    expect(queries).toHaveLength(8);
    expect(costs[0]).toBeCloseTo(0.25, 10);
    expect(costs[1]).toBeCloseTo(0.05, 10);
    expect(costs[2]).toBeCloseTo(0.07, 10);
    expect(costs[3]).toBeCloseTo(0.04, 10);
    expect(costs[4]).toBeCloseTo(0, 10);
    expect(costs[5]).toBeCloseTo(0, 10);
    expect(costs[6]).toBeCloseTo(0.02, 10);
    expect(costs[7]).toBeNull();
  });

  test('a resumed CLI that restored less than the journal holds leaves the turn unpriced instead of charging the session again', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    // The second process restored the session's tokens (52 held for a 26-token turn) but a total of 0.1, under the 0.25
    // the journal already charged. Charging 0.1 would count the first turn twice, and every later resume more.
    const held = (tokens: number) => ({ 'claude-test': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 } });
    const results = [{ total_cost_usd: 0.25, modelUsage: held(26) }, { total_cost_usd: 0.1, modelUsage: held(52) }];
    let turn = 0;
    scripted(() => undefined, (fake) => {
      fake.emit(init('sess-short'));
      fake.emit(sdk({ ...(success('sess-short') as object), ...results[turn++] }));
    });

    const finished: Turn[] = [];
    for (const prompt of ['first', 'second']) {
      const done = client.next('turn.finished', (finishedTurn) => finishedTurn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt });
      finished.push(await done);
    }

    expect(queries).toHaveLength(2);
    expect(finished[0]?.usage?.costUsdEquivalent).toBeCloseTo(0.25, 10);
    // The tokens stay, so the usage page still prices the turn at the model's rates.
    expect(finished[1]?.usage).toMatchObject({ costUsdEquivalent: null });
    expect(finished[1]?.usage?.inputTokens).toBeGreaterThan(0);
  });

  test('warmProcessMinutes at zero keeps one query per turn', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    expect((await client.call('settings.get', {})).warmProcessMinutes).toBe(0);

    scripted(() => undefined, answerEach('sess-cold'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(calls[0]?.prompts).toEqual(['first']);
    expect(calls[1]?.prompts).toEqual(['second']);
  });

  test('a model, an effort and a mode changed between the turns go to the live query', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-live'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    // Nothing moved yet: the query opened on all three.
    expect(queries[0]?.setters).toEqual([]);

    await client.call('threads.update', {
      threadId,
      model: 'claude-opus-5',
      effort: 'xhigh',
      permissionMode: 'plan',
    });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    // One query and one prompt stream: the CLI took all three in place.
    expect(queries).toHaveLength(1);
    expect(calls[0]?.prompts).toEqual(['first', 'second']);
    expect(calls[0]?.options.model).toBe('claude-sonnet-5');
    expect(calls[0]?.options.effort).toBeUndefined();
    expect(calls[0]?.options.permissionMode).toBe('default');
    expect(queries[0]?.setters).toEqual([
      'setModel claude-opus-5',
      'effortLevel xhigh',
      'setPermissionMode plan',
    ]);
  });

  test('a plan mode Claude entered by itself is put back to the thread mode before the next turn', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    const answer = answerEach('sess-drift');
    scripted(() => undefined, (fake, prompt, index) => {
      if (index === 0) {
        // EnterPlanMode, then an ExitPlanMode the user refused: the CLI stays in plan.
        fake.emit(sdk({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', session_id: 'sess-drift' }));
      }
      answer(fake, prompt, index);
    });

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(await runTurn(client, threadId, 'third')).toBe('done');

    expect(queries).toHaveLength(1);
    expect(harness.core.threads.require(threadId).permissionMode).toBe('default');
    // Once, before the second prompt; the third finds the CLI where the thread wants it.
    expect(queries[0]?.setters).toEqual(['setPermissionMode default']);
  });

  test('warm queries apply Auto and YOLO in place and restore configured hooks', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    scripted(() => undefined, answerEach('sess-mode-switch'));
    for (const mode of ['default', 'bypassPermissions', 'yolo', 'bypassPermissions', 'default'] as const) {
      await client.call('threads.update', { threadId, permissionMode: mode });
      expect(await runTurn(client, threadId, mode)).toBe('done');
    }
    expect(queries).toHaveLength(1);
    expect(calls[0]!.options.allowDangerouslySkipPermissions).toBe(true);
    expect(calls[0]!.options.permissionMode).toBe('default');
    expect(calls[0]!.options.settings).toEqual({ fastMode: false, autoMemoryEnabled: false });
    expect(queries[0]!.setters).toEqual([
      'setPermissionMode bypassPermissions', 'disableAllHooks true',
      'disableAllHooks the default', 'setPermissionMode default',
    ]);
    expect(calls[0]!.prompts).toEqual(['default', 'bypassPermissions', 'yolo', 'bypassPermissions', 'default']);
    expect(queries[0]!.closes).toBe(0);
  });

  test('a turn that changed nothing reaches for no setter at all', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-still'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(1);
    expect(queries[0]?.setters).toEqual([]);
  });

  test('ultrathink on a warm query clears the effort level back to the model default', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    await client.call('threads.update', { threadId, effort: 'xhigh' });

    scripted(() => undefined, answerEach('sess-ultra'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    await client.call('threads.update', { threadId, effort: 'ultrathink' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(1);
    // `ultrathink` is no SDK level: the flag layer is cleared and the word goes
    // in the prompt, exactly what a query opened on `ultrathink` does.
    expect(queries[0]?.setters).toEqual(['effortLevel the default']);
    expect(calls[0]?.prompts).toEqual(['first', 'second ultrathink']);
  });

  test.each(['setModel', 'fastMode'])('a refused %s setter resumes on the new setup and the turn still runs', async (setter) => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    const logs: string[] = [];
    client.on('core.log', (entry) => {
      logs.push(`${entry.level} ${entry.message}`);
    });

    scripted((fake) => {
      // Only the first query refuses; the second opens on the new setup.
      if (queries.length === 1) fake.refuse = setter;
    }, answerEach('sess-refused'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    harness.core.providers.require('claude').models.find(model => model.id === 'claude-opus-5')!.speeds = [{ id: 'fast', label: 'Fast' }];
    await client.call('threads.update', { threadId, model: 'claude-opus-5', ...(setter === 'fastMode' ? { speed: 'fast' } : {}) });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(calls[0]?.options.model).toBe('claude-sonnet-5');
    expect(calls[1]?.options.model).toBe('claude-opus-5');
    expect(calls[1]?.options.settings).toEqual({ fastMode: setter === 'fastMode', autoMemoryEnabled: false });
    expect(calls[1]?.options.resume).toBe('sess-refused');
    expect(calls[0]?.prompts).toEqual(['first']);
    expect(calls[1]?.prompts).toEqual(['second']);
    await waitFor(() => logs.some((line) => line.startsWith('warn claude: the warm session refused')));
  });

  test('the idle window ends the session and the next turn starts a new query', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    // Fractions are minutes too: 0.002 is the 120 ms this test can afford to wait.
    await client.call('settings.set', { warmProcessMinutes: 0.002 });

    scripted(() => undefined, answerEach('sess-idle'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(queries).toHaveLength(1);
    await waitFor(() => (queries[0]?.closes ?? 0) > 0);

    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(calls[1]?.prompts).toEqual(['second']);
  });

  test('stop on a warm session closes it and the next turn starts a new query', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(
      (fake) => {
        fake.emit(init('sess-warm-stop'));
      },
      (fake, prompt, index) => {
        // The first prompt is the one the test stops: nothing answers it.
        if (prompt === 'take your time') return;
        fake.emit(init('sess-warm-again'));
        fake.emit(assistant('sess-warm-again', [{ type: 'text', text: `answer ${index}` }]));
        fake.emit(success('sess-warm-again'));
      },
    );

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'take your time' });
    await waitFor(() => queries.length === 1);
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    expect(queries[0]?.interrupts).toBe(1);

    expect(await runTurn(client, threadId, 'again')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(calls[1]?.prompts).toHaveLength(1);
    expect(calls[1]?.prompts[0]).toContain('take your time');
    expect(calls[1]?.prompts[0]).toEndWith('Current user request:\nagain');
  });

});

test('Claude discovery reports only its model capabilities, caches and refreshes without a prompt', async () => {
  const settingsAtPrompt: string[][] = [];
  const reply = answerEach('native-speeds');
  harness.core.providers.require('claude').models = [];
  scripted(fake => { fake.modelsAnswer = [
    { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)', description: '', supportsFastMode: true },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: 'Opus 5.5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true, supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false, supportsFastMode: false },
    // The shape Claude Code 2.1 answers for a model the descriptor does not list yet.
    { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable for ambitious work' },
    { value: 'claude-opus-6', resolvedModel: 'claude-opus-6', displayName: 'Claude Opus 6', description: '' },
    { value: 'claude-next', resolvedModel: 'claude-next', displayName: ' ', description: '' },
  ];
    if (calls.length > 1) fake.modelsAnswer.push({ value: 'claude-fable-6', displayName: 'Fable 6', description: '' });
  }, (fake, prompt, index) => {
    settingsAtPrompt.push([...fake.setters]);
    reply(fake, prompt, index);
  });
  const client = await harness.connect();
  await client.call('settings.set', { warmProcessMinutes: 5 });
  const id = await claudeThread(client);
  const accountId = (await client.call('threads.get', { threadId: id })).accountId;
  const result = await client.call('providers.probe', { providerId: 'claude', accountId });
  expect(result.models[0]?.name).toBe('Opus 5.5');
  expect(result.models.some(model => /default/i.test(model.name))).toBe(false);
  expect(result.models.some(model => model.id === 'claude-opus-4-8')).toBe(false);
  expect(result.models.every(model => !model.legacy)).toBe(true);
  expect(result.models.find(model => model.id === 'claude-opus-5-5')?.name).toBe('Opus 5.5');
  expect(result.models.find(model => model.id === 'claude-opus-6')?.name).toBe('Opus 6');
  expect(result.models.find(model => model.id === 'claude-next')?.name).toBe('claude-next');
  expect(result.models[0]?.effort?.levels.map(level => level.id)).toEqual(['low', 'high', 'ultrathink']);
  expect(result.models[0]?.speeds).toEqual([{ id: 'fast', label: 'Fast' }]);
  expect(result.models[1]?.effort).toBeUndefined(); expect(result.models[1]?.speeds).toBeUndefined();
  await client.call('providers.probe', { providerId: 'claude', accountId });
  expect(calls).toHaveLength(1); expect(calls[0]?.prompts).toEqual([]); expect(queries[0]?.closes).toBe(1);
  const { grant } = await client.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant });
  try {
    expect((await phone.call('providers.probe', { providerId: 'claude', accountId })).models).toEqual(result.models);
    const refreshed = await phone.call('providers.probe', { providerId: 'claude', accountId, refresh: true });
    expect(calls).toHaveLength(2);
    expect(refreshed.models.find(model => model.id === 'claude-fable-6')).toMatchObject({ name: 'Fable 6' });
    expect(refreshed.models.every(model => !model.legacy)).toBe(true);
    expect(calls.every(call => call.prompts.length === 0)).toBe(true);
  } finally { phone.close(); }
  await client.call('threads.update', { threadId: id, model: 'claude-opus-5', speed: 'fast' });
  expect(await runTurn(client, id, 'fast turn')).toBe('done');
  expect(calls.at(-1)?.options.settings).toEqual({ fastMode: true, autoMemoryEnabled: false });
  const native = queries.at(-1)!;
  const queryCount = queries.length;
  await client.call('threads.update', { threadId: id, speed: null });
  expect(await runTurn(client, id, 'standard turn')).toBe('done');
  expect(queries).toHaveLength(queryCount);
  expect(native.closes).toBe(0);
  await client.call('threads.update', { threadId: id, speed: 'fast' });
  expect(await runTurn(client, id, 'fast again')).toBe('done');
  expect(await runTurn(client, id, 'still fast')).toBe('done');
  expect(queries).toHaveLength(queryCount);
  expect(native.setters).toEqual(['fastMode false', 'fastMode true']);
  expect(calls.at(-1)?.prompts).toEqual(['fast turn', 'standard turn', 'fast again', 'still fast']);
  expect(settingsAtPrompt).toEqual([[], ['fastMode false'], ['fastMode false', 'fastMode true'], ['fastMode false', 'fastMode true']]);
  expect((await client.call('threads.get', { threadId: id })).sessionId).toBe('native-speeds');
});

test('a new Claude session learns `boite ask` once, and the setting turns it off', async () => {
  harness.core.settings.set({ asyncQuestions: true, warmProcessMinutes: 5 });
  scripted(() => undefined, answerEach('sess-teach'));
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  expect(await runTurn(client, threadId, 'first')).toBe('done');
  expect(await runTurn(client, threadId, 'second')).toBe('done');
  expect(calls[0]!.prompts[0]).toContain('boite ask "<question>"');
  // The session has it already.
  expect(calls[0]!.prompts[1]).toBe('second');

  harness.core.settings.set({ asyncQuestions: false, warmProcessMinutes: 0 });
  const other = await client.call('threads.create', { projectId: harness.core.threads.require(threadId).projectId!, providerId: 'claude', accountId: harness.core.threads.require(threadId).accountId, title: 'untaught' });
  await client.call('threads.update', { threadId: other.id, title: 'untaught' });
  expect(await runTurn(client, other.id, 'third')).toBe('done');
  expect(calls.at(-1)!.prompts[0]).toBe('third');
});

test('with a brain, a new Claude session reads the Boite guide in its system prompt and learns `boite ask` from it alone', async () => {
  harness.core.settings.set({ asyncQuestions: true, warmProcessMinutes: 5 });
  const brain = join(harness.dataDir, 'brain');
  mkdirSync(brain);
  writeFileSync(join(brain, 'AGENTS.md'), 'Shared convention');
  await harness.core.brain.configure({ path: brain, enabled: true, boiteGuide: true });
  scripted(() => undefined, answerEach('sess-guide'));
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  expect(await runTurn(client, threadId, 'first')).toBe('done');
  expect(await runTurn(client, threadId, 'second')).toBe('done');
  const [first, second] = calls[0]!.prompts;
  const guide = appendedPrompt(calls[0]!.options);
  expect(guide).toContain('boite where');
  expect(guide.split('boite ask').length).toBe(2);
  // The messages carry the brain, and no second `boite ask` note.
  for (const prompt of [first, second]) {
    expect(prompt).toContain('Shared convention');
    expect(prompt).not.toContain('boite where');
    expect(prompt).not.toContain('boite ask');
  }
  harness.core.settings.set({ asyncQuestions: false });
  const other = await claudeThread(client);
  expect(await runTurn(client, other, 'third')).toBe('done');
  expect(appendedPrompt(calls.at(-1)!.options)).toContain('boite where');
  expect(appendedPrompt(calls.at(-1)!.options)).not.toContain('boite ask');
});

function appendedPrompt(options: Options): string {
  const prompt = options.systemPrompt;
  return typeof prompt === 'object' && prompt !== null && !Array.isArray(prompt) && 'append' in prompt ? prompt.append ?? '' : '';
}


test('Send now during cold Claude startup reaches its prompt stream before model output', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const ready = Promise.withResolvers<void>();
  scripted(fake => fake.emit(init('sess-startup')), undefined, ready.promise);
  try {
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
    await waitFor(() => harness.core.threads.runner.handles.has(threadId));
    await client.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, sendNow: true,
      value: { input: { text: '', attachments: [], paused: false, queued: [{ id: 'claude-startup-followup', text: 'Also check the bots', attachments: [] }] } } });
    await Bun.sleep(30);
    expect(calls).toHaveLength(0);
    ready.resolve();
    await waitFor(() => calls[0]?.prompts.length === 2);
    expect(calls[0]!.prompts[1]).toBe('Also check the bots');
    await waitFor(() => harness.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
    expect(harness.core.journal.listTurns(threadId)).toHaveLength(1);
    expect(harness.core.journal.getTurn(turn.id)?.status).toBe('running');
    expect(queries[0]!.interrupts).toBe(0);
    queries[0]!.emit(success('sess-startup'));
  } finally { ready.resolve(); }
});

test('user follow-ups enter the running Claude prompt stream without a second turn or interrupt', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(fake => fake.emit(init('sess-steer')));
  const turn = await client.call('turns.start', { threadId, prompt: 'Keep working' });
  await waitFor(() => calls[0]?.prompts.length === 1);
  const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=', name: 'sample.png' };
  expect(await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'Use this image', attachments: [image], clientRequestId: 'claude_steer_01' })).toEqual({ accepted: true });
  await waitFor(() => calls[0]?.prompts.length === 2);
  expect(JSON.parse(calls[0]!.prompts[1]!)).toEqual([
    { type: 'text', text: 'Use this image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } },
  ]);
  expect(queries[0]!.interrupts).toBe(0);
  expect(harness.core.journal.listTurns(threadId)).toHaveLength(1);
  const finished = client.next('turn.finished', record => record.id === turn.id);
  queries[0]!.emit(assistant('sess-steer', [{ type: 'text', text: 'Follow-up applied' }]));
  queries[0]!.emit(success('sess-steer'));
  expect((await finished).status).toBe('done');
});
