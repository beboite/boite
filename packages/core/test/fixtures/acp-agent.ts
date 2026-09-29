/**
 * A fake ACP agent over stdio, the counterpart of the echo driver: it speaks
 * the real protocol through the SDK and obeys the same kind of prompt
 * directives, so the ACP client driver is proved without a real agent.
 *
 * Run as `bun <this file>`. `ACP_FAKE_LOG` names a file the agent appends what
 * a test needs to assert on: `initialize`, `loaded:<sessionId>`,
 * `set_config_option ...` and `set_mode ...`. One `initialize` line per
 * process, so a test can count the agent processes a probe cache did or did not
 * save.
 *
 * `ACP_FAKE_NO_MODES=1` makes it answer no `modes` at all, which is the agent
 * the mode mapping has to survive without sending anything.
 *
 * `ACP_FAKE_NO_IMAGES=1` makes `initialize` answer with no
 * `promptCapabilities.image`, which is the agent a driver must refuse to send
 * an attachment to. Otherwise the fake advertises image support, and every
 * `image` block a `session/prompt` carries is logged as
 * `image <mimeType> <byte length>`.
 *
 * The failure switches, one per way an agent lets a client down:
 * - `ACP_FAKE_HANG_INIT=1`: `initialize` is never answered.
 * - `ACP_FAKE_EXIT_AT_START=1`: one line on stderr, then exit 4 before any answer.
 * - `ACP_FAKE_FORGET=1`: `session/load` throws, as an agent that lost the
 *   session does; the SDK answers that as a JSON-RPC internal error.
 * - `ACP_FAKE_NO_LOAD=1`: `initialize` advertises no `loadSession`.
 * - `ACP_FAKE_LOAD_AUTH=1`: `session/load` answers -32000 authentication
 *   required, a refusal that says nothing about the session.
 * - `ACP_FAKE_LOAD_BROKEN=1`: `session/load` answers the internal error
 *   OpenCode answers for a session it cannot read, missing or not:
 *   -32603 "OpenCode service failure" with `{ service: 'session' }`.
 *
 * `usage_update.cost` is the session's running total, as the protocol defines
 * it: each `[usage]` adds 0.0042 to it. The total outlives the process, the way
 * OpenCode sums it from the session's stored messages: it is kept in
 * `<ACP_FAKE_LOG>.costs.json`. `ACP_FAKE_COST_PER_PROCESS=1` makes it the
 * agent that counts each process from zero instead.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  Usage,
} from '@agentclientprotocol/sdk';

const DIRECTIVE = /\[(tool|documents|big-image|huge-tool|permission|question|thought|usage|slow|deaf|refuse|crash|noise|big-glog)\]/g;
/** `[mode-switch <id>]`: the agent changes mode on its own before it answers. */
const MODE_SWITCH = /\[mode-switch ([\w-]+)\]/g;
const CHUNKS = 3;

type Directive =
  | 'tool'
  | 'documents'
  | 'big-image'
  | 'huge-tool'
  | 'permission'
  | 'question'
  | 'thought'
  | 'usage'
  | 'slow'
  | 'deaf'
  | 'refuse'
  | 'crash'
  | 'noise'
  | 'big-glog';

/** What `[huge-tool]` returns as output, as a text block and as a diff: 1 MB each. */
const HUGE_TEXT = 'y'.repeat(1024 * 1024);
/** What `[big-glog]` writes to stderr: one glog info line of 200 KB, in several writes. */
const BIG_GLOG = `I0925 12:00:00.000000 4242 main.py:80] ${'x'.repeat(200 * 1024)}\n`;

if (process.env['ACP_FAKE_EXIT_AT_START'] === '1') {
  // A signed-out or misconfigured agent: it says why on stderr and leaves.
  process.stderr.write('not signed in: run the CLI once\n', () => {
    process.exit(4);
  });
}

/**
 * What `[noise]` writes straight to stdout, in the middle of the protocol
 * stream: Antigravity's server prints its sign-in link exactly like this, so
 * the driver has to keep a line that is not JSON out of the parser.
 */
