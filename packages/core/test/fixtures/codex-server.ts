/**
 * A fake Codex app-server over stdio, the counterpart of `acp-agent.ts`: it
 * speaks the real app-server protocol as `codex app-server generate-ts` writes
 * it (`initialize`, `thread/start`, `thread/resume`, `turn/start`,
 * `turn/interrupt`, the `item/*` notifications and the `item/*` approval
 * requests) and obeys prompt directives, so the Codex driver is proved without
 * the real binary and without a login.
 *
 * Run as `bun <this file>`. `CODEX_FAKE_LOG` names a file it appends one line
 * per incoming request to: `initialize`, `initialized`,
 * `thread/start approvalPolicy=<p> sandbox=<s> model=<m>`,
 * `thread/resume <threadId> ...`, `turn/start model=<m> effort=<e>`,
 * `turn/interrupt <turnId>` and `model/list`. One `initialize` line per process,
 * so a test can count the agent processes a warm session did or did not save.
 *
 * The wire is copied from the real server on purpose: responses and
 * notifications carry no `jsonrpc` member, which is what the driver has to
 * survive.
 */
import { appendFileSync } from 'node:fs';

const DIRECTIVE = /\[(command|approve|thought|usage|slow|crash|input)\]/g;
const CHUNKS = 3;

type Directive = 'command' | 'approve' | 'thought' | 'usage' | 'slow' | 'crash' | 'input';

let threadCounter = 0;
let turnCounter = 0;
let itemCounter = 0;
let threadId = '';
/**
 * The turns an interrupt already arrived for, and what is waiting on one. A
 * real server knows a turn from the moment it answers `turn/start`, so an
 * interrupt that lands before the turn reaches its first await is remembered
 * rather than dropped: the driver sends one the instant it learns the turn id.
 */
const interrupted = new Set<string>();
const waiting = new Map<string, () => void>();

function awaitInterrupt(turnId: string): Promise<void> {
  if (interrupted.has(turnId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiting.set(turnId, resolve);
  });
}

function log(line: string): void {
  const file = process.env['CODEX_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const pending = new Map<number, Pending>();
let nextId = 1;

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** No `jsonrpc` member, exactly like the real app-server. */
function notify(method: string, params: unknown): void {
  send({ method, params, emittedAtMs: Date.now() });
}

function request<T>(method: string, params: unknown): Promise<T> {
  const id = nextId;
  nextId += 1;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    send({ id, method, params });
  });
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function promptOf(params: Record<string, unknown>): string {
  const input = params['input'];
  if (!Array.isArray(input)) return '';
  return input
    .map((entry) => textOf((entry as Record<string, unknown>)['text']))
    .join('');
}

/** Every `{ type: 'image', url: ... }` entry of `turn/start`'s `input`, logged as `image <url>`. */
function imageUrlsOf(params: Record<string, unknown>): string[] {
  const input = params['input'];
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry) => (entry as Record<string, unknown>)['type'] === 'image')
    .map((entry) => textOf((entry as Record<string, unknown>)['url']));
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

function turnRecord(turnId: string, status: string): unknown {
  return {
    id: turnId,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: status === 'failed' ? { message: 'the fake failed', codexErrorInfo: null } : null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: status === 'inProgress' ? null : Math.floor(Date.now() / 1000),
    durationMs: status === 'inProgress' ? null : 1,
  };
}

/**
 * What `model/list` answers, shaped like the real `Model` record: an id, a
 * display name, a per-model effort scale with its own default, and one model
 * flagged `isDefault`. Three of them, so a probe test can tell the order and the
 * flag apart. `fake-plain` lists no effort at all, which is the case a model
 * with no reasoning control has to survive.
 */
