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
 * then one line per command it receives (`prompt`, `abort`), and one
 * `image <mimeType> <byte length>` line per `images` entry a `prompt` command
 * carries. The argv line is what tells a test how many agent processes a warm
 * session did or did not save.
 *
 * The framing is copied from the real mode on purpose: strict JSONL, LF only.
 */
import { appendFileSync } from 'node:fs';

const DIRECTIVE = /\[(tool|thought|usage|slow|crash|ask|select|input|editor|retry|giveup|deaf|noclear|notify|timeout|compacted)\]/g;
const CHUNKS = 3;

/**
 * `retry` and `giveup` play pi's own auto-retry after a 529, recovered or not.
 * `deaf` never settles and ignores `abort`, like a pi stuck in a tool that
 * ignores the signal. `noclear` makes `clear_queue` fail. `notify` sends the
 * fire-and-forget UI methods, `timeout` a confirm that pi gives up on after
 * 50 ms, `compacted` an automatic compaction inside the run.
 */
type Directive =
  | 'tool'
  | 'thought'
  | 'usage'
  | 'slow'
  | 'crash'
  | 'ask'
  | 'select'
  | 'input'
  | 'editor'
  | 'retry'
  | 'giveup'
  | 'deaf'
  | 'noclear'
  | 'notify'
  | 'timeout'
  | 'compacted';

let toolCounter = 0;
let dialogCounter = 0;
/** What `get_state` reports as `isStreaming`: true from the prompt's answer to `agent_settled`, as in pi. */
let streaming = false;
/** Set by `[deaf]`: `abort` gets no answer at all. */
let deaf = false;
/** Set by `[noclear]`: `clear_queue` is refused. */
let noClear = false;
/** Set by `set_thinking_level`, reported by `get_state`. */
let thinkingLevel = 'medium';
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

/** The end of a run as pi writes it: `turn_end`, `agent_end` with nothing left to retry, `agent_settled`. */
function endRun(message: Record<string, unknown>): void {
  send({ type: 'turn_end', message, toolResults: [] });
  send({ type: 'agent_end', messages: [message], willRetry: false });
  streaming = false;
  send({ type: 'agent_settled' });
}

/**
 * pi's auto-retry after a 529, in the order `agent-session.js` writes it: the
 * failed message, `agent_end` that will retry, `auto_retry_start`, then the
 * next attempt inside the same run and `auto_retry_end` once it is known.
 */
async function runRetry(giveUp: boolean): Promise<void> {
  send({ type: 'agent_start' });
  const failed = { ...assistantMessage('error', zeroUsage()), errorMessage: '529 overloaded' };
  send({ type: 'message_end', message: failed });
  send({ type: 'turn_end', message: failed, toolResults: [] });
  send({ type: 'agent_end', messages: [failed], willRetry: true });
  send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '529 overloaded' });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });
  send({ type: 'agent_start' });
  if (giveUp) {
    const again = { ...assistantMessage('error', zeroUsage()), errorMessage: '529 overloaded' };
    send({ type: 'message_end', message: again });
    send({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded after 3 attempts' });
    endRun(again);
    return;
  }
  send({ type: 'message_start', message: assistantMessage('pending', zeroUsage()) });
  send({
    type: 'message_update',
    usage: zeroUsage(),
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'recovered answer' },
  });
  const answer = assistantMessage('stop', zeroUsage());
  send({ type: 'message_end', message: answer });
  send({ type: 'auto_retry_end', success: true, attempt: 2 });
  endRun(answer);
}

async function runPrompt(text: string): Promise<void> {
  const directives = directivesOf(text);
  if (directives.includes('retry') || directives.includes('giveup')) {
    await runRetry(directives.includes('giveup'));
    return;
  }

  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  send({ type: 'message_start', message: assistantMessage('pending', zeroUsage()) });

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
      case 'select':
      case 'input':
      case 'editor':
      case 'ask': {
        const answer = await askDialog(directive === 'ask' ? 'confirm' : directive, {
          title: 'Do the thing?',
          message: 'the fake extension is asking',
          options: ['First choice', 'Second choice'],
          prefill: 'existing text',
        });
        say(answer['cancelled'] === true ? 'dialog cancelled' : directive === 'ask' ? 'dialog answered' : textOf(answer['value']));
        break;
      }
      case 'usage':
        usage = usageBlock();
        break;
      case 'slow':
        log('waiting for abort');
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
      case 'deaf':
        log('waiting forever');
        await new Promise<void>(() => undefined);
        break;
      case 'notify':
        dialogCounter += 1;
        send({ type: 'extension_ui_request', id: `n-${dialogCounter}`, method: 'notify', message: 'heads up', notifyType: 'warning' });
        send({ type: 'extension_ui_request', id: `s-${dialogCounter}`, method: 'setStatus', statusKey: 'fake', statusText: 'busy' });
        send({ type: 'extension_ui_request', id: `w-${dialogCounter}`, method: 'setWidget', widgetKey: 'fake', widgetLines: ['one'] });
        send({ type: 'extension_ui_request', id: `t-${dialogCounter}`, method: 'setTitle', title: 'fake' });
        send({ type: 'extension_ui_request', id: `e-${dialogCounter}`, method: 'set_editor_text', text: 'draft' });
        send({ type: 'extension_ui_request', id: `x-${dialogCounter}`, method: 'notify', message: 'it broke', notifyType: 'error' });
        break;
      case 'timeout': {
        // pi resolves a dialog with a timeout by itself and goes on.
        const pending = askDialog('confirm', { title: 'Hurry?', message: 'pi waits 50 ms', timeout: 50 });
        const id = `ui-${dialogCounter}`;
        const answer = await Promise.race([
          pending,
          new Promise<null>((resolve) => {
            setTimeout(() => {
              resolve(null);
            }, 50);
          }),
        ]);
        if (answer === null) {
          dialogs.delete(id);
          log('dialog timed out');
          say('dialog timed out');
        }
        break;
      }
      case 'compacted':
        send({ type: 'compaction_start', reason: 'threshold' });
        send({
          type: 'compaction_end',
          reason: 'threshold',
          result: {
            summary: 'earlier work',
            firstKeptEntryId: 'm-2',
            tokensBefore: 180000,
            estimatedTokensAfter: 30000,
            usage: usageBlock(),
            details: {},
          },
          aborted: false,
          willRetry: false,
        });
        break;
      case 'retry':
      case 'giveup':
      case 'noclear':
      case 'thought':
        // Handled before the run or when the prompt arrived.
        break;
    }
  }

  const message = assistantMessage(stopReason, usage);
  send({ type: 'message_end', message });
  endRun(message);
}

