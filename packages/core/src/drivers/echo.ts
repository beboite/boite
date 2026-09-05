import type { MessageId, Usage } from '@boite/contracts';
import { newId } from '../ids.ts';
import type { Driver, TurnContext, TurnHandle, TurnResult } from './types.ts';

const CHUNK_SIZE = 16;
const CHUNK_DELAY_MS = 5;
const TOOL_DELAY_MS = 5;
const ERROR_MESSAGE = 'echo error requested';

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'sleep'; ms: number }
  | { kind: 'tool' }
  | { kind: 'permission' }
  | { kind: 'spawn'; command: string }
  | { kind: 'error' };

const DIRECTIVE = /\[(?:sleep:\d+|tool|permission|spawn:[^\]]*|error)\]/g;

export function parsePrompt(prompt: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  DIRECTIVE.lastIndex = 0;
  for (let match = DIRECTIVE.exec(prompt); match !== null; match = DIRECTIVE.exec(prompt)) {
    if (match.index > last) segments.push({ kind: 'text', text: prompt.slice(last, match.index) });
    const body = match[0].slice(1, -1);
    if (body.startsWith('sleep:')) segments.push({ kind: 'sleep', ms: Number(body.slice('sleep:'.length)) });
    else if (body.startsWith('spawn:')) segments.push({ kind: 'spawn', command: body.slice('spawn:'.length) });
    else if (body === 'tool') segments.push({ kind: 'tool' });
    else if (body === 'permission') segments.push({ kind: 'permission' });
    else segments.push({ kind: 'error' });
    last = match.index + match[0].length;
  }
  if (last < prompt.length) segments.push({ kind: 'text', text: prompt.slice(last) });
  return segments;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

interface RunState {
  stopped: boolean;
  waiters: Set<() => void>;
}

function sleep(ms: number, state: RunState): Promise<void> {
  if (state.stopped || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      state.waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    state.waiters.add(wake);
  });
}

function shellFor(command: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', command] };
  return { cmd: 'sh', args: ['-c', command] };
}

/** Deterministic driver for tests and benches. It never reaches the network. */
export const echoDriver: Driver = {
  protocol: 'echo',
  startTurn(ctx: TurnContext): TurnHandle {
    const state: RunState = { stopped: false, waiters: new Set() };
    const done = run(ctx, state);
    return {
      done,
      stop(): void {
        state.stopped = true;
        for (const wake of [...state.waiters]) wake();
      },
    };
  },
};

async function run(ctx: TurnContext, state: RunState): Promise<TurnResult> {
  const sessionId = ctx.sessionId ?? `echo-${ctx.thread.id}`;
  const messageId: MessageId = ctx.emit.startMessage('assistant');
  let nextIndex = 0;
  let textIndex: number | null = null;
  let streamed = '';

  const usage = (): Usage => ({
    inputTokens: countWords(ctx.prompt),
    outputTokens: countWords(streamed),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: null,
  });

  const writeText = async (text: string): Promise<void> => {
    if (text.length === 0) return;
    if (textIndex === null) {
      textIndex = nextIndex;
      nextIndex += 1;
      ctx.emit.part(messageId, textIndex, { type: 'text', text: '' });
    }
    for (let at = 0; at < text.length; at += CHUNK_SIZE) {
      if (state.stopped) return;
      const chunk = text.slice(at, at + CHUNK_SIZE);
      streamed += chunk;
      ctx.emit.delta(messageId, textIndex, chunk);
      await sleep(CHUNK_DELAY_MS, state);
    }
  };

  const takeIndex = (): number => {
    textIndex = null;
    const index = nextIndex;
    nextIndex += 1;
    return index;
  };

  for (const segment of parsePrompt(ctx.prompt)) {
    if (state.stopped) break;
    switch (segment.kind) {
      case 'text':
        await writeText(segment.text);
        break;
      case 'sleep':
        await sleep(segment.ms, state);
        break;
      case 'tool': {
        const index = takeIndex();
        const toolId = newId('tool_');
        ctx.emit.part(messageId, index, {
          type: 'tool',
          toolId,
          name: 'fake_tool',
          input: { echo: true },
          output: null,
          status: 'running',
        });
        await sleep(TOOL_DELAY_MS, state);
        ctx.emit.part(messageId, index, {
          type: 'tool',
          toolId,
          name: 'fake_tool',
          input: { echo: true },
          output: 'ok',
          status: 'done',
        });
        break;
      }
      case 'permission': {
        const ticket = ctx.requestPermission('fake_tool', { echo: true }, 'the echo driver asks for a fake tool');
        const index = takeIndex();
        ctx.emit.part(messageId, index, {
          type: 'permission',
          requestId: ticket.requestId,
          toolName: 'fake_tool',
          decision: null,
        });
        const decision = await ticket;
        ctx.emit.part(messageId, index, {
          type: 'permission',
          requestId: ticket.requestId,
          toolName: 'fake_tool',
          decision,
        });
        await writeText(decision === 'allow' ? 'allowed' : 'denied');
        break;
      }
      case 'spawn': {
        const shell = shellFor(segment.command);
        const child = ctx.spawn(shell.cmd, shell.args);
        const output = await new Response(child.proc.stdout).text();
        await child.exited;
        await writeText(output);
        break;
      }
      case 'error': {
        const index = takeIndex();
        ctx.emit.part(messageId, index, { type: 'error', message: ERROR_MESSAGE });
        ctx.emit.complete(messageId, 'error');
        return { status: 'error', sessionId, usage: usage(), error: ERROR_MESSAGE };
      }
    }
  }

  ctx.emit.complete(messageId, 'complete');
  return { status: state.stopped ? 'stopped' : 'done', sessionId, usage: usage() };
}