const NOISE_LINE = 'Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/fake';

/** What `[documents]` writes: a file the call changed, then a note and a picture. */
const DIFF_PATH = '/work/src/app.ts';
const DIFF_NEW = 'const answer = 42;\n';
/** A 1 by 1 PNG, base64 with no `data:` prefix, the way ACP carries an image block. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Over the core's 2 MB base64 cap, so `[big-image]` has to come back as a line of text. */
const HUGE_IMAGE = 'A'.repeat(2 * 1024 * 1024 + 512 * 1024);

/** What `session/new` reports right away, before any prompt: the between-turns path. */
const FAKE_COMMANDS: AvailableCommand[] = [
  { name: 'fake-report', description: 'Write a status report', input: { hint: '<summary>' } },
  { name: 'fake-ping', description: 'Answer pong' },
];

const configOptions: SessionConfigOption[] = [
  {
    type: 'select',
    id: 'model',
    category: 'model',
    name: 'Model',
    currentValue: 'fake-fast',
    options: [
      // `default` is offered on purpose: the client must still send nothing for
      // it, so the log proves the driver skipped the call rather than failed it.
      { value: 'default', name: 'Agent default' },
      { value: 'fake-fast', name: 'Fast' },
      { value: 'fake-smart', name: 'Smart' },
    ],
  },
  {
    type: 'select',
    id: 'thought_level',
    category: 'thought_level',
    name: 'Thinking',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];

/**
 * Ids spelled the three ways real agents spell them: one that matches a Boite
 * mode exactly, one in snake_case, and one that shares no letter with it.
 */
const MODES: SessionMode[] = [
  { id: 'default', name: 'Default' },
  { id: 'accept_edits', name: 'Accept edits' },
  { id: 'yolo', name: 'YOLO' },
  { id: 'plan', name: 'Plan' },
];

/** An agent with no modes at all, so the driver's warning path has a subject. */
const noModes = process.env['ACP_FAKE_NO_MODES'] === '1';
/** An agent that never learned to read an image, so a driver has to refuse first. */
const noImages = process.env['ACP_FAKE_NO_IMAGES'] === '1';
let currentModeId = 'default';

function modeState(): SessionModeState | undefined {
  return noModes ? undefined : { currentModeId, availableModes: MODES };
}

/** An agent that cannot resume a session, so the client has to carry the history. */
const noLoad = process.env['ACP_FAKE_NO_LOAD'] === '1';
/** The sessions this process handed out, so `session/load` can recognise one. */
const known = new Set<string>();
const cancels = new Map<string, () => void>();
/** Each session's running cost in this process, for `ACP_FAKE_COST_PER_PROCESS=1`. */
const spent = new Map<string, number>();

/** Adds one `[usage]` to the session's running total and returns the total. */
function spend(sessionId: string): number {
  const file = process.env['ACP_FAKE_LOG'];
  if (process.env['ACP_FAKE_COST_PER_PROCESS'] === '1' || file === undefined || file.length === 0) {
    const total = (spent.get(sessionId) ?? 0) + 0.0042;
    spent.set(sessionId, total);
    return total;
  }
  const store = `${file}.costs.json`;
  const totals = existsSync(store) ? (JSON.parse(readFileSync(store, 'utf8')) as Record<string, number>) : {};
  const total = (totals[sessionId] ?? 0) + 0.0042;
  totals[sessionId] = total;
  writeFileSync(store, JSON.stringify(totals), 'utf8');
  return total;
}

function log(line: string): void {
  const file = process.env['ACP_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

function promptText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
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
  return text.replace(DIRECTIVE, '').replace(MODE_SWITCH, '');
}

function modeSwitchIn(text: string): string | null {
  MODE_SWITCH.lastIndex = 0;
  return MODE_SWITCH.exec(text)?.[1] ?? null;
}

function chunksOf(text: string): string[] {
  const size = Math.ceil(text.length / CHUNKS);
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

const app = agent({ name: 'acp-fake' })
  .onRequest('initialize', async () => {
    log('initialize');
    if (process.env['ACP_FAKE_HANG_INIT'] === '1') await new Promise<void>(() => undefined);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: !noLoad,
        ...(noImages ? {} : { promptCapabilities: { image: true } }),
      },
      agentInfo: { name: 'acp-fake', version: '1' },
    };
  })
  .onRequest('session/new', async ({ client }) => {
    const sessionId = `acp-fake-${crypto.randomUUID().slice(0, 8)}`;
    known.add(sessionId);
    log(`new:${sessionId}`);
    // Before any prompt: the between-turns path a driver must not drop.
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: FAKE_COMMANDS },
    });
    return { sessionId, configOptions, modes: modeState() };
  })
  .onRequest('session/load', ({ params }) => {
    if (process.env['ACP_FAKE_FORGET'] === '1') {
      log(`load-refused:${params.sessionId}`);
      // A plain throw, like OpenCode's: the SDK answers it with -32603.
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (process.env['ACP_FAKE_LOAD_AUTH'] === '1') {
      log(`load-auth:${params.sessionId}`);
      throw RequestError.authRequired({}, 'sign in again');
    }
    if (process.env['ACP_FAKE_LOAD_BROKEN'] === '1') {
      log(`load-broken:${params.sessionId}`);
      throw RequestError.internalError({ service: 'session' }, 'OpenCode service failure');
    }
    known.add(params.sessionId);
    log(`loaded:${params.sessionId}`);
    // A conforming load may omit configOptions. The probe still supplied them.
    return { modes: modeState() };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    log(`set_config_option ${params.configId} ${String(params.value)}`);
    // Like OpenCode, the smart model names its own scale once a session is on it.
    if (params.configId === 'model' && params.value === 'fake-smart') {
      return {
        configOptions: configOptions.map((option) =>
          option.id === 'model'
            ? { ...option, currentValue: 'fake-smart' }
            : {
                ...option,
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'high', name: 'High' },
                  { value: 'max', name: 'Max' },
                ],
              },
        ) as SessionConfigOption[],
      };
    }
    return { configOptions };
  })
  .onRequest('session/set_mode', ({ params }) => {
    // A mode nobody listed is refused, so a wrong mapping fails loudly instead
    // of passing as a call that went out.
    if (!MODES.some((mode) => mode.id === params.modeId)) {
      log(`set_mode:refused ${params.modeId}`);
      throw RequestError.invalidParams({ modeId: params.modeId }, `unknown mode ${params.modeId}`);
    }
    currentModeId = params.modeId;
    log(`set_mode ${params.modeId}`);
    return {};
  })
  .onNotification('session/cancel', ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const sessionId = params.sessionId;
    const text = promptText(params.prompt);
    for (const block of params.prompt) {
      if (block.type === 'image') log(`image ${block.mimeType} ${block.data.length}`);
    }
    const send = (update: SessionUpdate): Promise<void> => client.notify('session/update', { sessionId, update });
    if (text.includes('[tasks]')) await send({ sessionUpdate: 'plan', entries: [{ content: 'Inspect source', priority: 'medium', status: 'completed' }, { content: 'Run checks', priority: 'medium', status: 'in_progress' }] });
    const say = (chunk: string): Promise<void> =>
      send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });

    // The agent switching on its own, before anything else it says.
    const switched = modeSwitchIn(text);
    if (switched !== null) {
      currentModeId = switched;
      await send({ sessionUpdate: 'current_mode_update', currentModeId: switched });
    }

    const directives = directivesOf(text);
    // A real agent reasons before it answers, so the thought chunks go first.
    for (const directive of directives) {
      if (directive !== 'thought') continue;
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } });
    }
    // The line that is not JSON, before the answer, so the turn has to survive it.
    for (const directive of directives) {
      if (directive !== 'noise') continue;
      process.stdout.write(`${NOISE_LINE}\n`);
    }

    const plain = plainOf(text);
    for (const chunk of chunksOf(plain)) await say(chunk);

    let usage: Usage | null = null;
    for (const directive of directives) {
      switch (directive) {
        case 'tool':
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: 'fake-1',
            title: 'fake tool',
            name: 'fake_tool',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { echo: true },
          });
          await send({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'fake-1',
            status: 'completed',
            rawOutput: 'ok',
          });
          break;
        case 'documents':
          // A file the call wrote, with no `oldText`: a new file.
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: 'fake-diff',
            title: 'write a file',
            name: 'write_file',
            kind: 'edit',
            status: 'in_progress',
            rawInput: { path: DIFF_PATH },
            content: [{ type: 'diff', path: DIFF_PATH, newText: DIFF_NEW }],
          });
          // No `content` on the update: the documents already sent must stand.
          await send({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'fake-diff',
            status: 'completed',
            rawOutput: 'written',
          });
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: 'fake-shot',
            title: 'take a shot',
            name: 'screenshot',
            kind: 'other',
            status: 'completed',
            rawInput: { region: 'window' },
            rawOutput: 'captured',
            content: [
              { type: 'content', content: { type: 'text', text: '# the note\nwhat the tool saw' } },
              { type: 'content', content: { type: 'image', data: TINY_PNG, mimeType: 'image/png' } },
            ],
          });
          break;
        case 'big-image':
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: 'fake-huge',
            title: 'take a huge shot',
            name: 'screenshot',
            kind: 'other',
            status: 'completed',
            rawInput: { region: 'screen' },
            content: [{ type: 'content', content: { type: 'image', data: HUGE_IMAGE, mimeType: 'image/png' } }],
          });
          break;
        case 'question':
        case 'permission': {
          const answer = await client.request('session/request_permission', {
            sessionId,
            toolCall: { toolCallId: directive === 'question' ? 'interaction_1' : 'fake-1', title: 'fake tool', name: 'fake_tool', rawInput: { echo: true } },
            options: [
              { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
            ],
          });
          const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes';
          await say(allowed ? 'allowed' : 'denied');
          break;
        }
        case 'thought':
        case 'noise':
          // Already sent above, before the answer.
          break;
        case 'usage': {
          const total = spend(sessionId);
          await send({ sessionUpdate: 'usage_update', used: 12, size: 200, cost: { amount: total, currency: 'USD' } });
          usage = { totalTokens: 12, inputTokens: 8, outputTokens: 4, cachedReadTokens: 2 };
          break;
        }
        case 'huge-tool':
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: 'fake-huge-tool',
            title: 'read a huge file',
            name: 'read_file',
            kind: 'read',
            status: 'completed',
            rawInput: { path: DIFF_PATH },
            rawOutput: HUGE_TEXT,
            content: [
              { type: 'content', content: { type: 'text', text: HUGE_TEXT } },
              { type: 'diff', path: DIFF_PATH, oldText: HUGE_TEXT, newText: `${HUGE_TEXT}!` },
            ],
          });
          break;
        case 'big-glog':
          // Split across writes, so the line crosses several pipe reads.
          for (let at = 0; at < BIG_GLOG.length; at += 50 * 1024) {
            process.stderr.write(BIG_GLOG.slice(at, at + 50 * 1024));
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          break;
        case 'slow':
          await new Promise<void>((resolve) => {
            cancels.set(sessionId, resolve);
          });
          cancels.delete(sessionId);
          return { stopReason: 'cancelled' };
        case 'deaf':
          // An agent that ignores `session/cancel`: the prompt never ends.
          log('deaf');
          await new Promise<void>(() => undefined);
          break;
        case 'refuse':
          return { stopReason: 'refusal' };
        case 'crash':
          process.stderr.write('boom\n');
          setTimeout(() => {
            process.exit(3);
          }, 20);
          // The exit is what the client sees; this promise never settles.
          await new Promise<void>(() => undefined);
          break;
      }
    }

    return usage === null ? { stopReason: 'end_turn' } : { stopReason: 'end_turn', usage };
  });

if (process.env['ACP_FAKE_EXIT_AT_START'] !== '1') {
  app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
}
