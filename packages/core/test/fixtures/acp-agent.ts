/**
 * A fake ACP agent over stdio, the counterpart of the echo driver: it speaks
 * the real protocol through the SDK and obeys the same kind of prompt
 * directives, so the ACP client driver is proved without a real agent.
 *
 * Run as `bun <this file>`. `ACP_FAKE_LOG` names a file the agent appends what
 * a test needs to assert on: `loaded:<sessionId>` and `set_config_option ...`.
 */
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ContentBlock, SessionConfigOption, SessionUpdate, Usage } from '@agentclientprotocol/sdk';

const DIRECTIVE = /\[(tool|permission|thought|usage|slow|refuse|crash)\]/g;
const CHUNKS = 3;

type Directive = 'tool' | 'permission' | 'thought' | 'usage' | 'slow' | 'refuse' | 'crash';

const configOptions: SessionConfigOption[] = [
  {
    type: 'select',
    id: 'model',
    category: 'model',
    name: 'Model',
    currentValue: 'fake-fast',
    options: [
      { value: 'fake-fast', name: 'Fast' },
      { value: 'fake-smart', name: 'Smart' },
    ],
  },
];

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
  return text.replace(DIRECTIVE, '');
}

function chunksOf(text: string): string[] {
  const size = Math.ceil(text.length / CHUNKS);
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

const app = agent({ name: 'acp-fake' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: 'acp-fake', version: '1' },
  }))
  .onRequest('session/new', () => {
    const sessionId = `acp-fake-${Math.random().toString(16).slice(2, 10)}`;
    known.add(sessionId);
    return { sessionId, configOptions };
  })
  .onRequest('session/load', ({ params }) => {
    known.add(params.sessionId);
    log(`loaded:${params.sessionId}`);
    return {};
  })
  .onRequest('session/set_config_option', ({ params }) => {
    log(`set_config_option ${params.configId} ${String(params.value)}`);
    return { configOptions };
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

    const plain = plainOf(text);
    for (const chunk of chunksOf(plain)) await say(chunk);

    let usage: Usage | null = null;
    for (const directive of directivesOf(text)) {
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
          await send({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking about it' },
          });
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
