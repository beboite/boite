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
 */
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  Usage,
} from '@agentclientprotocol/sdk';

const DIRECTIVE = /\[(tool|documents|big-image|permission|thought|usage|slow|refuse|crash)\]/g;
/** `[mode-switch <id>]`: the agent changes mode on its own before it answers. */
const MODE_SWITCH = /\[mode-switch ([\w-]+)\]/g;
const CHUNKS = 3;

type Directive =
  | 'tool'
  | 'documents'
  | 'big-image'
  | 'permission'
  | 'thought'
  | 'usage'
  | 'slow'
  | 'refuse'
  | 'crash';

/** What `[documents]` writes: a file the call changed, then a note and a picture. */
const DIFF_PATH = '/work/src/app.ts';
const DIFF_NEW = 'const answer = 42;\n';
/** A 1 by 1 PNG, base64 with no `data:` prefix, the way ACP carries an image block. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Over the core's 2 MB base64 cap, so `[big-image]` has to come back as a line of text. */
const HUGE_IMAGE = 'A'.repeat(2 * 1024 * 1024 + 512 * 1024);

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
let currentModeId = 'default';

function modeState(): SessionModeState | undefined {
  return noModes ? undefined : { currentModeId, availableModes: MODES };
}

/** The sessions this process handed out, so `session/load` can recognise one. */
const known = new Set<string>();
const cancels = new Map<string, () => void>();

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
  .onRequest('initialize', () => {
    log('initialize');
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'acp-fake', version: '1' },
    };
  })
  .onRequest('session/new', () => {
    const sessionId = `acp-fake-${Math.random().toString(16).slice(2, 10)}`;
    known.add(sessionId);
    return { sessionId, configOptions, modes: modeState() };
  })
  .onRequest('session/load', ({ params }) => {
    known.add(params.sessionId);
    log(`loaded:${params.sessionId}`);
    return { modes: modeState() };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    log(`set_config_option ${params.configId} ${String(params.value)}`);
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
    const send = (update: SessionUpdate): Promise<void> => client.notify('session/update', { sessionId, update });
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
        case 'permission': {
          const answer = await client.request('session/request_permission', {
            sessionId,
            toolCall: { toolCallId: 'fake-1', title: 'fake tool', name: 'fake_tool', rawInput: { echo: true } },
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
          // Already sent above, before the answer.
          break;
        case 'usage':
          await send({ sessionUpdate: 'usage_update', used: 12, size: 200, cost: { amount: 0.0042, currency: 'USD' } });
          usage = { totalTokens: 12, inputTokens: 8, outputTokens: 4, cachedReadTokens: 2 };
          break;
        case 'slow':
          await new Promise<void>((resolve) => {
            cancels.set(sessionId, resolve);
          });
          cancels.delete(sessionId);
          return { stopReason: 'cancelled' };
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

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
