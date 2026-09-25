/** The seeded state: two projects, four threads, one of each interesting state. */
import type { PermissionRequest, QuestionRequest } from '@boite/contracts';
import { seedAccounts } from './accounts-seed';
import { QUESTION_OPTIONS, QUESTION_TEXT } from './conversation';
import { T0 } from './shared';
import { longThread, seedThreads } from './threads-seed';
import { settlePermission, settleQuestion } from './requests';
import type { FakeContext } from './context';

export function seed(ctx: FakeContext): void {
  ctx.projects = [
    { id: 'p-boite', name: 'boite', path: 'C:\\src\\boite', createdAt: T0, repository: true },
    { id: 'p-notes', name: 'notes', path: 'C:\\src\\notes', createdAt: T0, repository: true }
  ];

  // What Claude Code left under its projects folder for boite: one session
  // to import, one that is already the trace thread.
  const transcripts = 'C:\\Users\\you\\.claude\\projects\\D--Dev-Collab-boite';
  ctx.importable = [
    {
      projectId: 'p-boite',
      providerId: 'claude',
      accountId: 'a-claude-main',
      sessionId: '4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      file: `${transcripts}\\4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f.jsonl`,
      title: 'Where the shell looks for a core',
      startedAt: T0 - 26 * 3_600_000,
      updatedAt: T0 - 25 * 3_600_000,
      bytes: 184_320,
      threadId: null
    },
    {
      projectId: 'p-boite',
      providerId: 'claude',
      accountId: 'a-claude-main',
      sessionId: '9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b',
      file: `${transcripts}\\9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b.jsonl`,
      title: 'Finish the trace tab',
      startedAt: T0 - 2 * 3_600_000,
      updatedAt: T0 - 3_600_000,
      bytes: 61_440,
      threadId: 't-trace'
    }
  ];

  const { providers, accounts } = seedAccounts();
  ctx.providers = providers;
  ctx.accounts = accounts;

  const { finished, running, waiting, unread } = seedThreads();

  for (const thread of [finished, running, waiting, unread]) ctx.threads.set(thread.id, thread);

  // The project's cards, the list the tasks surface shows under the agent's
  // own: one waiting on the user, one open, one already confirmed. The ids
  // carry a prefix so a card added later never lands on a seeded one.
  ctx.todos = [
    { id: 'seed-todo-1', projectId: 'p-boite', text: 'Ship the changes surface', status: 'claimed', threadId: finished.id, createdAt: T0 - 7_200_000, updatedAt: T0 - 600_000 },
    { id: 'seed-todo-2', projectId: 'p-boite', text: 'Give the file tree its rows', status: 'open', threadId: null, createdAt: T0 - 5_400_000, updatedAt: T0 - 5_400_000 },
    { id: 'seed-todo-3', projectId: 'p-boite', text: 'Move the trace behind the panel toggle', status: 'done', threadId: finished.id, createdAt: T0 - 86_400_000, updatedAt: T0 - 3_600_000 },
    { id: 'seed-todo-4', projectId: 'p-notes', text: 'Sort last week into the journal', status: 'open', threadId: null, createdAt: T0 - 86_400_000, updatedAt: T0 - 86_400_000 }
  ];

  if (ctx.long) {
    const long = longThread();
    ctx.threads.set(long.id, long);
  }

  const seededRequest: PermissionRequest = {
    id: 'req-seed-1',
    threadId: waiting.id,
    turnId: 'turn-seed-3',
    toolName: 'Write',
    input: { path: `${waiting.cwd}\\bench\\run.ts`, contents: 'fifty echo threads, one core' },
    description: 'Write the bench runner inside the project',
    createdAt: T0 + 201_500
  };
  const seededMessage = waiting.messages[1];
  ctx.pendingPermissions.set(seededRequest.id, {
    request: seededRequest,
    resolve: (decision) => {
      if (seededMessage) {
        settlePermission(ctx, waiting, seededMessage, 1, seededRequest, decision);
        seededMessage.state = 'complete';
        ctx.emitToThread(waiting.id, 'message.completed', {
          threadId: waiting.id,
          messageId: seededMessage.id,
          state: 'complete'
        });
      }
      const turn = waiting.turns[0];
      if (turn) {
        turn.status = 'done';
        turn.finishedAt = ctx.now();
        ctx.emit('turn.finished', structuredClone(turn));
      }
      waiting.status = 'idle';
      ctx.touch(waiting);
    }
  });

  const seededQuestion: QuestionRequest = {
    id: 'qst-seed-1',
    threadId: running.id,
    turnId: 'turn-seed-2',
    text: QUESTION_TEXT,
    options: QUESTION_OPTIONS,
    allowText: true,
    multiple: false,
    createdAt: T0 + 171_500
  };
  const questionMessage = running.messages[1];
  ctx.pendingQuestions.set(seededQuestion.id, {
    request: seededQuestion,
    resolve: (answer) => {
      if (questionMessage) {
        settleQuestion(ctx, running, questionMessage, 1, seededQuestion, answer);
        questionMessage.state = 'complete';
        ctx.emitToThread(running.id, 'message.completed', {
          threadId: running.id,
          messageId: questionMessage.id,
          state: 'complete'
        });
      }
      const turn = running.turns[0];
      if (turn) {
        turn.status = 'done';
        turn.finishedAt = ctx.now();
        ctx.emit('turn.finished', structuredClone(turn));
      }
      running.status = 'idle';
      ctx.touch(running);
    }
  });

  ctx.processes = [
    {
      pid: 21_140,
      parentPid: 4242,
      threadId: 't-trace',
      exe: 'C:\\tools\\claude\\claude.exe',
      commandLine: 'C:\\tools\\claude\\claude.exe --print --output-format stream-json',
      startedAt: T0 + 1000,
      exitedAt: T0 + 39_000,
      exitCode: 0,
      cpuMs: 4210,
      peakMemoryBytes: 210 * 1024 * 1024,
      ioBytes: 1_240_000
    },
    {
      pid: 21_402,
      parentPid: 21_140,
      threadId: 't-trace',
      exe: 'C:\\tools\\ripgrep\\rg.exe',
      commandLine: 'C:\\tools\\ripgrep\\rg.exe --json process.started packages/core/src',
      startedAt: T0 + 12_000,
      exitedAt: T0 + 12_400,
      exitCode: 0,
      cpuMs: 90,
      peakMemoryBytes: 18 * 1024 * 1024,
      ioBytes: 82_000
    },
    {
      // Gone before the job could read its counters: nothing measured.
      pid: 21_460,
      parentPid: 21_140,
      threadId: 't-trace',
      exe: 'C:\\Program Files\\Git\\cmd\\git.exe',
      commandLine: 'C:\\Program Files\\Git\\cmd\\git.exe status --porcelain',
      startedAt: T0 + 14_000,
      exitedAt: T0 + 14_120,
      exitCode: 0,
      cpuMs: null,
      peakMemoryBytes: null,
      ioBytes: null
    },
    {
      pid: 22_800,
      parentPid: 4242,
      threadId: 't-scheduler',
      exe: 'C:\\tools\\claude\\claude.exe',
      commandLine: 'C:\\tools\\claude\\claude.exe --print --output-format stream-json',
      startedAt: T0 + 170_500,
      exitedAt: null,
      exitCode: null,
      cpuMs: 2100,
      peakMemoryBytes: 380 * 1024 * 1024,
      ioBytes: 640_000
    },
    {
      pid: 22_912,
      parentPid: 22_800,
      threadId: 't-scheduler',
      exe: 'C:\\tools\\bun\\bun.exe',
      commandLine: 'C:\\tools\\bun\\bun.exe test packages/core/src/scheduler.test.ts',
      startedAt: T0 + 176_000,
      exitedAt: null,
      exitCode: null,
      cpuMs: 810,
      peakMemoryBytes: 96 * 1024 * 1024,
      ioBytes: 120_000
    }
  ];

  ctx.usage.set('t-trace', {
    inputTokens: 1840,
    outputTokens: 520,
    cacheReadTokens: 12_400,
    cacheWriteTokens: 900,
    costUsdEquivalent: 0.041
  });
  ctx.usage.set('t-descriptors', {
    inputTokens: 640,
    outputTokens: 210,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: 0.008
  });

  ctx.scheduler = {
    maxConcurrentTurns: ctx.settings.maxConcurrentTurns,
    perAccountConcurrency: ctx.settings.perAccountConcurrency,
    running: [{ turnId: 'turn-seed-2', threadId: 't-scheduler', startedAt: T0 + 170_500 }],
    queued: [
      { turnId: 'turn-seed-3', threadId: 't-bench', position: 1, queuedAt: T0 + 200_000 }
    ]
  };

  ctx.seq = 100;
}
