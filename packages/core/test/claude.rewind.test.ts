import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CoreClient } from '../src/client.ts';
import {
  calls,
  claudeThread,
  failure,
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

/** An assistant entry with the transcript uuid the CLI gives every chained message. */
function entry(sessionId: string, uuid: string, text: string) {
  return sdk({
    type: 'assistant',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  });
}

/**
 * Every query answers once: a fork (`forkSession`) gets a session of its own,
 * any other resume keeps the one it resumed, and a cold start is `sess-1`.
 */
function transcript(refuseCut = false): void {
  let n = 0;
  const opened = new Map<unknown, { options: Options; session: string | null }>();
  scripted(
    (fake, options: Options) => { opened.set(fake, { options, session: null }); },
    (fake, _prompt, index) => {
      n += 1;
      const query = opened.get(fake);
      if (!query) throw new Error('a prompt reached a query that never opened');
      const { options } = query;
      if (refuseCut && options.resumeSessionAt && index === 0) {
        fake.emit(sdk({ ...(failure('') as object), session_id: undefined, errors: ['No message found with message.uuid'] }));
        fake.end();
        return;
      }
      // A warm process keeps the session its first prompt settled on.
      query.session ??= options.forkSession ? `sess-fork-${n}` : options.resume ?? 'sess-1';
      fake.emit(init(query.session));
      fake.emit(entry(query.session, `entry-${n}`, `answer ${n}`));
      fake.emit(success(query.session));
    },
  );
}

async function userMessage(client: CoreClient, threadId: string, index: number): Promise<string> {
  const thread = await client.call('threads.get', { threadId });
  const found = thread.messages.filter((message) => message.role === 'user')[index];
  if (!found) throw new Error(`no user message ${index}`);
  return found.id;
}

describe('claude rewind and fork', () => {
  test('the turn after a rewind resumes the transcript at the kept turn, forked', async () => {
    transcript();
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(calls[1]?.options.resume).toBe('sess-1');

    const rewound = await client.call('threads.rewind', { threadId, messageId: await userMessage(client, threadId, 1) });
    expect(rewound.session).toBe('native');
    expect(rewound.prompt).toBe('second');
    expect(rewound.thread.sessionId).toBe('sess-1');
    expect(rewound.thread.sessionResumeAt).toBe('entry-1');

    expect(await runTurn(client, threadId, 'second, edited')).toBe('done');
    const cut = calls[2]?.options;
    expect(cut?.resume).toBe('sess-1');
    expect(cut?.resumeSessionAt).toBe('entry-1');
    expect(cut?.forkSession).toBe(true);
    // The prompt is the edited one alone: the transcript already holds the rest.
    expect(calls[2]?.prompts[0]).not.toContain('first');
    expect(calls[2]?.prompts[0]).toContain('second, edited');

    // The fork is the thread's session now, resumed whole from here on.
    const after = harness.core.threads.require(threadId);
    expect(after.sessionId).toBe('sess-fork-3');
    expect(after.sessionResumeAt ?? null).toBeNull();
    expect(await runTurn(client, threadId, 'third')).toBe('done');
    expect(calls[3]?.options.resume).toBe('sess-fork-3');
    expect(calls[3]?.options.resumeSessionAt).toBeUndefined();
    expect(calls[3]?.options.forkSession).toBeUndefined();
  });

  test('a rewind closes the warm process, so the cut is not answered from its memory', async () => {
    transcript();
    const client = await harness.connect();
    await client.call('settings.set', { warmProcessMinutes: 5 });
    const threadId = await claudeThread(client);
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    const warm = queries.length;
    await client.call('threads.rewind', { threadId, messageId: await userMessage(client, threadId, 1) });
    expect(queries[warm - 1]?.closes).toBeGreaterThan(0);
    expect(await runTurn(client, threadId, 'again')).toBe('done');
    expect(queries.length).toBe(warm + 1);
    expect(calls.at(-1)?.options.resumeSessionAt).toBe('entry-1');
    expect(calls.at(-1)?.options.forkSession).toBe(true);
  });

  test('a CLI that refuses the cut starts a fresh session with the kept history instead', async () => {
    transcript(true);
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    expect(await runTurn(client, threadId, 'the widgets are blue')).toBe('done');
    expect(await runTurn(client, threadId, 'the gadgets are red')).toBe('done');
    await client.call('threads.rewind', { threadId, messageId: await userMessage(client, threadId, 1) });
    expect(await runTurn(client, threadId, 'what colour')).toBe('done');
    const retry = calls.at(-1);
    expect(calls.at(-2)?.options.resumeSessionAt).toBe('entry-1');
    expect(retry?.options.resume).toBeUndefined();
    expect(retry?.options.resumeSessionAt).toBeUndefined();
    expect(retry?.prompts[0]).toContain('the widgets are blue');
    expect(retry?.prompts[0]).not.toContain('gadgets');
  });

  test('a fork in the same folder resumes the source transcript forked, and leaves the source whole', async () => {
    transcript();
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const firstReply = thread.messages.find((message) => message.role === 'assistant');
    if (!firstReply) throw new Error('no reply');

    const fork = await client.call('threads.fork', { threadId, messageId: firstReply.id });
    expect(fork.sessionId).toBe('sess-1');
    expect(fork.sessionResumeAt).toBe('entry-1');
    await client.call('threads.subscribe', { threadId: fork.id });
    expect(await runTurn(client, fork.id, 'branch')).toBe('done');
    expect(calls.at(-1)?.options.resume).toBe('sess-1');
    expect(calls.at(-1)?.options.resumeSessionAt).toBe('entry-1');
    expect(calls.at(-1)?.options.forkSession).toBe(true);

    expect(harness.core.threads.require(threadId).sessionId).toBe('sess-1');
    expect(await runTurn(client, threadId, 'source goes on')).toBe('done');
    expect(calls.at(-1)?.options.resume).toBe('sess-1');
    expect(calls.at(-1)?.options.resumeSessionAt).toBeUndefined();
  });
});
