/**
 * A fake pi in RPC mode over stdio, the counterpart of `codex-server.ts`: it
 * speaks the protocol `docs/rpc.md` of `@earendil-works/pi-coding-agent`
 * describes (the `prompt` and `abort` commands answered by a `response` with the
 * same id, the `message_update` deltas, the `tool_execution_*` events,
 * `message_end` and `agent_settled`, and the `extension_ui_request` an extension
 * dialog sends back to the client) and obeys prompt directives, so the pi driver
 * is proved without the real binary and without a login.
 *
 * Run as `bun <this file>`. `PI_FAKE_LOG` names a file it appends to: one
 * `argv sessionId=<id> sessionDir=<dir> model=<m>` line per process at start,
 * then one line per command it receives (`prompt`, `abort`). The argv line is
 * what tells a test how many agent processes a warm session did or did not save.
 *
 * The framing is copied from the real mode on purpose: strict JSONL, LF only.
 */
import { appendFileSync } from 'node:fs';

const DIRECTIVE = /\[(tool|thought|usage|slow|crash|ask)\]/g;
const CHUNKS = 3;

type Directive = 'tool' | 'thought' | 'usage' | 'slow' | 'crash' | 'ask';

let toolCounter = 0;
let dialogCounter = 0;
/** Resolves when an `abort` arrives, for the one directive that waits on it. */
let waitingAbort: (() => void) | null = null;
/**
 * An abort that arrived before the run reached its first await. A real pi knows
 * about the run from the moment it answers the `prompt` command, so one that
 * lands in that window is remembered rather than dropped: the driver sends it
 * the instant the core asks for a stop, which can be before the first event.
 */
let pendingAbort = false;

function awaitAbort(): Promise<void> {
  if (pendingAbort) {
    pendingAbort = false;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitingAbort = resolve;
  });
}

