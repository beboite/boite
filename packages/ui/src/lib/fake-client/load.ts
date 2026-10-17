import { TOOL_OUTPUT_INLINE_CHARS, type Message, type MessagePart, type ProcessRecord, type Thread, type Turn } from '@boite/contracts';
import type { FakeContext } from './context';

/** What the fake keeps of a loaded thread, as the real core keeps the rest on disk. */
const KEPT_MESSAGES = 40;
const KEPT_TURNS = 20;
/** The answer each turn types, 16 characters a delta like the echo driver. */
const WORDS = 'The agent reads the file, runs the tests and writes what it found before the next step. ';
/** What a tool returns: a test run or a file read, as much as the core sends of a live output (`TOOL_OUTPUT_INLINE_CHARS`). */
const OUTPUT = Array.from({ length: 240 }, (_, line) => `src/lib/module-${line}.ts:${line + 1}  checked, nothing to report on this line`).join('\n').slice(0, TOOL_OUTPUT_INLINE_CHARS - 8);

/**
 * `?fake=1&load=<n>` seeds n threads that never stop working, the stream a
 * machine with many agents sends for hours. Every tick (`tickMs`, 100 by
 * default) each thread types two deltas and starts one short-lived process
 * while the previous one exits (16 threads make the ~180 process events a
 * second the core reports); every second its row and its load; every three
 * seconds a tool call whose output lands whole; every thirty a new turn.
 * Message and process events reach only the subscribed thread, as the core
 * scopes them. Each thread starts with the history the fake keeps of it.
 * `bench/ui-heap.ts` measures what the UI holds after hours of it.
 * Returns the way to stop it.
 */
export function startLoad(ctx: FakeContext, count: number, tickMs = 100): () => void {
  const now = Date.now();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `t-load-${index + 1}`;
    const thread: Thread = {
      id, projectId: index % 3 === 2 ? 'p-notes' : 'p-boite', title: `Busy agent ${index + 1}`,
      cwd: 'C:\\src\\boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null,
      permissionMode: 'default', archived: false, pinned: false, branch: null, titleSource: 'prompt',
      messagesBefore: null, commands: [], status: 'running', unread: false, sessionId: `sess-load-${index + 1}`,
      load: { processes: 2, cpuPercent: 3, memoryBytes: 300 * 1024 * 1024 }, context: null,
      createdAt: now, updatedAt: now, turns: [], messages: [],
    };
    ctx.threads.set(id, thread);
    ids.push(id);
  }
  if (ids.length === 0) return () => undefined;

  const turnOf = (thread: Thread) => thread.turns.at(-1)!;
  const answerOf = (thread: Thread) => thread.messages.at(-1)!;
  const trim = (thread: Thread) => {
    if (thread.messages.length > KEPT_MESSAGES) thread.messages.splice(0, thread.messages.length - KEPT_MESSAGES);
    if (thread.turns.length > KEPT_TURNS) thread.turns.splice(0, thread.turns.length - KEPT_TURNS);
  };
  const startTurn = (thread: Thread) => {
    const at = Date.now();
    const turn: Turn = { id: `turn-${++ctx.seq}`, threadId: thread.id, status: 'running', queuedAt: at, startedAt: at, finishedAt: null, usage: null, error: null };
    thread.turns.push(turn);
    thread.status = 'running';
    ctx.emit('turn.started', structuredClone(turn));
    const prompt: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: 'Keep going on the task.' }], state: 'complete', createdAt: at };
    const answer: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [{ type: 'text', text: '' }], state: 'streaming', createdAt: at };
    for (const message of [prompt, answer]) {
      thread.messages.push(message);
      ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
    }
    trim(thread);
  };
  const finishTurn = (thread: Thread) => {
    const turn = turnOf(thread);
    const answer = answerOf(thread);
    answer.state = 'complete';
    ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: answer.id, state: 'complete' });
    Object.assign(turn, { status: 'done', finishedAt: Date.now() });
    ctx.emit('turn.finished', structuredClone(turn));
  };
  for (const id of ids) startTurn(ctx.threads.get(id)!);

  let tick = 0;
  let pid = 50_000;
  const live = new Map<string, ProcessRecord>();
  const step = () => {
    tick += 1;
    for (const [index, id] of ids.entries()) {
      const thread = ctx.threads.get(id);
      if (!thread || thread.archived) continue;
      const answer = answerOf(thread);
      // Two deltas on the last text part, a new one after a tool.
      let partIndex = answer.parts.length - 1;
      if (answer.parts[partIndex]?.type !== 'text') {
        partIndex = answer.parts.push({ type: 'text', text: '' }) - 1;
        ctx.emitToThread(id, 'message.part', { threadId: id, messageId: answer.id, partIndex, part: { type: 'text', text: '' } });
      }
      for (let delta = 0; delta < 2; delta += 1) {
        const at = ((tick * 2 + delta) * 16) % WORDS.length;
        const text = (WORDS + WORDS).slice(at, at + 16);
        (answer.parts[partIndex] as Extract<MessagePart, { type: 'text' }>).text += text;
        ctx.emitToThread(id, 'message.delta', { threadId: id, messageId: answer.id, partIndex, text });
      }
      // One process out, the next one in: git, rg and the like, a few hundred milliseconds each.
      const exited = live.get(id);
      if (exited) ctx.emitToThread(id, 'process.exited', { ...exited, exitedAt: Date.now(), exitCode: 0, cpuMs: 40, peakMemoryBytes: 12_000_000, ioBytes: 80_000 });
      const started: ProcessRecord = { pid: ++pid, parentPid: 4000 + index, threadId: id, exe: 'C:\\Program Files\\Git\\cmd\\git.exe', commandLine: `git status --porcelain=v2 -z ${pid}`, startedAt: Date.now(), exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null };
      live.set(id, started);
      ctx.emitToThread(id, 'process.started', started);
      // Spread over the second so the rows do not all land on one tick.
      if ((tick + index) % 10 === 0) {
        thread.load = { processes: 2, cpuPercent: 3 + ((tick + index) % 5) * 2, memoryBytes: (300 + ((tick + index) % 7) * 4) * 1024 * 1024 };
        ctx.emit('thread.load', { threadId: id, load: structuredClone(thread.load) });
        ctx.touch(thread);
      }
      if ((tick + index) % 30 === 0) {
        const toolIndex = answer.parts.length;
        const running: MessagePart = { type: 'tool', toolId: `tool-${++ctx.seq}`, name: 'Bash', input: { command: `bun run test --filter case-${tick}` }, output: null, status: 'running', startedAt: Date.now() };
        answer.parts.push(running);
        ctx.emitToThread(id, 'message.part', { threadId: id, messageId: answer.id, partIndex: toolIndex, part: structuredClone(running) });
        const done: MessagePart = { ...running, output: `${OUTPUT}\n${tick}`, status: 'done', finishedAt: Date.now() };
        answer.parts[toolIndex] = done;
        ctx.emitToThread(id, 'message.part', { threadId: id, messageId: answer.id, partIndex: toolIndex, part: structuredClone(done) });
      }
      if ((tick + index * 7) % 300 === 0) {
        finishTurn(thread);
        startTurn(thread);
      }
    }
  };
  // The history a thread at work for a while has, before anyone connects: the
  // fake holds its whole bound from the start, so what grows later is the UI's.
  for (let warm = 0; warm < KEPT_MESSAGES / 2 * 300; warm += 1) step();
  const timer = setInterval(step, tickMs);
  return () => clearInterval(timer);
}
