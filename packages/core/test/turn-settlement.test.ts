import { expect, spyOn, test } from 'bun:test';
import type { Message, MessagePart, Turn } from '@boite/contracts';
import { getDriver } from '../src/drivers/index.ts';
import { closeTools } from '../src/threads/turn-settlement.ts';
import { echoThread, holdAccountTurns, startTestCore, waitFor } from './harness.ts';

test('terminal persistence recovers twice without replaying the provider or publishing twice', async () => {
  const h = await startTestCore();
  const provider = spyOn(getDriver('echo'), 'startTurn');
  const putThread = h.core.journal.putThread.bind(h.core.journal);
  let failures = 0;
  let starts = 0;
  let finishes = 0;
  h.core.bus.onAny(name => {
    if (name === 'turn.started') starts++;
    if (name === 'turn.finished') finishes++;
  });
  h.core.journal.putThread = thread => {
    if (thread.status === 'idle' && h.core.journal.listTurns(thread.id).some(turn => turn.status === 'done') && failures < 2) {
      failures++;
      throw new Error('injected terminal write failure');
    }
    putThread(thread);
  };
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'settle once' });
    await waitFor(() => failures > 0);
    expect(h.core.scheduler.state().running.map(entry => entry.turnId)).toContain(turn.id);
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    expect(failures).toBe(2);
    expect(starts).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(finishes).toBe(1);
    expect(h.core.journal.getThread(threadId)?.status).toBe('idle');
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  } finally {
    h.core.journal.putThread = putThread;
    provider.mockRestore();
    await h.stop();
  }
});

test.each(['stopped', 'queued', 'running', 'newer-running'] as const)('settlement does not overwrite a turn replaced with %s during backoff', async replacementKind => {
  const status = replacementKind === 'newer-running' ? 'stopped' : replacementKind;
  const h = await startTestCore();
  const putTurn = h.core.journal.putTurn.bind(h.core.journal);
  let failed = false;
  let finishedEvents = 0;
  h.core.bus.onAny(name => { if (name === 'turn.finished') finishedEvents++; });
  h.core.journal.putTurn = turn => {
    if (turn.status === 'done' && !failed) { failed = true; throw new Error('terminal unavailable'); }
    putTurn(turn);
  };
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'replaced' });
    await waitFor(() => failed);
    h.core.threads.progress.report(threadId, turn.id, 'tool', 'Old execution tool');
    const replacement = { ...h.core.journal.getTurn(turn.id)!, status, startedAt: status === 'queued' ? null : status === 'running' ? Date.now() + 1 : turn.startedAt, finishedAt: status === 'running' || status === 'queued' ? null : 42 };
    putTurn(replacement);
    let newerId: string | null = null;
    if (replacementKind === 'newer-running') {
      newerId = `${turn.id}-newer`;
      putTurn({ ...replacement, id: newerId, status: 'running', startedAt: Date.now(), finishedAt: null, execution: { ...turn.execution!, sessionGeneration: 7 } });
      h.core.journal.putThread({ ...h.core.threads.require(threadId), sessionGeneration: 7, status: 'running' });
      h.core.threads.progress.begin(threadId, newerId);
      h.core.threads.progress.report(threadId, newerId, 'tool', 'New execution tool');
    }
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    expect(h.core.journal.getTurn(turn.id)).toEqual(replacement);
    expect(finishedEvents).toBe(0);
    expect(h.core.threads.get(threadId).progress).toEqual(newerId
      ? expect.objectContaining({ turnId: newerId, phase: 'tool', detail: 'New execution tool' })
      : null);
  } finally { h.core.journal.putTurn = putTurn; await h.stop(); }
});

test('settlement completes its turn while preserving a newer thread session and status', async () => {
  const h = await startTestCore();
  const putTurn = h.core.journal.putTurn.bind(h.core.journal);
  let failures = 0;
  h.core.journal.putTurn = turn => {
    if (turn.status === 'done' && failures < 2) { failures++; throw new Error('terminal unavailable'); }
    putTurn(turn);
  };
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'old session' });
    await waitFor(() => failures > 0);
    const newer = { ...h.core.journal.getThread(threadId)!, sessionGeneration: 7, sessionId: 'newer-session', status: 'waiting' as const };
    h.core.journal.putThread(newer);
    putTurn({ ...h.core.journal.getTurn(turn.id)!, id: `${turn.id}-newer`, startedAt: Date.now(), execution: { ...turn.execution!, sessionGeneration: 7, sessionId: 'newer-session' } });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    expect(h.core.journal.getThread(threadId)).toEqual(newer);
    expect(failures).toBe(2);
  } finally { h.core.journal.putTurn = putTurn; await h.stop(); }
});