function handle(message: Record<string, unknown>): void {
  const type = textOf(message['type']);
  const id = message['id'];

  if (type === 'extension_ui_response') {
    const resolve = dialogs.get(textOf(id));
    if (resolve !== undefined) {
      dialogs.delete(textOf(id));
      resolve(message);
    } else {
      // An answer to something nothing waits on: a notice, or a dialog pi gave up on.
      log(`ui-response ${textOf(id)}`);
    }
    return;
  }

  log(type);
  switch (type) {
    case 'compact': {
      send({ id, type: 'response', command: 'compact', success: true, data: { tokensBefore: 150000, summary: 'remember this', firstKeptEntryId: 'm-1' } });
      return;
    }
    case 'clear_queue': {
      if (noClear) {
        send({ id, type: 'response', command: 'clear_queue', success: false, error: 'the fake queue is locked' });
        return;
      }
      send({ id, type: 'response', command: 'clear_queue', success: true, data: { steering: [], followUp: [] } });
      return;
    }
    case 'set_model': {
      log(`model ${textOf(message['provider'])}/${textOf(message['modelId'])}`);
      const found = MODELS.find((entry) => entry.provider === message['provider'] && entry.id === message['modelId']);
      if (found === undefined) {
        send({ id, type: 'response', command: 'set_model', success: false, error: `Model not found: ${textOf(message['provider'])}/${textOf(message['modelId'])}` });
        return;
      }
      send({ id, type: 'response', command: 'set_model', success: true, data: found });
      return;
    }
    case 'set_thinking_level': {
      thinkingLevel = textOf(message['level']);
      log(`level ${thinkingLevel}`);
      send({ id, type: 'response', command: 'set_thinking_level', success: true });
      return;
    }
    case 'get_session_stats': {
      send({
        id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: { sessionId, contextUsage: { tokens: 4321, contextWindow: 200000, percent: 2.16 } },
      });
      return;
    }
    case 'steer': {
      if (!waitingAbort) { send({ id, type: 'response', command: 'steer', success: false, error: 'no active turn' }); return; }
      log(`steering ${textOf(message['message'])}`);
      send({ id, type: 'response', command: 'steer', success: true });
      return;
    }
    case 'prompt': {
      const images = message['images'];
      if (Array.isArray(images)) {
        for (const image of images) {
          const entry = image as Record<string, unknown>;
          log(`image ${textOf(entry['mimeType'])} ${textOf(entry['data']).length}`);
        }
      }
      const text = textOf(message['message']);
      if (text.trimStart().startsWith('/fake-report')) {
        // An extension command: pi runs it, answers the prompt and starts no run,
        // so no event and no `agent_settled` follow.
        send({ id, type: 'response', command: 'prompt', success: true });
        log('extension command handled');
        return;
      }
      if (text.includes('[preflight]')) {
        // A preflight that never ends (a before_agent_start handler, an auth
        // check on a dead network): real pi holds the prompt's answer until it
        // is over, and stays idle, so it still answers `abort` and `get_state`.
        log('preflight never ends');
        return;
      }
      streaming = true;
      deaf = text.includes('[deaf]');
      noClear = text.includes('[noclear]');
      send({ id, type: 'response', command: 'prompt', success: true });
      // After the response is written, never before: the real mode answers the
      // command and streams the run afterwards.
      setTimeout(() => {
        void runPrompt(text);
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
          thinkingLevel,
          isStreaming: streaming,
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
    case 'get_commands': {
      send({
        id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: {
          commands: [
            { name: 'fake-report', description: 'Write a status report', source: 'extension' },
            { name: 'skill:fake-search', description: 'Search fake docs', source: 'skill', location: 'user' },
          ],
        },
      });
      return;
    }
    case 'abort': {
      if (deaf) {
        log('abort ignored');
        return;
      }
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
