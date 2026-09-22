import {
  type Message,
  type Thread
} from '@boite/contracts';
import {
  LONG_ANSWERS,
  LONG_ASKS,
  QUESTION_OPTIONS,
  QUESTION_TEXT
} from './conversation.ts';
import {
  ECHO_COMMANDS,
  T0
} from './shared.ts';

/** Fresh thread objects for each demo client. */
export function seedThreads() {
  const base = {
    providerId: 'echo',
    accountId: 'a-echo',
    model: 'echo-1',
    effort: null,
    permissionMode: 'default' as const,
    archived: false,
    pinned: false,
    branch: null,
    titleSource: 'prompt' as const,
    // A stored thread is the whole record; `threads.get` is what pages it.
    messagesBefore: null,
    commands: []
  };

  const finished: Thread = {
    ...base,
    id: 't-trace',
    projectId: 'p-boite',
    title: 'Finish the trace tab',
    cwd: 'C:\\src\\boite',
    status: 'idle',
    unread: false,
    sessionId: 'sess-trace',
    load: null,
    context: null,
    // Measured from the page's own clock, so the timer behind the
    // `prompt-cache` experiment reads warm with about half an hour left.
    promptCache: { at: Date.now() - 29 * 60_000, ttlSeconds: 3600, source: 'reported', readTokens: 12_400, model: 'echo-1', accountId: 'a-echo' },
    createdAt: T0,
    updatedAt: T0 + 60_000,
    turns: [
      {
        id: 'turn-seed-1',
        threadId: 't-trace',
        status: 'done',
        queuedAt: T0,
        startedAt: T0,
        finishedAt: T0 + 41_000,
        usage: {
          inputTokens: 1840,
          outputTokens: 520,
          cacheReadTokens: 12_400,
          cacheWriteTokens: 900,
          costUsdEquivalent: 0.041
        },
        error: null
      }
    ],
    messages: [
      {
        id: 'm-1',
        threadId: 't-trace',
        turnId: 'turn-seed-1',
        role: 'user',
        parts: [{ type: 'text', text: 'What does the trace tab need from the core?' }],
        state: 'complete',
        createdAt: T0
      },
      {
        id: 'm-2',
        threadId: 't-trace',
        turnId: 'turn-seed-1',
        role: 'assistant',
        parts: [
          {
            type: 'thinking',
            text: 'The table wants a row per process, so the question is what procs already reports and what the panel would have to ask for on top. Start with trace.get.'
          },
          {
            type: 'text',
            text: 'It needs trace.get for the table and the TraceCapability note above it. Let me look at what procs already reports.'
          },
          {
            type: 'tool',
            toolId: 'tool-seed-1',
            name: 'Grep',
            input: { pattern: 'process.started', path: 'packages/core/src' },
            output: 'packages/core/src/procs.ts:88\npackages/core/src/trace.ts:20',
            status: 'done'
          },
          {
            type: 'text',
            text: 'Both events carry the pid, the exe, the CPU time and the peak memory, so the table can be filled without a second call.'
          }
        ],
        state: 'complete',
        createdAt: T0 + 20_000
      }
    ]
  };

  const running: Thread = {
    ...base,
    id: 't-scheduler',
    projectId: 'p-boite',
    title: 'Port the scheduler',
    // The one seeded thread in its own worktree: what the header badge is looked at on.
    cwd: 'C:\\src\\.boite-worktrees\\boite\\port-the-scheduler',
    branch: 'boite/port-the-scheduler',
    // Waiting on a question nobody has answered, the same reason as `t-bench`
    // and its permission: a page that loads now draws the card from the list.
    status: 'waiting',
    unread: false,
    sessionId: 'sess-scheduler',
    load: { processes: 2, cpuPercent: 34, memoryBytes: 412 * 1024 * 1024 },
    // Running at a high share: the meter turns full past nine tenths.
    context: { tokens: 183_000, window: 200_000, at: T0 + 100_000 },
    createdAt: T0 + 100_000,
    updatedAt: T0 + 180_000,
    turns: [
      {
        id: 'turn-seed-2',
        threadId: 't-scheduler',
        status: 'running',
        queuedAt: T0 + 170_000,
        startedAt: T0 + 170_500,
        finishedAt: null,
        usage: null,
        error: null
      }
    ],
    messages: [
      {
        id: 'm-3',
        threadId: 't-scheduler',
        turnId: 'turn-seed-2',
        role: 'user',
        parts: [{ type: 'text', text: 'Count turns, never threads. Start with the caps.' }],
        state: 'complete',
        createdAt: T0 + 170_000
      },
      {
        id: 'm-4',
        threadId: 't-scheduler',
        turnId: 'turn-seed-2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Reading the current caps and the queue order' },
          {
            type: 'question',
            questionId: 'qst-seed-1',
            text: QUESTION_TEXT,
            options: QUESTION_OPTIONS,
            allowText: true,
            multiple: false,
            answer: null
          }
        ],
        state: 'streaming',
        createdAt: T0 + 171_000
      }
    ]
  };

  // Its turn is stopped on a permission nobody has answered, which is what a
  // page that loads now shows without ever having seen `permission.requested`.
  const waiting: Thread = {
    ...base,
    id: 't-bench',
    projectId: 'p-boite',
    title: 'Bench against legacy',
    cwd: 'C:\\src\\boite',
    status: 'waiting',
    unread: false,
    sessionId: 'sess-bench',
    load: null,
    context: null,
    createdAt: T0 + 200_000,
    updatedAt: T0 + 200_000,
    turns: [
      {
        id: 'turn-seed-3',
        threadId: 't-bench',
        status: 'running',
        queuedAt: T0 + 200_000,
        startedAt: T0 + 200_500,
        finishedAt: null,
        usage: null,
        error: null
      }
    ],
    messages: [
      {
        id: 'm-5',
        threadId: 't-bench',
        turnId: 'turn-seed-3',
        role: 'user',
        parts: [{ type: 'text', text: 'Fifty echo threads, RSS and throughput.' }],
        state: 'complete',
        createdAt: T0 + 200_000
      },
      {
        id: 'm-8',
        threadId: 't-bench',
        turnId: 'turn-seed-3',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Writing the run script before the fifty threads go out.' },
          { type: 'permission', requestId: 'req-seed-1', toolName: 'Write', decision: null }
        ],
        state: 'streaming',
        createdAt: T0 + 201_000
      }
    ]
  };

  const unread: Thread = {
    ...base,
    id: 't-descriptors',
    projectId: 'p-notes',
    title: 'Review the descriptor loader',
    cwd: 'C:\\src\\notes',
    // The most recent thread, so this is the one a boot opens: it has already
    // run a turn, so the echo agent has already named what it takes.
    commands: structuredClone(ECHO_COMMANDS),
    status: 'idle',
    unread: true,
    sessionId: 'sess-descriptors',
    load: null,
    context: null,
    createdAt: T0 + 300_000,
    updatedAt: T0 + 340_000,
    turns: [
      {
        id: 'turn-seed-4',
        threadId: 't-descriptors',
        status: 'done',
        queuedAt: T0 + 300_000,
        startedAt: T0 + 300_000,
        finishedAt: T0 + 340_000,
        usage: {
          inputTokens: 640,
          outputTokens: 210,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdEquivalent: 0.008
        },
        error: null
      }
    ],
    messages: [
      {
        id: 'm-6',
        threadId: 't-descriptors',
        turnId: 'turn-seed-4',
        role: 'user',
        parts: [{ type: 'text', text: 'Does an unknown field refuse the file?' }],
        state: 'complete',
        createdAt: T0 + 300_000
      },
      {
        id: 'm-7',
        threadId: 't-descriptors',
        turnId: 'turn-seed-4',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: 'It does, with the file, the field and what was expected. One case is still silent: a roots entry that resolves outside the descriptor directory.'
          },
          // The agent compacted on its way out: the divider under the answer.
          { type: 'compaction', trigger: 'auto', preTokens: 184_000, postTokens: 31_000 },
          { type: 'text', text: 'The loader test now names that case too.' }
        ],
        state: 'complete',
        createdAt: T0 + 320_000
      }
    ]
  };
  // The meters: the trace thread at a comfortable share, the descriptor one just compacted.
  finished.context = { tokens: 84_000, window: 200_000, at: T0 + 60_000 };
  finished.branch = 'boite/trace';
  finished.pullRequest = { number: 84, url: 'https://github.com/example/project/pull/84', state: 'OPEN' };
  unread.context = { tokens: 31_000, breakdown: { input: 18000, cache: 10000, output: 3000 }, window: 200_000, at: T0 + 340_000 };
  return { finished, running, waiting, unread };
}