const MODELS = [
  {
    id: 'fake-fast',
    model: 'fake-fast',
    displayName: 'Fake Fast',
    description: 'the quick one',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'quick' },
      { reasoningEffort: 'medium', description: 'balanced' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    isDefault: false,
  },
  {
    id: 'fake-smart',
    model: 'fake-smart',
    displayName: 'Fake Smart',
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Priority processing' }, { id: 'ultrafast', name: 'Ultrafast', description: 'Access-controlled tier' }],
    description: 'the slow one',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'quick' },
      { reasoningEffort: 'medium', description: 'balanced' },
      { reasoningEffort: 'high', description: 'deep' },
    ],
    defaultReasoningEffort: 'high',
    inputModalities: ['text'],
    isDefault: true,
  },
  {
    id: 'fake-plain',
    model: 'fake-plain',
    displayName: 'Fake Plain',
    description: 'no reasoning control',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    isDefault: false,
  },
];

function threadRecord(): unknown {
  return { id: threadId, sessionId: threadId, model: 'fake-codex', cwd: process.cwd(), turns: [] };
}

function commandItem(itemId: string, status: string, output: string | null): unknown {
  return {
    type: 'commandExecution',
    id: itemId,
    pluginId: null,
    scriptPath: null,
    command: 'echo hello',
    cwd: process.cwd(),
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: output,
    exitCode: status === 'completed' ? 0 : null,
    durationMs: 1,
  };
}

