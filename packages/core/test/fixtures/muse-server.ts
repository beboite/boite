/**
 * A fake `muse serve` over stdio, the counterpart of `codex-server.ts`: it
 * speaks Muse's session protocol as `muse schema generate-ts` writes it
 * (`initialize`, `model/list`, `session/start`, `session/resume`,
 * `session/setModel`, `session/setApprovalMode`, `turn/start`,
 * `turn/interrupt`, `approval/decide`, `userInput/answer`, `userInput/cancel`,
 * `session/compact`, and the `item/*`, `turn/*`, `approval/*`, `userInput/*`
 * and `session/*` notifications) and obeys prompt directives, so the Muse
 * driver is proved without the real binary and without a login.
 *
 * Run as `bun <this file> [host flags]`. `MUSE_FAKE_LOG` names a file it
 * appends one line per incoming request to, and `MUSE_FAKE_HOME` is the
 * `museHome` it reports, where a test puts a `model-catalog/` of its own.
 * `MUSE_FAKE_INIT` delays the answer to `initialize` by that many ms, or never
 * sends it when set to `never`, for the tests of a stalled startup.
 */
import { appendFileSync } from 'node:fs';

const DIRECTIVE =
  /\[(command|approve|edit|edit-out|edit-link|thought|usage|tasks|slow|crash|input|auth|server-request|close-idle)\]/g;
const CHUNKS = 3;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Directive =
  | 'command'
  | 'approve'
  | 'edit'
  | 'edit-out'
  | 'edit-link'
  | 'thought'
  | 'usage'
  | 'tasks'
  | 'slow'
  | 'crash'
  | 'input'
  | 'auth'
  | 'server-request'
  | 'close-idle';

/** The host flags after the script, fixed for the process like the real ones. */
const FLAGS = process.argv.slice(2).join(' ');

let sessionId = '';
let modelId = 'muse-spark-1.3';
let approvalMode = 'promptUnmatched';
let itemCounter = 0;
let turnsRun = 0;
let nextServerId = 1;
/** Set by `[close-idle]`: the session is unloaded, `turn/start` is refused until `session/resume`. */
let closed = false;

/** What waits on a command from the client, by the id the host handed out. */
const interrupted = new Set<string>();
const waitingInterrupt = new Map<string, () => void>();
const waitingApproval = new Map<string, (choiceId: string) => void>();
const waitingInput = new Map<string, (answers: unknown[] | null) => void>();

function log(line: string): void {
  const file = process.env['MUSE_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ method, params: { sessionId, ...params } });
}

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
  if (text.length === 0) return [];
  const size = Math.ceil(text.length / CHUNKS);
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

function nextItemId(): string {
  itemCounter += 1;
  return `item-${itemCounter}`;
}

function sessionRecord(): Record<string, unknown> {
  return {
    sessionId,
    workspaceRoot: process.cwd(),
    modelId,
    providerId: 'meta',
    approvalMode: { mode: approvalMode },
    activeTurnId: null,
    status: 'idle',
  };
}

/**
 * An agent message the way Muse draws one: the first chunk as an
 * `item/updated` snapshot, the rest as `item/delta`, then the whole text again
 * on `item/completed`. The driver has to write each character exactly once.
 */
function say(turnId: string, text: string): void {
  const itemId = nextItemId();
  const chunks = chunksOf(text);
  notify('item/started', { item: { itemId, kind: 'agentMessage', turnId, revision: 1, status: 'inProgress', text: '' } });
  let sent = '';
  chunks.forEach((chunk, index) => {
    sent += chunk;
    if (index === 0) {
      notify('item/updated', {
        item: { itemId, kind: 'agentMessage', turnId, revision: 2, status: 'inProgress', text: sent },
      });
    } else {
      notify('item/delta', { itemId, delta: chunk, field: 'text' });
    }
  });
  notify('item/completed', {
    item: { itemId, kind: 'agentMessage', turnId, revision: 3 + chunks.length, status: 'completed', text },
  });
}

function toolItem(itemId: string, turnId: string, revision: number, status: string, output?: string): unknown {
  return {
    itemId,
    kind: 'toolCall',
    turnId,
    revision,
    status,
    tool: 'shell',
    args: JSON.stringify({ command: 'echo hello' }),
    commandText: 'echo hello',
    ...(output === undefined ? {} : { visibleOutput: output }),
  };
}

const CHOICES = [
  { choiceId: 'c-session', decision: 'approvedForSession', label: 'Allow for this session', scope: 'session' },
  { choiceId: 'c-once', decision: 'approved', label: 'Allow once', scope: 'once' },
  { choiceId: 'c-deny', decision: 'denied', label: 'Deny', scope: 'once' },
  { choiceId: 'c-abort', decision: 'abort', label: 'Stop' },
];

/** One approval stage, answered by `approval/decide`; resolves to the choice the client sent. */
function askApproval(turnId: string, approvalId: string, subject: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolve) => {
    waitingApproval.set(approvalId, resolve);
    notify('approval/requested', {
      turnId,
      approvalId,
      toolName: subject['kind'] === 'shell' ? 'shell' : 'write_file',
      rawArgs: JSON.stringify(subject),
      protectedWrite: false,
      judgeEscalated: false,
      currentRequirementId: { approvalId, sourceIndex: 0 },
      availableChoices: CHOICES,
      subject,
    });
  });
}

