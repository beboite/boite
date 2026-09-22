import type { AgentCommand, MessageId, ToolDocument, Usage } from '@boite/contracts';
import { newId } from '../ids.ts';
import type { Driver, TitleContext, TurnContext, TurnHandle, TurnResult } from './types.ts';

const CHUNK_SIZE = 16;
const CHUNK_DELAY_MS = 5;
const TOOL_DELAY_MS = 5;
/**
 * Between two pieces of a streamed tool input. Long enough that a client, a test
 * or a capture sees the JSON half-typed, short enough to keep the turn under a second.
 */
const TOOL_STREAM_DELAY_MS = 120;
/** What `[tool-stream]` types, one piece at a time, before the parsed input lands. */
const TOOL_STREAM_INPUT = '{"command":"echo streamed","description":"a streamed input"}';
const TOOL_STREAM_PIECES = 4;
const ERROR_MESSAGE = 'echo error requested';

/** What `[question]`, or the bare word `question`, asks: two options and a free field. */
const QUESTION_TEXT = 'Which shape should the echo take?';
const QUESTION_OPTIONS = [
  { id: 'short', label: 'Short', description: 'one line back' },
  { id: 'long', label: 'Long', description: 'the whole prompt back' },
];

/** What `[diff]` edits: three lines in, four out, the middle one changed. */
const DIFF_PATH = 'src/app.ts';
const DIFF_OLD = 'export function boot() {\n  return start();\n}';
const DIFF_NEW = "export function boot() {\n  return start({ warm: true });\n  log('booted');\n}";
/** What `[doc]` reads: six lines with a heading, a list and a code fence. */
const DOC_TITLE = 'README.md';
const DOC_TEXT = [
  '# README',
  '- the first item',
  '- the second item',
  '```ts',
  'export const answer = 42;',
  '```',
].join('\n');
/** What `[image]` captures: a 1 by 1 PNG, base64 with no `data:` prefix. */
const IMAGE_MIME = 'image/png';
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The one command the fake acts on: `/shout <text>` comes back in capitals. */
const SHOUT = 'shout';
/** What the fake's title is made of: this prefix and the first words of the prompt. */
const TITLE_PREFIX = 'Echo:';
const TITLE_WORDS = 5;
/** What the fake lists as its `/name` commands, the way a real agent would on its first turn. */
const ECHO_COMMANDS: AgentCommand[] = [
  { name: SHOUT, description: 'The prompt back in capitals', hint: '<text>' },
  { name: 'whisper', description: 'The prompt back as it came', hint: null },
];

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'sleep'; ms: number }
  | { kind: 'tool' }
  | { kind: 'tool-stream' }
  | { kind: 'diff' }
  | { kind: 'doc' }
  | { kind: 'image' }
  /** `[permission:2]` raises two cards at once, the way parallel tool calls do. */
  | { kind: 'permission'; count: number }
  | { kind: 'question' }
  | { kind: 'think' }
  | { kind: 'compact' }
  | { kind: 'spawn'; command: string }
  | { kind: 'error' };

/** What the fake's context meter says: a fixed window, and a token per character of the prompt on top of a floor. */
const CONTEXT_WINDOW = 2_000;

/** A fixed prompt cache lifetime, so the timer and its journal column have something to carry in tests. */
const PROMPT_CACHE = { ttlSeconds: 300, source: 'documented' } as const;
const CONTEXT_FLOOR = 100;
/** What `[compact]` claims it held before compacting and keeps after. */
const COMPACT_PRE_TOKENS = 1_800;
const COMPACT_POST_TOKENS = 300;

/**
 * A directive in brackets, plus the bare word `question`: the fake agent asks
 * one whenever a prompt mentions it, which is what the end to end run types.
 */
const DIRECTIVE =
  /\[(?:sleep:\d+|tool-stream|tool|diff|doc|image|permission(?::\d+)?|question|think|compact|spawn:[^\]]*|error)\]|\bquestion\b/g;

export function parsePrompt(prompt: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  DIRECTIVE.lastIndex = 0;
  for (let match = DIRECTIVE.exec(prompt); match !== null; match = DIRECTIVE.exec(prompt)) {
    if (match.index > last) segments.push({ kind: 'text', text: prompt.slice(last, match.index) });
    const body = match[0].startsWith('[') ? match[0].slice(1, -1) : match[0];
    if (body.startsWith('sleep:')) segments.push({ kind: 'sleep', ms: Number(body.slice('sleep:'.length)) });
    else if (body.startsWith('spawn:')) segments.push({ kind: 'spawn', command: body.slice('spawn:'.length) });
    else if (body === 'tool-stream') segments.push({ kind: 'tool-stream' });
    else if (body === 'tool') segments.push({ kind: 'tool' });
    else if (body === 'diff') segments.push({ kind: 'diff' });
    else if (body === 'doc') segments.push({ kind: 'doc' });
    else if (body === 'image') segments.push({ kind: 'image' });
    else if (body.startsWith('permission')) {
      const count = body.startsWith('permission:') ? Number(body.slice('permission:'.length)) : 1;
      segments.push({ kind: 'permission', count: Number.isInteger(count) && count > 0 ? count : 1 });
    }
    else if (body === 'question') segments.push({ kind: 'question' });
    else if (body === 'think') segments.push({ kind: 'think' });
    else if (body === 'compact') segments.push({ kind: 'compact' });
    else segments.push({ kind: 'error' });
    last = match.index + match[0].length;
  }
  if (last < prompt.length) segments.push({ kind: 'text', text: prompt.slice(last) });
  return segments;
}

