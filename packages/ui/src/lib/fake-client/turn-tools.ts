/** The tool calls a fake turn makes when its prompt carries a marker. */
import type { Message, MessagePart, ProcessRecord, Thread, ToolDocument } from '@boite/contracts';
import { STREAMED_TOOL_INPUT } from './conversation';
import { chunkText } from './shared';
import type { FakeContext } from './context';

/** A shell sent to the background: the call returns at once, the task stays listed. */
export async function backgroundShell(ctx: FakeContext, thread: Thread, message: Message): Promise<void> {
  const partIndex = message.parts.length;
  const toolId = `tool-${++ctx.seq}`;
  const input = { command: 'bun run dev:ui', run_in_background: true };
  const startedAt = ctx.now();
  const running: MessagePart = { type: 'tool', toolId, name: 'Bash', input, output: null, status: 'running', startedAt };
  message.parts.push(running);
  ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(running) });
  await ctx.pause();
  const id = `bash-${ctx.seq}`;
  const done: MessagePart = { ...running, output: `Command running in background with ID: ${id}`, status: 'done', finishedAt: ctx.now() };
  message.parts[partIndex] = done;
  ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(done) });
  ctx.setBackground(thread, [...(thread.background ?? []), { id, kind: 'shell', description: input.command, toolId, startedAt }]);
}

/**
 * A tool whose input the model is still typing: the part opens with no input
 * and an empty `inputText`, the JSON arrives as deltas, then the parsed input
 * replaces it. The same shape the Claude driver's `input_json_delta` produces.
 */
export async function streamToolInput(ctx: FakeContext, thread: Thread, message: Message): Promise<void> {
  const partIndex = message.parts.length;
  const toolId = `tool-${++ctx.seq}`;
  const opening: MessagePart = {
    type: 'tool',
    toolId,
    name: 'Bash',
    input: {},
    inputText: '',
    output: null,
    status: 'running'
  };
  message.parts.push(opening);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(opening)
  });

  for (const piece of chunkText(STREAMED_TOOL_INPUT, 4)) {
    await ctx.pause();
    const part = message.parts[partIndex];
    if (part && part.type === 'tool') part.inputText = (part.inputText ?? '') + piece;
    ctx.emitToThread(thread.id, 'message.delta', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      text: piece
    });
  }

  await ctx.pause();
  const done: MessagePart = {
    type: 'tool',
    toolId,
    name: 'Bash',
    input: JSON.parse(STREAMED_TOOL_INPUT) as unknown,
    inputText: null,
    output: 'streamed',
    status: 'done'
  };
  message.parts[partIndex] = done;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(done)
  });
}

/** One tool that lands whole, carrying the documents it produced. */
export async function documentTool(
  ctx: FakeContext,
  thread: Thread,
  message: Message,
  name: string,
  input: unknown,
  output: string,
  documents: ToolDocument[]
): Promise<void> {
  const partIndex = message.parts.length;
  const toolId = `tool-${++ctx.seq}`;
  const running: MessagePart = {
    type: 'tool',
    toolId,
    name,
    input,
    output: null,
    status: 'running',
    documents
  };
  message.parts.push(running);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(running)
  });

  await ctx.pause();

  const done: MessagePart = { ...running, output, status: 'done' };
  message.parts[partIndex] = done;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(done)
  });
}

export async function runTool(ctx: FakeContext, thread: Thread, message: Message): Promise<void> {
  const partIndex = message.parts.length;
  const toolId = `tool-${++ctx.seq}`;
  const input = { pattern: 'registerMethods', path: thread.cwd };
  const running: MessagePart = {
    type: 'tool',
    toolId,
    name: 'Grep',
    input,
    output: null,
    status: 'running'
  };
  message.parts.push(running);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(running)
  });

  await ctx.pause();

  const done: MessagePart = {
    type: 'tool',
    toolId,
    name: 'Grep',
    input,
    output: 'packages/core/src/modules.ts:12\npackages/core/src/server.ts:44',
    status: 'done'
  };
  message.parts[partIndex] = done;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(done)
  });
}

export async function spawnProcess(ctx: FakeContext, thread: Thread, exe: string): Promise<void> {
  const pid = 10_000 + ++ctx.seq;
  const record: ProcessRecord = {
    pid,
    parentPid: ctx.core.pid,
    threadId: thread.id,
    exe,
    commandLine: `${exe} --from boite`,
    startedAt: ctx.now(),
    exitedAt: null,
    exitCode: null,
    cpuMs: null,
    peakMemoryBytes: null,
    ioBytes: null
  };
  ctx.processes.push(record);
  thread.load = { processes: 1, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
  ctx.touch(thread);
  ctx.emitToThread(record.threadId, 'process.started', structuredClone(record));

  await ctx.pause();

  record.exitedAt = ctx.now();
  record.exitCode = 0;
  record.cpuMs = 120;
  record.peakMemoryBytes = 48 * 1024 * 1024;
  record.ioBytes = 32 * 1024;
  thread.load = null;
  ctx.touch(thread);
  ctx.emitToThread(record.threadId, 'process.exited', structuredClone(record));
}
