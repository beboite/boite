/** The tool calls a fake turn makes when its prompt carries a marker. */
import type { Message, MessagePart, ProcessRecord, Thread, ToolDocument } from '@boite/contracts';
import { STREAMED_TOOL_INPUT } from './conversation';
import { chunkText } from './shared';
import type { FakeContext } from './context';

/**
 * A shell sent to the background, or a monitor left watching: the call
 * returns at once, the task stays listed.
 */
export async function backgroundShell(ctx: FakeContext, thread: Thread, message: Message, kind: 'shell' | 'monitor' = 'shell'): Promise<void> {
  const partIndex = message.parts.length;
  const toolId = `tool-${++ctx.seq}`;
  const input = kind === 'shell' ? { command: 'bun run dev:ui', run_in_background: true } : { command: 'gh run watch', description: 'Watch CI' };
  const startedAt = ctx.now();
  const running: MessagePart = { type: 'tool', toolId, name: kind === 'shell' ? 'Bash' : 'Monitor', input, output: null, status: 'running', startedAt };
  message.parts.push(running);
  ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(running) });
  await ctx.pause();
  const id = `${kind === 'shell' ? 'bash' : 'monitor'}-${ctx.seq}`;
  const done: MessagePart = { ...running, output: `Command running in background with ID: ${id}`, status: 'done', finishedAt: ctx.now() };
  message.parts[partIndex] = done;
  ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(done) });
  ctx.setBackground(thread, [...(thread.background ?? []), { id, kind, description: input.command, toolId, startedAt }]);
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

/** The pwsh an agent on Windows wraps its commands in, as Claude sends it. */
const PWSH = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command';

/**
 * A burst of calls with nothing between them, the way an agent explores a
 * repository: wrapped commands, a read, a search and one command that fails.
 * The timeline folds it under one sentence.
 */
export async function toolBurst(ctx: FakeContext, thread: Thread, message: Message, record: { cancelled: boolean }): Promise<void> {
  const calls: { name: string; input: unknown; output: string; status: 'done' | 'error'; exitCode?: number }[] = [
    { name: 'Bash', input: { command: `${PWSH} 'git status --short'`, description: 'Show the working tree' }, output: ' M packages/ui/src/app.css', status: 'done' },
    { name: 'Bash', input: { command: `${PWSH} 'Get-ChildItem packages/ui/src/components | Select-Object -First 5'` }, output: 'AppearancePage.svelte\nAssistantMessage.svelte', status: 'done' },
    { name: 'Read', input: { file_path: 'packages/ui/src/app.css' }, output: ':root { }', status: 'done' },
    { name: 'Grep', input: { pattern: 'font-family', path: 'packages/ui/src' }, output: 'packages/ui/src/app.css:8', status: 'done' },
    { name: 'Bash', input: { command: `${PWSH} 'cd packages/ui; bun run check'` }, output: 'error TS2304: Cannot find name', status: 'error', exitCode: 1 },
    { name: 'Bash', input: { command: `${PWSH} 'cd packages/ui; bun run check'` }, output: '0 errors', status: 'done' }
  ];
  for (const call of calls) {
    // Stopped mid-run: the call on its way finishes, no other starts.
    if (record.cancelled) break;
    const partIndex = message.parts.length;
    const toolId = `tool-${++ctx.seq}`;
    const startedAt = ctx.now();
    const running: MessagePart = { type: 'tool', toolId, name: call.name, input: call.input, output: null, status: 'running', startedAt };
    message.parts.push(running);
    ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(running) });
    await ctx.pause();
    const done: MessagePart = { ...running, output: call.output, status: call.status, finishedAt: ctx.now(),
      ...(call.exitCode !== undefined ? { exitCode: call.exitCode } : {}) };
    message.parts[partIndex] = done;
    ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(done) });
  }
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