test('shutdown cancels persistence backoff without replaying the turn', async () => {
  const h = await startTestCore();
  const putTurn = h.core.journal.putTurn.bind(h.core.journal);
  let failures = 0;
  let attemptsWhileStopping = 0;
  h.core.journal.putTurn = turn => {
    if (turn.status === 'done') {
      failures++;
      if (h.core.stopping) attemptsWhileStopping++;
      throw new Error('terminal unavailable');
    }
    putTurn(turn);
  };
  const record = spyOn(h.core.logs, 'record');
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('turns.start', { threadId, prompt: 'shutdown' });
    await waitFor(() => failures > 0);
    // No wall clock: a stalled Windows runner took 5.3 s to stop here while
    // the next three tests, which have no backoff, took 6.4, 6.1 and 2.8 s
    // against 0.4 s. A backoff that kept sleeping tries once more after the
    // core began stopping, and keeps the drain waiting to its deadline.
    await h.stop();
    expect(attemptsWhileStopping).toBe(0);
    const drained = record.mock.calls.find(([, , context]) => context?.event === 'scheduler.drain.finished');
    expect(drained?.[2]?.data).toEqual({ running: 1, left: 0 });
    expect(h.core.scheduler.state().running).toHaveLength(0);
  } finally { h.core.journal.putTurn = putTurn; record.mockRestore(); await h.stop(); }
});


test.each(['queued', 'held', 'running'] as const)('an accepted %s turn finishes idle without replacing the next account selection', async phase => {
  const h = await startTestCore();
  const provider = spyOn(getDriver('echo'), 'startTurn');
  let release = () => {};
  try {
    const client = await h.connect();
    const { threadId, accountId } = await echoThread(h, client);
    const nextAccount = await client.call('accounts.add', { providerId: 'echo', label: 'Next selection' });
    if (phase !== 'running') release = holdAccountTurns(h, accountId);
    const turn = await client.call('turns.start', { threadId, prompt: '[sleep:100] accepted selection' });
    if (phase === 'running') await waitFor(() => provider.mock.calls.length === 1);
    if (phase === 'held') h.core.threads.recoverStuckTurns();
    await client.call('threads.update', { threadId, accountId: nextAccount.id });
    const selected = h.core.journal.getThread(threadId)!;
    release();
    if (phase === 'held') {
      expect(h.core.journal.getTurn(turn.id)?.queueHold?.reason).toBe('core-restarted');
      expect(provider).toHaveBeenCalledTimes(0);
      await client.call('turns.recover', { threadId, turnId: turn.id, action: 'resume' });
    }
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0].thread.accountId).toBe(accountId);
    const finished = h.core.journal.getThread(threadId)!;
    expect(finished.status).toBe('idle');
    for (const key of ['providerId', 'accountId', 'model', 'effort', 'speed', 'sessionId', 'sessionGeneration', 'sessionResumeAt', 'selectionVersion', 'context', 'promptCache'] as const) {
      expect(finished[key]).toEqual(selected[key]);
    }
  } finally { release(); provider.mockRestore(); await h.stop(); }
});

test('progress reads no turn row per report, and any write that ends the turn drops a later report', async () => {
  const h = await startTestCore();
  try {
    const { threadId } = await echoThread(h, await h.connect());
    const queued: Turn = { id: 'trn_progress', threadId, status: 'queued', queuedAt: 1, startedAt: null, finishedAt: null, usage: null, error: null };
    h.core.journal.putTurn(queued);
    h.core.threads.progress.begin(threadId, queued.id);
    h.core.threads.progress.report(threadId, queued.id, 'tool', 'before it runs');
    expect(h.core.threads.progress.get(threadId)).toBeNull();
    h.core.journal.putTurn({ ...queued, status: 'running', startedAt: 2 });
    const reads = spyOn(h.core.journal, 'getTurn');
    for (let delta = 0; delta < 50; delta++) h.core.threads.progress.report(threadId, queued.id, 'working', null);
    h.core.threads.progress.contact(threadId, queued.id);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(h.core.threads.progress.get(threadId)).toMatchObject({ turnId: queued.id, phase: 'working' });
    // Recovery, a move or a stop writes the turn without the runner: the next callback is late.
    h.core.journal.putTurn({ ...queued, status: 'stopped', startedAt: 2, finishedAt: 3 });
    h.core.threads.progress.report(threadId, queued.id, 'tool', 'late callback');
    expect(h.core.threads.progress.get(threadId)).toBeNull();
  } finally { await h.stop(); }
});

test('closing a running tool on a turn that ended keeps its large values', async () => {
  const h = await startTestCore();
  try {
    const { threadId } = await echoThread(h, await h.connect());
    const tool = (toolId: string, status: 'running' | 'done'): MessagePart => ({ type: 'tool', toolId, name: 'Bash', input: { command: 'cat' }, inputText: `${toolId} input `.repeat(4000), output: `${toolId} output `.repeat(5000), status });
    const message: Message = { id: 'msg_tools', threadId, turnId: 'trn_tools', role: 'assistant', state: 'complete', createdAt: 1, parts: [tool('cut', 'running'), tool('kept', 'done')] };
    h.core.journal.putMessage(message);
    expect(closeTools(h.core, threadId, 'trn_tools')).toBe(1);
    expect(h.core.journal.getMessage('msg_tools')?.parts).toEqual([{ ...message.parts[0]!, status: 'error' } as MessagePart, message.parts[1]!]);
  } finally { await h.stop(); }
});
