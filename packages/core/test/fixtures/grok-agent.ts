/**
 * A fake of Grok CLI's ACP agent, cut to the dialect Boite drives. It answers
 * the way `grok agent stdio` 1.0.13 does: `initialize` carries `loadSession`
 * and the two auth methods, `session/new` carries `models.availableModels` with
 * a per-model `_meta.reasoningEfforts` and no `modes` and no `configOptions`,
 * `session/set_config_option` does not exist at all, and two notifications of
 * xAI's own (`_x.ai/mcp/servers_updated`, `_x.ai/models/update`) go out right
 * after each of them, which the client has to ignore in silence.
 *
 * The model and the reasoning effort arrive as one `session/set_model`, the
 * permission mode on the command line, so this fixture logs both its own argv
 * and every model call it is sent.
 *
 * Run as `bun <this file> <the descriptor's launch args>`. `GROK_FAKE_LOG`
 * names a file it appends to: `argv:<the args>`, `env <NAME>=<value>`,
 * `initialize`, `loaded:<sessionId>`, `set_model <modelId> <effort>` and
 * `set_config_option ...`, which must never appear. One `initialize` line per
 * process, so a test can count the processes a probe cache did or did not save.
 */
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';

/** The variables a test asserts on: the isolation and the two the profile fixes. */
const WATCHED = ['GROK_HOME', 'NO_COLOR', 'GROK_FEEDBACK_ENABLED', 'XAI_API_KEY'];

/** What `grok agent stdio` answers, `availableModels` and their efforts verbatim. */
const MODELS = {
  currentModelId: 'grok-4.6',
  availableModels: [
    {
      modelId: 'grok-4.6',
      name: 'Grok 4.6',
      description: 'The frontier model',
      _meta: {
        totalContextTokens: 500000,
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: [
          { id: 'xhigh', value: 'xhigh', label: 'Extra High Effort', description: 'Highest effort', default: false },
          { id: 'high', value: 'high', label: 'High Effort', description: 'Extensive reasoning', default: true },
          { id: 'medium', value: 'medium', label: 'Medium Effort', description: 'Balanced', default: false },
          { id: 'low', value: 'low', label: 'Low Effort', description: 'Quick', default: false },
        ],
      },
    },
    {
      modelId: 'grok-4.5',
      name: 'Grok 4.5',
      _meta: {
        totalContextTokens: 500000,
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: [
          { id: 'high', value: 'high', label: 'High Effort', default: true },
          { id: 'medium', value: 'medium', label: 'Medium Effort', default: false },
          { id: 'low', value: 'low', label: 'Low Effort', default: false },
        ],
      },
    },
  ],
};

const known = new Set<string>();
const cancels = new Map<string, () => void>();

function log(line: string): void {
  const file = process.env['GROK_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

/**
 * A notification of xAI's own, written straight onto the wire: the SDK's typed
 * `notify` only knows the protocol's methods, and the point of these two is
 * that the client meets a method it has never heard of.
 */
function xaiNotification(method: string, params: Record<string, unknown>): void {
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }, 0);
}

function promptText(blocks: ContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

log(`argv:${process.argv.slice(2).join(' ')}`);
for (const name of WATCHED) log(`env ${name}=${process.env[name] ?? ''}`);

const app = agent({ name: 'grok-fake' })
  .onRequest('initialize', () => {
    log('initialize');
    xaiNotification('_x.ai/mcp/servers_updated', { servers: [] });
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      agentInfo: { name: 'grok', version: '1.0.13' },
      authMethods: [
        { id: 'cached_token', name: 'cached_token', description: 'Cached token from ~/.grok/auth.json' },
        { id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' },
      ],
      _meta: { grokShell: true, defaultAuthMethodId: 'cached_token' },
    };
  })
  // No `modes` and no `configOptions`, exactly like the real agent: the models
  // and their effort scales are all it answers with.
  .onRequest('session/new', () => {
    const sessionId = `grok-fake-${Math.random().toString(16).slice(2, 10)}`;
    known.add(sessionId);
    xaiNotification('_x.ai/models/update', { models: MODELS });
    return { sessionId, models: MODELS, _meta: { isGitRepo: false } } as unknown as { sessionId: string };
  })
  .onRequest('session/load', ({ params }) => {
    known.add(params.sessionId);
    log(`loaded:${params.sessionId}`);
    return {};
  })
  // The real agent has no such method; this one exists only to record the call
  // a driver should never make.
  .onRequest('session/set_config_option', ({ params }) => {
    log(`set_config_option ${params.configId} ${String(params.value)}`);
    return { configOptions: [] };
  })
  // How the model and the reasoning effort are chosen. The SDK's typed methods
  // stop at the protocol's own, so the params are parsed here.
  .onRequest(
    'session/set_model',
    (params: unknown) => params as { sessionId: string; modelId: string; _meta?: { reasoningEffort?: string } },
    ({ params }) => {
      log(`set_model ${params.modelId} ${params._meta?.reasoningEffort ?? ''}`.trimEnd());
      return {};
    },
  )
  .onNotification('session/cancel', ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const sessionId = params.sessionId;
    const text = promptText(params.prompt);
    const send = (update: SessionUpdate): Promise<void> => client.notify('session/update', { sessionId, update });

    await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weighing it up' } });

    if (text.includes('[slow]')) {
      await new Promise<void>((resolve) => {
        cancels.set(sessionId, resolve);
      });
      cancels.delete(sessionId);
      return { stopReason: 'cancelled' };
    }

    if (text.includes('[permission]')) {
      await send({
        sessionUpdate: 'tool_call',
        toolCallId: 'grok-1',
        title: 'run a command',
        name: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      });
      const answer = await client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'grok-1', title: 'run a command', name: 'bash', rawInput: { command: 'ls' } },
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes';
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'grok-1',
        status: allowed ? 'completed' : 'failed',
        rawOutput: allowed ? 'ran' : 'refused',
      });
      await send({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: allowed ? 'allowed' : 'denied' },
      });
      return { stopReason: 'end_turn' };
    }

    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    return { stopReason: 'end_turn' };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
