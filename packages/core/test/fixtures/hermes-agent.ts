/**
 * A fake of Hermes Agent's ACP adapter, cut to the dialect Boite drives. It
 * answers the way `hermes acp` 0.21.5 does: `initialize` carries `loadSession`,
 * image prompts and one terminal auth method; `session/new` and `session/load`
 * answer `models` (ids `provider:model`) and three `modes` (`default`,
 * `accept_edits`, `dont_ask`) and no `configOptions`; `session/set_config_option`
 * keeps whatever it is sent and changes nothing, so the model only moves
 * through `session/set_model`. A `session/load` of an id it does not have
 * answers an empty result, not an error, and a prompt on such an id stops
 * with `refusal`.
 *
 * Sessions outlive the process in `<HERMES_HOME>/sessions.json`, the way
 * Hermes keeps them in its `state.db`, so a cold turn can load one.
 *
 * Run as `bun <this file> <the descriptor's launch args>`. `HERMES_FAKE_LOG`
 * names a file it appends to: `argv:<the args>`, `env <NAME>=<value>`,
 * `initialize`, `new:<sessionId>`, `loaded:<sessionId>`, `load-missing:<id>`,
 * `set_model <modelId>`, `set_mode <modeId>`, `set_config_option <id> <value>`,
 * `prompt <sessionId> <model> <mode>` and `image <mimeType>`.
 * `HERMES_FAKE_FORGET=1` makes it a Hermes whose `state.db` lost every session.
 * `HERMES_FAKE_LOAD_BARE=1` makes its `session/load` answer the modes alone.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';

/** The variables a test asserts on: the isolation and what the profile unsets. */
const WATCHED = ['HERMES_HOME', 'NO_COLOR', 'OPENAI_API_KEY', 'HERMES_TUI_GATEWAY_URL'];

const AVAILABLE = [
  { modelId: 'custom:qwen2.5:0.5b', name: 'qwen2.5:0.5b', description: 'Provider: Custom endpoint • current' },
  { modelId: 'custom:llama3.2:1b', name: 'llama3.2:1b', description: 'Provider: Custom endpoint' },
];

const MODES = [
  { id: 'default', name: 'Default', description: 'Ask before editing files' },
  { id: 'accept_edits', name: 'Accept edits', description: 'Allow edits inside the workspace for this session' },
  { id: 'dont_ask', name: "Don't ask", description: 'Allow edits for this session, except sensitive paths' },
];

interface Stored {
  model: string;
  mode: string;
}

const home = process.env['HERMES_HOME'] ?? '';
const store = join(home, 'sessions.json');
const cancels = new Map<string, () => void>();

function log(line: string): void {
  const file = process.env['HERMES_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

// The sessions earlier processes kept are gone; the ones this one opens are not.
if (process.env['HERMES_FAKE_FORGET'] === '1' && existsSync(store)) writeFileSync(store, '{}', 'utf8');

function sessions(): Record<string, Stored> {
  if (!existsSync(store)) return {};
  return JSON.parse(readFileSync(store, 'utf8')) as Record<string, Stored>;
}

function save(sessionId: string, state: Stored): void {
  writeFileSync(store, JSON.stringify({ ...sessions(), [sessionId]: state }), 'utf8');
}

function answer(state: Stored): Record<string, unknown> {
  return {
    models: { currentModelId: state.model, availableModels: AVAILABLE },
    modes: { currentModeId: state.mode, availableModes: MODES },
  };
}

function promptText(blocks: ContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

log(`argv:${process.argv.slice(2).join(' ')}`);
for (const name of WATCHED) log(`env ${name}=${process.env[name] ?? ''}`);

const app = agent({ name: 'hermes-fake' })
  .onRequest('initialize', () => {
    log('initialize');
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { fork: {}, list: {}, resume: {} },
      },
      agentInfo: { name: 'hermes-agent', version: '0.21.5' },
      authMethods: [
        { id: 'hermes-setup', name: 'Configure Hermes provider', description: 'Open the model setup in a terminal', type: 'terminal', args: ['--setup'] },
      ],
    } as never;
  })
  .onRequest('session/new', () => {
    const sessionId = crypto.randomUUID();
    const state = { model: AVAILABLE[0]!.modelId, mode: 'default' };
    save(sessionId, state);
    log(`new:${sessionId}`);
    return { sessionId, ...answer(state) } as never;
  })
  .onRequest('session/load', async ({ params, client }) => {
    const state = sessions()[params.sessionId];
    if (state === undefined) {
      log(`load-missing:${params.sessionId}`);
      // The adapter returns None, which the Python SDK sends as `{}`.
      return {} as never;
    }
    // The history replay a load streams before it answers.
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed question' } },
    });
    log(`loaded:${params.sessionId}`);
    if (process.env['HERMES_FAKE_LOAD_BARE'] === '1') return { modes: answer(state)['modes'] } as never;
    return answer(state) as never;
  })
  .onRequest('session/set_config_option', ({ params }) => {
    log(`set_config_option ${params.configId} ${String(params.value)}`);
    return { configOptions: [] };
  })
  .onRequest(
    'session/set_model',
    (params: unknown) => params as { sessionId: string; modelId: string },
    ({ params }) => {
      const state = sessions()[params.sessionId];
      if (state === undefined) throw RequestError.invalidParams({ details: 'unknown session' });
      if (!AVAILABLE.some((model) => model.modelId === params.modelId)) {
        throw RequestError.invalidParams({ details: `model ${params.modelId} is not configured` });
      }
      log(`set_model ${params.modelId}`);
      save(params.sessionId, { ...state, model: params.modelId });
      return {};
    },
  )
  .onRequest('session/set_mode', ({ params }) => {
    const state = sessions()[params.sessionId];
    // Hermes takes an unknown mode id as `default`.
    const mode = MODES.some((entry) => entry.id === params.modeId) ? params.modeId : 'default';
    log(`set_mode ${mode}`);
    if (state !== undefined) save(params.sessionId, { ...state, mode });
    return {};
  })
  .onNotification('session/cancel', ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const sessionId = params.sessionId;
    const state = sessions()[sessionId];
    if (state === undefined) return { stopReason: 'refusal' };
    log(`prompt ${sessionId} ${state.model} ${state.mode}`);
    for (const block of params.prompt) if (block.type === 'image') log(`image ${block.mimeType}`);
    const text = promptText(params.prompt);
    const send = (update: SessionUpdate): Promise<void> => client.notify('session/update', { sessionId, update });

    if (text.includes('[slow]')) {
      await new Promise<void>((resolve) => cancels.set(sessionId, resolve));
      cancels.delete(sessionId);
      return { stopReason: 'cancelled' };
    }

    if (text.includes('[permission]')) {
      // Hermes asks on a tool call of its own, `perm-check-<n>`, with five options.
      const toolCallId = 'perm-check-1';
      const answered = await client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId, title: 'Edit notes.md', kind: 'edit', status: 'pending', rawInput: { path: 'notes.md' } },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
          { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          { optionId: 'deny_always', name: 'Deny always', kind: 'reject_always' },
        ],
      });
      const chosen = answered.outcome.outcome === 'selected' ? answered.outcome.optionId : 'cancelled';
      log(`permission ${chosen}`);
      const allowed = chosen === 'allow_once' || chosen === 'allow_session' || chosen === 'allow_always';
      await send({ sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'allowed' : 'denied' } });
      return { stopReason: 'end_turn' };
    }

    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    await send({ sessionUpdate: 'usage_update', used: 1200, size: 32768 } as SessionUpdate);
    return { stopReason: 'end_turn' };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