function log(line: string): void {
  const file = process.env['PI_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// What it was launched with
// ---------------------------------------------------------------------------

function flag(name: string): string {
  const at = process.argv.indexOf(name);
  return at < 0 ? '' : (process.argv[at + 1] ?? '');
}

const sessionId = flag('--session-id');
const sessionDir = flag('--session-dir');
const model = flag('--model');
log(`argv sessionId=${sessionId} sessionDir=${sessionDir} model=${model}`);

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** The dialog answers a client sends back, keyed by the id the request carried. */
const dialogs = new Map<string, (answer: Record<string, unknown>) => void>();

function askDialog(method: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  dialogCounter += 1;
  const id = `ui-${dialogCounter}`;
  return new Promise<Record<string, unknown>>((resolve) => {
    dialogs.set(id, resolve);
    send({ type: 'extension_ui_request', id, method, ...extra });
  });
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function directivesOf(text: string): Directive[] {
  DIRECTIVE.lastIndex = 0;
  const found: Directive[] = [];
  for (let match = DIRECTIVE.exec(text); match !== null; match = DIRECTIVE.exec(text)) {
    found.push(match[1] as Directive);
  }
  return found;
}

function plainOf(text: string): string {
  return text.replace(DIRECTIVE, '');
}

function chunksOf(text: string): string[] {
  const size = Math.ceil(text.length / CHUNKS);
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

function usageBlock(): Record<string, unknown> {
  return {
    input: 8,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 15,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
}

function zeroUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ---------------------------------------------------------------------------
// What the probe asks: the models and the thinking levels
// ---------------------------------------------------------------------------

/**
 * Three models across two providers, shaped like `Model` of
 * `@earendil-works/pi-ai`: one that maps the two opt-in levels, one that maps
 * neither, and one without reasoning at all, whose only level is `off`.
 */
const MODELS = [
  {
    id: 'smart',
    name: 'Fake Smart',
    api: 'fake',
    provider: 'fake-a',
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 64000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
  },
  {
    id: 'quick',
    name: 'Fake Quick',
    api: 'fake',
    provider: 'fake-a',
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'plain',
    name: 'Fake Plain',
    api: 'fake',
    provider: 'fake-b',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    contextWindow: 32000,
    maxTokens: 8000,
  },
];

/** The model the session is on, which is the one pi reports as current. */
const CURRENT = MODELS[0];
const CURRENT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function assistantMessage(stopReason: string, usage: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [],
    api: 'fake',
    provider: 'fake',
    model: model.length === 0 ? 'fake-pi' : model,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

async function runPrompt(text: string): Promise<void> {
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  send({ type: 'message_start', message: assistantMessage('pending', zeroUsage()) });

  const directives = directivesOf(text);
  const say = (chunk: string): void => {
    send({
      type: 'message_update',
      usage: zeroUsage(),
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk },
    });
  };

  // A real agent reasons before it answers, so the thinking deltas go first.
  for (const directive of directives) {
    if (directive !== 'thought') continue;
    send({
      type: 'message_update',
      usage: zeroUsage(),
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'thinking about it' },
    });
  }

  for (const chunk of chunksOf(plainOf(text))) say(chunk);

  let usage = zeroUsage();
  let stopReason = 'stop';

  for (const directive of directives) {
    switch (directive) {
      case 'tool': {
        toolCounter += 1;
        const toolCallId = `call-${toolCounter}`;
        send({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'echo hello' } });
        send({
          type: 'tool_execution_end',
          toolCallId,
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'ok' }], details: {} },
          isError: false,
        });
        break;
      }
      case 'ask': {
        const answer = await askDialog('confirm', {
          title: 'Do the thing?',
          message: 'the fake extension is asking',
        });
        say(answer['cancelled'] === true ? 'dialog cancelled' : 'dialog answered');
        break;
      }
      case 'usage':
        usage = usageBlock();
        break;
      case 'slow':
        await awaitAbort();
        waitingAbort = null;
        stopReason = 'aborted';
        break;
      case 'crash':
        process.stderr.write('boom\n');
        setTimeout(() => {
          process.exit(3);
        }, 20);
        // The exit is what the client sees; this promise never settles.
        await new Promise<void>(() => undefined);
        break;
      case 'thought':
        // Already sent above, before the answer.
        break;
    }
  }

  const message = assistantMessage(stopReason, usage);
  send({ type: 'message_end', message });
  send({ type: 'turn_end', message, toolResults: [] });
  send({ type: 'agent_end', messages: [message], willRetry: false });
  send({ type: 'agent_settled' });
}

function handle(message: Record<string, unknown>): void {
  const type = textOf(message['type']);
  const id = message['id'];

  if (type === 'extension_ui_response') {
    const resolve = dialogs.get(textOf(id));
    if (resolve !== undefined) {
      dialogs.delete(textOf(id));
      resolve(message);
    }
    return;
  }

  log(type);
  switch (type) {
    case 'prompt': {
      send({ id, type: 'response', command: 'prompt', success: true });
      // After the response is written, never before: the real mode answers the
      // command and streams the run afterwards.
      setTimeout(() => {
        void runPrompt(textOf(message['message']));
      }, 0);
      return;
    }
    case 'get_state': {
      send({
        id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: CURRENT,
          thinkingLevel: 'medium',
          isStreaming: false,
          isCompacting: false,
          sessionId,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
      return;
    }
    case 'get_available_models': {
      send({ id, type: 'response', command: 'get_available_models', success: true, data: { models: MODELS } });
      return;
    }
    case 'get_available_thinking_levels': {
      // Real pi answers for the model the session is on and for no other.
      send({
        id,
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: CURRENT_LEVELS },
      });
      return;
    }
    case 'abort': {
      const waiter = waitingAbort;
      waitingAbort = null;
      if (waiter === undefined || waiter === null) pendingAbort = true;
      else waiter();
      send({ id, type: 'response', command: 'abort', success: true });
      return;
    }
    default:
      send({ id, type: 'response', command: type, success: false, error: `the fake pi does not implement ${type}` });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at < 0) break;
    let line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    handle(message);
  }
});