/** What the fake model claims to reason about: the prompt with its directives cut. */
export function thinkingFor(prompt: string): string {
  DIRECTIVE.lastIndex = 0;
  return `thinking about: ${prompt.replace(DIRECTIVE, '').trim()}`;
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

/** Resolves null on `stop()`, so a driver waiting on an answer is not stuck. */
function untilStopped(state: RunState): Promise<null> {
  if (state.stopped) return Promise.resolve(null);
  return new Promise<null>((resolve) => {
    state.waiters.add(() => {
      resolve(null);
    });
  });
}

/** `text` in `count` pieces, the last one taking the remainder. */
function splitInto(text: string, count: number): string[] {
  const size = Math.ceil(text.length / count);
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces;
}

function shellFor(command: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', command] };
  return { cmd: 'sh', args: ['-c', command] };
}

/**
 * What the fake calls a thread: `Echo:` and the first five words of the
 * prompt, its directives cut. Null on a prompt with no word, which is what
 * makes the core fall back to its own cut.
 */
export function echoTitle(prompt: string): string | null {
  DIRECTIVE.lastIndex = 0;
  const words = prompt.replace(DIRECTIVE, ' ').split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return `${TITLE_PREFIX} ${words.slice(0, TITLE_WORDS).join(' ')}`;
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
  title(ctx: TitleContext): Promise<string | null> {
    return Promise.resolve(echoTitle(ctx.prompt));
  },
};

async function run(ctx: TurnContext, state: RunState): Promise<TurnResult> {
  const sessionId = ctx.sessionId ?? `echo-${ctx.thread.id}`;
  const messageId: MessageId = ctx.emit.startMessage('assistant');
  let nextIndex = 0;
  let textIndex: number | null = null;
  let streamed = '';
  let contextTokens = CONTEXT_FLOOR + ctx.prompt.length;

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

  /** One thinking part, in two deltas, so a client sees it grow like real reasoning. */
  const writeThinking = async (text: string): Promise<void> => {
    const index = takeIndex();
    ctx.emit.part(messageId, index, { type: 'thinking', text: '' });
    const cut = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, cut), text.slice(cut)]) {
      if (state.stopped || chunk.length === 0) return;
      ctx.emit.delta(messageId, index, chunk);
      await sleep(CHUNK_DELAY_MS, state);
    }
  };

  /** One tool that lands whole, carrying the documents it produced. */
  const documentTool = async (
    name: string,
    input: unknown,
    output: string,
    documents: ToolDocument[],
  ): Promise<void> => {
    const index = takeIndex();
    const toolId = newId('tool_');
    ctx.emit.part(messageId, index, {
      type: 'tool',
      toolId,
      name,
      input,
      output: null,
      status: 'running',
      documents,
    });
    await sleep(TOOL_DELAY_MS, state);
    ctx.emit.part(messageId, index, {
      type: 'tool',
      toolId,
      name,
      input,
      output,
      status: 'done',
      documents,
    });
  };

  // What a real agent lists on its first message: the fake takes two commands.
  ctx.commands(ECHO_COMMANDS);
  const shouted = ctx.prompt.startsWith(`/${SHOUT} `) ? ctx.prompt.slice(SHOUT.length + 2) : null;
  const prompt = shouted === null ? ctx.prompt : shouted.toUpperCase();

  // An image is named back the way an agent that read it would: format and weight.
  for (const attachment of ctx.attachments) {
    if (state.stopped) break;
    const bytes = Buffer.from(attachment.data, 'base64').length;
    await writeText(`[image ${attachment.mimeType}, ${bytes} bytes${attachment.name === null ? '' : `, ${attachment.name}`}] `);
  }

  for (const segment of parsePrompt(prompt)) {
    if (state.stopped) break;
    switch (segment.kind) {
      case 'text':
        await writeText(segment.text);
        break;
      case 'sleep':
        await sleep(segment.ms, state);
        break;
      case 'think':
        await writeThinking(thinkingFor(ctx.prompt));
        break;
      case 'compact':
        ctx.emit.part(messageId, takeIndex(), {
          type: 'compaction',
          trigger: 'auto',
          preTokens: COMPACT_PRE_TOKENS,
          postTokens: COMPACT_POST_TOKENS,
        });
        contextTokens = COMPACT_POST_TOKENS;
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
      case 'tool-stream': {
        // The Claude driver's shape: the block opens with no input, the JSON
        // arrives as deltas, then the parsed input replaces the streamed text.
        const index = takeIndex();
        const toolId = newId('tool_');
        ctx.emit.part(messageId, index, {
          type: 'tool',
          toolId,
          name: 'Bash',
          input: {},
          inputText: '',
          output: null,
          status: 'running',
        });
        for (const piece of splitInto(TOOL_STREAM_INPUT, TOOL_STREAM_PIECES)) {
          if (state.stopped) break;
          await sleep(TOOL_STREAM_DELAY_MS, state);
          ctx.emit.delta(messageId, index, piece);
        }
        // The whole json is on screen for one cadence before the parsed input
        // takes its place, the way a block stop precedes the assistant frame.
        await sleep(TOOL_STREAM_DELAY_MS, state);
        const parsed: unknown = JSON.parse(TOOL_STREAM_INPUT);
        ctx.emit.part(messageId, index, {
          type: 'tool',
          toolId,
          name: 'Bash',
          input: parsed,
          inputText: null,
          output: null,
          status: 'running',
        });
        await sleep(TOOL_DELAY_MS, state);
        ctx.emit.part(messageId, index, {
          type: 'tool',
          toolId,
          name: 'Bash',
          input: parsed,
          inputText: null,
          output: 'streamed',
          status: 'done',
        });
        break;
      }
      case 'diff':
        await documentTool(
          'Edit',
          { file_path: DIFF_PATH, old_string: DIFF_OLD, new_string: DIFF_NEW },
          'edited 1 file',
          [{ kind: 'diff', path: DIFF_PATH, oldText: DIFF_OLD, newText: DIFF_NEW }],
        );
        break;
      case 'doc':
        await documentTool('Read', { file_path: DOC_TITLE }, `read ${DOC_TITLE}`, [
          { kind: 'markdown', title: DOC_TITLE, text: DOC_TEXT },
        ]);
        break;
      case 'image':
        await documentTool('Screenshot', { region: 'window' }, 'captured the window', [
          { kind: 'image', mimeType: IMAGE_MIME, data: IMAGE_BASE64, alt: 'one pixel' },
        ]);
        break;
      case 'permission': {
        // Every card is raised before any is awaited, so `[permission:2]` is
        // two open at once: what an agent asking for two parallel tool calls
        // does, and what the thread status has to survive.
        const cards = [];
        for (let card = 0; card < segment.count; card += 1) {
          const ticket = ctx.requestPermission('fake_tool', { echo: true }, 'the echo driver asks for a fake tool');
          const index = takeIndex();
          ctx.emit.part(messageId, index, {
            type: 'permission',
            requestId: ticket.requestId,
            toolName: 'fake_tool',
            decision: null,
          });
          cards.push({ ticket, index });
        }
        const decisions = await Promise.all(cards.map(({ ticket }) => ticket));
        cards.forEach(({ ticket, index }, card) => {
          ctx.emit.part(messageId, index, {
            type: 'permission',
            requestId: ticket.requestId,
            toolName: 'fake_tool',
            decision: decisions[card] ?? 'deny',
          });
        });
        await writeText(decisions.every((decision) => decision === 'allow') ? 'allowed' : 'denied');
        break;
      }
      case 'question': {
        const ticket = ctx.askQuestion({
          text: QUESTION_TEXT,
          options: QUESTION_OPTIONS,
          allowText: true,
          multiple: false,
        });
        const index = takeIndex();
        ctx.emit.part(messageId, index, {
          type: 'question',
          questionId: ticket.questionId,
          text: QUESTION_TEXT,
          options: QUESTION_OPTIONS,
          allowText: true,
          multiple: false,
          answer: null,
        });
        // A stop while the card is open ends the wait: the pending question is
        // cancelled with the turn, and the driver settles instead of hanging.
        const answer = await Promise.race([ticket, untilStopped(state)]);
        ctx.emit.part(messageId, index, {
          type: 'question',
          questionId: ticket.questionId,
          text: QUESTION_TEXT,
          options: QUESTION_OPTIONS,
          allowText: true,
          multiple: false,
          answer,
        });
        // The answer echoed back, which is what a test and a capture read.
        if (answer === null) await writeText('question cancelled');
        else await writeText(`answered ${[...answer.optionIds, answer.text ?? ''].filter((p) => p.length > 0).join(' ')}`);
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
  ctx.context({ tokens: contextTokens, window: CONTEXT_WINDOW });
  return { status: state.stopped ? 'stopped' : 'done', sessionId, usage: usage(), promptCache: PROMPT_CACHE };
}
