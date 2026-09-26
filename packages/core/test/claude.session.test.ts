import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
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
    // the third has lost it and counts from zero.
    const held = (tokens: number) => ({ 'claude-test': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 } });
    const results = [{ total_cost_usd: 0.25, modelUsage: held(26) }, { total_cost_usd: 0.3, modelUsage: held(52) }, { total_cost_usd: 0.07, modelUsage: held(26) }];
    let turn = 0;
    scripted(() => undefined, (fake) => {
      fake.emit(init('sess-resumed'));
      fake.emit(sdk({ ...(success('sess-resumed') as object), ...results[turn++] }));
    });

    const costs: (number | null)[] = [];
    for (const prompt of ['first', 'second', 'third']) {
      const finished = client.next('turn.finished', (finishedTurn) => finishedTurn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt });
      costs.push((await finished).usage?.costUsdEquivalent ?? null);
    }

    expect(queries).toHaveLength(3);
    expect(costs[0]).toBeCloseTo(0.25, 10);
    expect(costs[1]).toBeCloseTo(0.05, 10);
    expect(costs[2]).toBeCloseTo(0.07, 10);
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

    // `plan` and not `bypassPermissions`: that one is in the session key, and
    // the test under this one is what covers it.
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

  test('a switch into bypassPermissions opens a second query, and back out a third', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-bypass'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');

    // `allowDangerouslySkipPermissions` is a query-start option with no setter
    // beside it, so the warm query cannot be talked into the skip: it closes and
    // the turn lands on a query opened with the flag.
    await client.call('threads.update', { threadId, permissionMode: 'bypassPermissions' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(queries[0]?.setters).toEqual([]);
    expect(calls[0]?.options.allowDangerouslySkipPermissions).toBe(false);
    expect(calls[1]?.options.allowDangerouslySkipPermissions).toBe(true);
    expect(calls[1]?.options.permissionMode).toBe('bypassPermissions');
    expect(calls[1]?.prompts).toEqual(['second']);

    // And the way back is the same: a query opened with the skip keeps it.
    await client.call('threads.update', { threadId, permissionMode: 'default' });
    expect(await runTurn(client, threadId, 'third')).toBe('done');

    expect(queries).toHaveLength(3);
    expect(calls[2]?.options.allowDangerouslySkipPermissions).toBe(false);
    expect(calls[2]?.prompts).toEqual(['third']);
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

  test('a setter the CLI refuses starts a fresh query on the new setup, and the turn still runs', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    const logs: string[] = [];
    client.on('core.log', (entry) => {
      logs.push(`${entry.level} ${entry.message}`);
    });

    scripted((fake) => {
      // Only the first query refuses; the second opens on the new model.
      if (queries.length === 1) fake.refuse = 'setModel';
    }, answerEach('sess-refused'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    await client.call('threads.update', { threadId, model: 'claude-opus-5' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(calls[0]?.options.model).toBe('claude-sonnet-5');
    expect(calls[1]?.options.model).toBe('claude-opus-5');
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
    expect(calls[1]?.prompts).toEqual(['again']);
  });

});

test('Claude discovery reports only its model capabilities, caches and refreshes without a prompt', async () => {
  scripted(fake => { fake.modelsAnswer = [
    { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)', description: '', supportsFastMode: true },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: 'Opus 5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true, supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false, supportsFastMode: false },
  ]; }, answerEach('native-speeds'));
  const client = await harness.connect();
  const id = await claudeThread(client);
  const accountId = (await client.call('threads.get', { threadId: id })).accountId;
  const result = await client.call('providers.probe', { providerId: 'claude', accountId });
  expect(result.models[0]?.name).toBe('Claude Opus 5');
  expect(result.models.some(model => /default/i.test(model.name))).toBe(false);
  expect(result.models.find(model => model.id === 'claude-opus-4-8')).toMatchObject({ legacy: true, name: 'Claude Opus 4.8' });
  expect(result.models.find(model => model.id === 'claude-opus-4-8')?.speeds).toBeUndefined();
  expect(result.models[0]?.effort?.levels.map(level => level.id)).toEqual(['low', 'high', 'ultrathink']);
  expect(result.models[0]?.speeds).toEqual([{ id: 'fast', label: 'Fast' }]);
  expect(result.models[1]?.effort).toBeUndefined(); expect(result.models[1]?.speeds).toBeUndefined();
  await client.call('providers.probe', { providerId: 'claude', accountId });
  expect(calls).toHaveLength(1); expect(calls[0]?.prompts).toEqual([]); expect(queries[0]?.closes).toBe(1);
  await client.call('providers.probe', { providerId: 'claude', accountId, refresh: true });
  expect(calls).toHaveLength(2);
  await client.call('threads.update', { threadId: id, model: 'claude-opus-5', speed: 'fast' });
  expect(await runTurn(client, id, 'fast turn')).toBe('done');
  expect(calls.at(-1)?.options.settings).toEqual({ fastMode: true });
  await client.call('threads.update', { threadId: id, speed: null });
  expect(await runTurn(client, id, 'standard turn')).toBe('done');
  expect(calls.at(-1)?.options.settings).toEqual({ fastMode: false });
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