async function runTurn(turnId: string, text: string): Promise<void> {
  notify('turn/started', { threadId, turn: turnRecord(turnId, 'inProgress') });
  if (text.includes('[tasks]')) notify('turn/plan/updated', { threadId, turnId, plan: [{ step: 'Inspect source', status: 'completed' }, { step: 'Run checks', status: 'inProgress' }] });
  const directives = directivesOf(text);
  const say = (chunk: string): void => {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: chunk });
  };

  // A real agent reasons before it answers, so the reasoning deltas go first.
  for (const directive of directives) {
    if (directive !== 'thought') continue;
    notify('item/reasoning/textDelta', {
      threadId,
      turnId,
      itemId: 'reasoning-1',
      delta: 'thinking about it',
      contentIndex: 0,
    });
  }

  for (const chunk of chunksOf(plainOf(text))) say(chunk);

  for (const directive of directives) {
    switch (directive) {
      case 'command': {
        itemCounter += 1;
        const itemId = `item-${itemCounter}`;
        notify('item/started', {
          item: commandItem(itemId, 'inProgress', null),
          threadId,
          turnId,
          startedAtMs: Date.now(),
        });
        notify('item/completed', {
          item: commandItem(itemId, 'completed', 'ok'),
          threadId,
          turnId,
          completedAtMs: Date.now(),
        });
        break;
      }
      case 'approve': {
        itemCounter += 1;
        const itemId = `item-${itemCounter}`;
        const answer = await request<{ decision: string }>('item/commandExecution/requestApproval', {
          kind: 'command',
          threadId,
          turnId,
          itemId,
          startedAtMs: Date.now(),
          approvalId: null,
          environmentId: null,
          reason: 'the fake wants to run a command',
          command: 'echo hello',
          cwd: process.cwd(),
          commandActions: [],
        });
        const accepted = answer.decision === 'accept' || answer.decision === 'acceptForSession';
        notify('item/completed', {
          item: commandItem(itemId, accepted ? 'completed' : 'declined', accepted ? 'ok' : null),
          threadId,
          turnId,
          completedAtMs: Date.now(),
        });
        say(accepted ? 'allowed' : 'denied');
        break;
      }
      case 'input': {
        itemCounter += 1;
        const answer = await request<{ answers: Record<string, unknown> }>('item/tool/requestUserInput', {
          threadId,
          turnId,
          itemId: `item-${itemCounter}`,
          questions: [
            {
              id: 'q1',
              header: 'Pick',
              question: 'which one?',
              isOther: true,
              isSecret: false,
              options: [
                { id: 'red', label: 'Red' },
                { id: 'blue', label: 'Blue' },
              ],
            },
          ],
          isBlocking: true,
          autoResolutionMs: null,
        });
        const given = answer.answers ?? {};
        const q1 = typeof given['q1'] === 'string' ? given['q1'] : '';
        say(q1.length === 0 ? 'input refused' : `input answered ${q1}`);
        break;
      }
      case 'usage':
        notify('thread/tokenUsage/updated', {
          threadId,
          turnId,
          tokenUsage: {
            total: {
              totalTokens: 12,
              inputTokens: 8,
              cachedInputTokens: 2,
              cacheWriteInputTokens: 1,
              outputTokens: 4,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 12,
              inputTokens: 8,
              cachedInputTokens: 2,
              cacheWriteInputTokens: 1,
              outputTokens: 4,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: null,
          },
        });
        break;
      case 'slow':
        await awaitInterrupt(turnId);
        waiting.delete(turnId);
        interrupted.delete(turnId);
        notify('turn/completed', { threadId, turn: turnRecord(turnId, 'interrupted') });
        return;
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

  notify('turn/completed', { threadId, turn: turnRecord(turnId, 'completed') });
}

function handle(method: string, raw: unknown): unknown {
  const params = (raw ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'initialize':
      log('initialize');
      return {
        userAgent: 'codex-fake/0 (test) boite',
        codexHome: process.cwd(),
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform === 'win32' ? 'windows' : 'linux',
      };
    case 'model/list':
      log('model/list');
      // One page, and a null cursor: the driver stops asking on that.
      return { data: MODELS, nextCursor: null };
    case 'thread/start': {
      threadCounter += 1;
      threadId = `codex-fake-${Math.random().toString(16).slice(2, 10)}-${threadCounter}`;
      log(
        `thread/start approvalPolicy=${textOf(params['approvalPolicy'])} sandbox=${textOf(params['sandbox'])} model=${textOf(params['model'])}`,
      );
      return { thread: threadRecord(), model: 'fake-codex', modelProvider: 'fake', serviceTier: null };
    }
    case 'thread/resume': {
      threadId = textOf(params['threadId']);
      log(
        `thread/resume ${threadId} approvalPolicy=${textOf(params['approvalPolicy'])} sandbox=${textOf(params['sandbox'])}`,
      );
      return { thread: threadRecord(), model: 'fake-codex', modelProvider: 'fake', serviceTier: null };
    }
    case 'thread/compact/start': {
      log('thread/compact/start');
      const compactId = `compact-${++turnCounter}`;
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId, turn: turnRecord(compactId, 'inProgress') } });
        send({ method: 'item/completed', params: { threadId, item: { id: 'compact-item', type: 'contextCompaction' } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { modelContextWindow: 200000, last: { inputTokens: 30000, outputTokens: 2000, totalTokens: 32000 } } } });
        send({ method: 'turn/completed', params: { threadId, turn: turnRecord(compactId, 'completed') } });
      }, 0);
      return {};
    }
    case 'turn/start': {
      turnCounter += 1;
      const turnId = `codex-fake-turn-${turnCounter}`;
      log(`turn/start model=${textOf(params['model'])} effort=${textOf(params['effort'])}`);
      log(JSON.stringify({ serviceTier: params['serviceTier'] }));
      for (const url of imageUrlsOf(params)) log(`image ${url}`);
      // After the response is written, never before: a real server answers the
      // request and streams the turn afterwards.
      setTimeout(() => {
        void runTurn(turnId, promptOf(params));
      }, 0);
      return { turn: turnRecord(turnId, 'inProgress') };
    }
    case 'turn/interrupt': {
      const turnId = textOf(params['turnId']);
      log(`turn/interrupt ${turnId}`);
      const waiter = waiting.get(turnId);
      if (waiter === undefined) interrupted.add(turnId);
      else waiter();
      return {};
    }
    default:
      throw new Error(`the fake codex server does not implement ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at < 0) break;
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length === 0) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const method = message['method'];
    const id = message['id'];
    if (typeof method === 'string' && id !== undefined && id !== null) {
      try {
        send({ id, result: handle(method, message['params']) });
      } catch (error) {
        send({ id, error: { code: -32601, message: (error as Error).message } });
      }
      continue;
    }
    if (typeof method === 'string') {
      log(method);
      continue;
    }
    if (typeof id !== 'number') continue;
    const entry = pending.get(id);
    if (entry === undefined) continue;
    pending.delete(id);
    const error = message['error'];
    if (error !== undefined && error !== null) entry.reject(new Error(JSON.stringify(error)));
    else entry.resolve(message['result']);
  }
});