function awaitInterrupt(turnId: string): Promise<void> {
  if (interrupted.has(turnId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waitingInterrupt.set(turnId, resolve);
  });
}

async function runTurn(turnId: string, text: string): Promise<void> {
  turnsRun += 1;
  notify('turn/started', { turnId });
  const directives = directivesOf(text);

  if (directives.includes('thought')) {
    const itemId = nextItemId();
    notify('item/started', { item: { itemId, kind: 'reasoning', turnId, revision: 1, status: 'inProgress', text: '' } });
    notify('item/delta', { itemId, delta: 'thinking about it', field: 'text' });
    notify('item/completed', {
      item: { itemId, kind: 'reasoning', turnId, revision: 2, status: 'completed', text: 'thinking about it' },
    });
  }

  say(turnId, plainOf(text));

  let usage: Record<string, number> | undefined;
  for (const directive of directives) {
    switch (directive) {
      case 'command': {
        const itemId = nextItemId();
        notify('item/started', { item: toolItem(itemId, turnId, 1, 'inProgress') });
        notify('item/completed', { item: toolItem(itemId, turnId, 2, 'completed', 'ok') });
        break;
      }
      case 'approve': {
        const itemId = nextItemId();
        notify('item/started', { item: toolItem(itemId, turnId, 1, 'inProgress') });
        const approvalId = `ap-${itemId}`;
        const choice = await askApproval(turnId, approvalId, { kind: 'shell', command: 'echo hello' });
        const allowed = choice === 'c-once' || choice === 'c-session';
        notify('approval/resolved', { approvalId, decision: allowed ? 'approved' : 'denied' });
        notify('item/completed', {
          item: toolItem(itemId, turnId, 2, allowed ? 'completed' : 'rejected', allowed ? 'ok' : undefined),
        });
        say(turnId, allowed ? 'allowed' : 'denied');
        break;
      }
      case 'edit':
      case 'edit-out':
      case 'edit-link': {
        const approvalId = `ap-${nextItemId()}`;
        const path = directive === 'edit' ? 'notes.md' : directive === 'edit-out' ? '../outside.md' : 'out-link/notes.md';
        const choice = await askApproval(turnId, approvalId, { kind: 'fileAccess', access: 'write', path });
        const allowed = choice === 'c-once' || choice === 'c-session';
        notify('approval/resolved', { approvalId, decision: allowed ? 'approved' : 'denied' });
        say(turnId, allowed ? 'wrote' : 'kept');
        break;
      }
      case 'input': {
        const userInputId = `ui-${nextItemId()}`;
        const answers = await new Promise<unknown[] | null>((resolve) => {
          waitingInput.set(userInputId, resolve);
          notify('userInput/requested', {
            turnId,
            userInputId,
            questions: [
              {
                id: 'q1',
                header: 'Pick',
                question: 'which one?',
                options: [{ label: 'Red' }, { label: 'Blue', description: 'the calm one' }],
                selection: { mode: 'single' },
              },
            ],
          });
        });
        notify('userInput/settled', { userInputId, outcome: answers === null ? 'cancelled' : 'answered' });
        const first = (answers?.[0] ?? {}) as { selectedLabel?: string; freeText?: string };
        say(turnId, answers === null ? 'input refused' : `input answered ${first.selectedLabel ?? first.freeText ?? ''}`);
        break;
      }
      case 'tasks':
        notify('session/todoListChanged', {
          items: [
            { text: 'Inspect source', status: 'completed' },
            { text: 'Run checks', status: 'inProgress' },
            { text: 'Dropped idea', status: 'cancelled' },
          ],
        });
        break;
      case 'usage':
        usage = { inputTokens: 8, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 };
        notify('session/contextUsage', { usedTokens: 90, windowTokens: 200000 });
        break;
      case 'server-request': {
        const id = nextServerId;
        nextServerId += 1;
        // The turn waits for the client's answer, so the process is still here to log it.
        const refused = await new Promise<boolean>((resolve) => {
          pendingServer.set(id, resolve);
          send({ id, method: 'approval/request', params: { sessionId, approvalId: 'ap-request' } });
        });
        log(`approval/request ${refused ? 'refused' : 'answered'}`);
        break;
      }
      case 'slow':
        await awaitInterrupt(turnId);
        waitingInterrupt.delete(turnId);
        interrupted.delete(turnId);
        notify('turn/completed', { turnId, terminal: 'cancelled', reason: 'interrupted' });
        return;
      case 'crash':
        process.stderr.write('boom\n');
        setTimeout(() => {
          process.exit(3);
        }, 20);
        await new Promise<void>(() => undefined);
        break;
      case 'auth':
        notify('turn/completed', {
          turnId,
          terminal: 'failed',
          error: { kind: 'authRequired', message: 'run muse login', retryable: false },
        });
        return;
      case 'thought':
      case 'close-idle':
        break;
    }
  }

  notify('turn/completed', { turnId, terminal: 'completed', ...(usage === undefined ? {} : { usage }) });
  if (directives.includes('close-idle')) {
    // The host's idle policy unloads the session once the turn is over.
    closed = true;
    setTimeout(() => {
      notify('session/closed', { reason: 'idle' });
    }, 50);
  }
}