export function longThread(): Thread {
  const messages: Message[] = [];
  for (let index = 0; index < 400; index += 1) {
    const at = T0 + 400_000 + index * 1000;
    messages.push(
      index % 2 === 0
        ? {
          id: `m-long-${index}`,
          threadId: 't-long',
          turnId: 'turn-long',
          role: 'user',
          parts: [
            {
              type: 'text',
              text: `${LONG_ASKS[(index / 2) % LONG_ASKS.length] ?? ''} (${index})`
            }
          ],
          state: 'complete',
          createdAt: at
        }
        : {
          id: `m-long-${index}`,
          threadId: 't-long',
          turnId: 'turn-long',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: LONG_ANSWERS[((index - 1) / 2) % LONG_ANSWERS.length] ?? ''
            }
          ],
          state: 'complete',
          createdAt: at
        }
    );
  }
  return {
    id: 't-long',
    projectId: 'p-boite',
    providerId: 'echo',
    accountId: 'a-echo',
    model: 'echo-1',
    effort: null,
    permissionMode: 'default',
    archived: false,
    pinned: false,
    title: 'Four hundred messages',
    titleSource: 'prompt',
    cwd: 'C:\\src\\boite',
    branch: null,
    status: 'idle',
    unread: false,
    sessionId: 'sess-long',
    load: null,
    context: null,
    createdAt: T0 + 400_000,
    updatedAt: T0 + 800_000,
    messagesBefore: null,
    commands: [],
    turns: [
      {
        id: 'turn-long',
        threadId: 't-long',
        status: 'done',
        queuedAt: T0 + 400_000,
        startedAt: T0 + 400_000,
        finishedAt: T0 + 800_000,
        usage: {
          inputTokens: 41_200,
          outputTokens: 18_400,
          cacheReadTokens: 210_000,
          cacheWriteTokens: 12_000,
          costUsdEquivalent: 1.24
        },
        error: null
      }
    ],
    messages
  };
}