const MODELS = [
  { modelId: 'muse-spark-1.3', displayLabel: 'muse-spark-1.3', isDefault: true, providerId: 'meta', profileId: 'fake-profile', contextLimit: 200000 },
  { modelId: 'muse-fake-fast', displayLabel: 'Muse Fake Fast', isDefault: false, providerId: 'meta', profileId: 'fake-profile', contextLimit: 100000 },
  { modelId: 'someone-else', displayLabel: 'Not Meta', isDefault: false, providerId: 'other', profileId: null, contextLimit: 1 },
];

function handle(method: string, raw: unknown): unknown {
  const params = (raw ?? {}) as Record<string, unknown>;
  const commandId = textOf(params['commandId']);
  switch (method) {
    case 'initialize': {
      const client = (params['clientInfo'] ?? {}) as Record<string, unknown>;
      const capabilities = (params['capabilities'] ?? {}) as Record<string, unknown>;
      log(`initialize client=${textOf(client['name'])} dialogs=${String(capabilities['userInputDialogs'])} flags=${FLAGS}`);
      const version = Number(process.env['MUSE_FAKE_SCHEMA'] ?? '1');
      return {
        museHome: process.env['MUSE_FAKE_HOME'] ?? process.cwd(),
        schema: { version, fingerprint: 'sha256:fake' },
        serverInfo: { name: 'muse-fake', version: '0.0.0' },
        sessionDurability: 'durable',
      };
    }
    case 'model/list':
      log('model/list');
      return { providerId: 'meta', profileId: 'fake-profile', source: 'providerCatalog', models: MODELS };
    case 'session/start': {
      sessionId = textOf(params['sessionId']);
      approvalMode = textOf(params['approvalMode']);
      if (typeof params['modelId'] === 'string') modelId = params['modelId'];
      log(
        `session/start uuid=${UUID_V7.test(sessionId) && UUID_V7.test(commandId)} approvalMode=${approvalMode} model=${textOf(params['modelId'])} provider=${textOf(params['providerId'])}`,
      );
      return { session: sessionRecord(), viewCursor: 0 };
    }
    case 'session/resume': {
      sessionId = textOf(params['sessionId']);
      log(`session/resume ${sessionId} excludeItems=${String(params['excludeItems'])}`);
      closed = false;
      // A resumed session has a history of its own, which this process did not run.
      turnsRun = Math.max(turnsRun, 1);
      return { session: sessionRecord(), viewCursor: 0 };
    }
    case 'session/setModel': {
      const model = (params['model'] ?? {}) as Record<string, unknown>;
      modelId = textOf(model['modelId']);
      log(`session/setModel ${modelId} provider=${textOf(model['providerId'])}`);
      setTimeout(() => {
        notify('session/modelChanged', { modelId });
      }, 0);
      return { session: sessionRecord() };
    }
    case 'session/setApprovalMode':
      approvalMode = textOf(params['mode']);
      log(`session/setApprovalMode ${approvalMode}`);
      return { session: sessionRecord() };
    case 'turn/start': {
      const effort = textOf(params['reasoningEffort']);
      const input = Array.isArray(params['input']) ? (params['input'] as Record<string, unknown>[]) : [];
      const text = input.map((part) => textOf(part['text'])).join('');
      log(`turn/start uuid=${UUID_V7.test(commandId)} effort=${effort} display=${textOf(params['displayText']) === text}`);
      if (closed) throw new Error('the session is closed');
      for (const part of input) {
        if (part['type'] === 'image') log(`image ${textOf(part['mediaType'])} ${textOf(part['base64Data'])}`);
      }
      // A fresh turn's id is its commandId, and the turn streams after the ack.
      setTimeout(() => {
        void runTurn(commandId, text);
      }, 0);
      return { turnId: commandId, disposition: 'started', status: 'running' };
    }
    case 'turn/interrupt': {
      const turnId = textOf(params['turnId']);
      log(`turn/interrupt ${turnId === '' ? 'none' : 'turn'}`);
      const waiter = waitingInterrupt.get(turnId);
      if (waiter === undefined) interrupted.add(turnId);
      else waiter();
      return { accepted: true };
    }
    case 'approval/decide': {
      const approvalId = textOf(params['approvalId']);
      const requirement = (params['requirementId'] ?? {}) as Record<string, unknown>;
      log(`approval/decide ${textOf(params['choiceId'])} stage=${String(requirement['sourceIndex'])}`);
      const waiter = waitingApproval.get(approvalId);
      waitingApproval.delete(approvalId);
      setTimeout(() => {
        waiter?.(textOf(params['choiceId']));
      }, 0);
      return { accepted: true };
    }
    case 'userInput/answer': {
      const userInputId = textOf(params['userInputId']);
      const answers = Array.isArray(params['answers']) ? (params['answers'] as unknown[]) : [];
      log(`userInput/answer ${JSON.stringify(answers)}`);
      const waiter = waitingInput.get(userInputId);
      waitingInput.delete(userInputId);
      setTimeout(() => {
        waiter?.(answers);
      }, 0);
      return { accepted: true };
    }
    case 'userInput/cancel': {
      const userInputId = textOf(params['userInputId']);
      log('userInput/cancel');
      const waiter = waitingInput.get(userInputId);
      waitingInput.delete(userInputId);
      setTimeout(() => {
        waiter?.(null);
      }, 0);
      return { accepted: true };
    }
    case 'session/compact': {
      log('session/compact');
      if (turnsRun === 0) return { status: 'noop', reason: 'nothing to compact' };
      setTimeout(() => {
        const itemId = nextItemId();
        notify('item/started', { item: { itemId, kind: 'compaction', revision: 1, status: 'inProgress', trigger: 'manual' } });
        notify('item/completed', {
          item: {
            itemId,
            kind: 'compaction',
            revision: 2,
            status: 'completed',
            trigger: 'manual',
            outcome: 'completed',
            tokensBefore: 90000,
            tokensAfter: 32000,
          },
        });
        notify('session/contextUsage', { usedTokens: 32000, windowTokens: 200000 });
      }, 0);
      return { status: 'accepted' };
    }
    default:
      throw new Error(`the fake muse host does not implement ${method}`);
  }
}

/** Server requests this host sent, by id, each waiting for the client's answer: true when refused. */
const pendingServer = new Map<number, (refused: boolean) => void>();

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
    const stall = process.env['MUSE_FAKE_INIT'];
    if (method === 'initialize' && id !== undefined && id !== null && stall !== undefined) {
      // A stalled startup: logged, then answered late or never.
      const result = handle(method, message['params']);
      if (stall !== 'never') {
        setTimeout(() => {
          send({ id, result });
        }, Number(stall));
      }
      continue;
    }
    if (typeof method === 'string' && id !== undefined && id !== null) {
      try {
        send({ id, result: handle(method, message['params']) });
      } catch (error) {
        send({
          id,
          error: { code: -32601, message: (error as Error).message, data: { kind: 'unsupported', reason: 'fake' } },
        });
      }
      continue;
    }
    if (typeof method === 'string') {
      log(method);
      continue;
    }
    if (typeof id === 'number') {
      const waiter = pendingServer.get(id);
      pendingServer.delete(id);
      waiter?.(message['error'] !== undefined);
    }
  }
});
