/**
 * A fake of Antigravity's ACP server, cut to the half Boite's login drives: it
 * offers one `oauth-personal` auth method, prints its sign-in link on stdout as
 * a line that is not JSON (the real server does exactly that, which is why the
 * driver filters the stream), then waits on a loopback listener until something
 * fetches the redirect URL before `authenticate` answers.
 *
 * Run as `bun <this file>`. `AGY_FAKE_LOG` names a file it appends to:
 * `initialize`, `env <NAME>=<value>` for the variables the account is supposed
 * to carry, `callback:<url>` with the redirect URL a test is meant to paste,
 * `fetched:<path>` when that URL is hit, `authenticated`, `new:<cwd>` for
 * each session it opens with its model list, and `prompt:<sessionId>` for a
 * prompt, answered with one word, then `block:<type>` for each block after
 * its text. The session token lands under `GEMINI_HOME`, which is how the
 * account is rechecked.
 *
 * A prompt that names a scenario plays it: `scenario:subagents` launches a
 * batch with `start_subagent`, fails a second launch, runs an MCP tool of
 * the same title and launches a third batch with 1.4.1's `invoke_subagent`; `scenario:command` answers while a shell command it started
 * still runs, and `scenario:short-command` finishes that command a moment
 * after its answer.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

/** The variables a test asserts on: the isolation, the harness, the browser suppression and where it unpacks. */
const WATCHED = ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'BROWSER', 'GEMINI_API_KEY', 'TEMP', 'TMP', 'TMPDIR', 'SSL_CERT_FILE'];

/** The model option the real server answers `session/new` with, cut to three entries. */
const MODEL_OPTION = {
  type: 'select' as const,
  id: 'model',
  category: 'model' as const,
  name: 'Model',
  currentValue: 'gemini-3.7-flash-high',
  options: [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
    { value: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' },
  ],
};

/** The scopes of the real sign-in link: the third is the one a cut link loses. */
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function log(line: string): void {
  const file = process.env['AGY_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

/** The token the real server writes once Google came back, under its own home. */
function writeToken(): void {
  const home = process.env['GEMINI_HOME'];
  if (home === undefined || home.length === 0) return;
  const file = join(home, 'antigravity-acp', 'acp_token.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ access_token: 'fake', expiry: 0 }), 'utf8');
}

/**
 * The listener the sign-in comes back to. One hit is enough, whatever the path:
 * the point is that the core delivered the URL it was handed.
 */
function waitForCallback(): { url: string; hit: Promise<void>; stop(): void } {
  let resolve = (): void => undefined;
  const hit = new Promise<void>((done) => {
    resolve = done;
  });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      log(`fetched:${new URL(request.url).pathname}`);
      resolve();
      return new Response('signed in');
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/oauth2callback?code=fake-code`,
    hit,
    stop: () => {
      server.stop(true);
    },
  };
}

const app = agent({ name: 'agy-fake' })
  .onRequest('initialize', () => {
    log('initialize');
    for (const name of WATCHED) log(`env ${name}=${process.env[name] ?? ''}`);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      agentInfo: { name: 'agy-fake', version: '1' },
      authMethods: [{ id: 'oauth-personal', name: 'Sign in with Google', description: null }],
    };
  })
  .onRequest('authenticate', async ({ params }) => {
    log(`authenticate ${params.methodId}`);
    const callback = waitForCallback();
    log(`callback:${callback.url}`);
    // As long as the real one: three scopes, a state and a PKCE challenge put
    // it well past 400 characters.
    const link = `https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=${'1'.repeat(12)}-${'a'.repeat(32)}.apps.googleusercontent.com`
      + `&redirect_uri=${encodeURIComponent(callback.url)}`
      + `&scope=${encodeURIComponent(SCOPES.join(' '))}&state=fake-state&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&access_type=offline`;
    // The real server writes it to stderr first, then, not JSON, on stdout: the
    // line the driver keeps out of the protocol stream for the Accounts page.
    process.stderr.write(`Open the following link to authenticate the ACP server: ${link}\n`);
    await Bun.sleep(50);
    process.stdout.write(`Open the following link to authenticate the ACP server: ${link}\n`);
    await callback.hit;
    callback.stop();
    writeToken();
    log('authenticated');
    return {};
  })
  .onRequest('session/new', ({ params }) => {
    log(`new:${params.cwd}`);
    return { sessionId: `agy-fake-${crypto.randomUUID().slice(0, 8)}`, configOptions: [MODEL_OPTION] };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    log(`prompt:${params.sessionId}`);
    const [first, ...rest] = params.prompt;
    for (const block of rest) log(`block:${block.type}${block.type === 'image' ? `:${block.mimeType}` : ''}`);
    const text = first?.type === 'text' ? first.text : '';
    if (text.includes('Attached files available on this machine')) log('prompt names a saved file');
    const update = (body: Record<string, unknown>): Promise<void> =>
      client.notify('session/update', { sessionId: params.sessionId, update: body as never });
    if (text.includes('scenario:subagents')) {
      // Captured from 1.1.1: the launch returns its description before any child finished.
      await update({ sessionUpdate: 'tool_call', toolCallId: `${params.sessionId}:2`, title: 'Running start_subagent', kind: 'other', status: 'in_progress', rawInput: {} });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: `${params.sessionId}:2`, status: 'completed', rawOutput: 'Launch readers' });
      await update({ sessionUpdate: 'tool_call', toolCallId: `${params.sessionId}:3`, title: 'Running start_subagent', kind: 'other', status: 'failed', rawInput: {}, rawOutput: 'Subagent exceeded its limit.' });
      await update({ sessionUpdate: 'tool_call', toolCallId: `${params.sessionId}:4`, title: 'Running start_subagent', kind: 'other', status: 'completed', rawInput: {}, rawOutput: 'mcp', _meta: { is_mcp_tool_call: true } });
      // 1.4.1 renamed the tool `invoke_subagent`; it asks under `Run invoke_subagent?` and runs under the same title.
      await update({ sessionUpdate: 'tool_call', toolCallId: `${params.sessionId}:5`, title: 'Run invoke_subagent?', kind: 'other', status: 'pending', rawInput: {} });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: `${params.sessionId}:5`, title: 'Running invoke_subagent', kind: 'other', status: 'in_progress', rawInput: {} });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: `${params.sessionId}:5`, status: 'completed', rawOutput: 'Launch reviewers' });
    }
    if (text.includes('scenario:command') || text.includes('scenario:short-command')) {
      const id = `${params.sessionId}:cmd`;
      await update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Running command', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 600' } });
      if (text.includes('scenario:short-command')) {
        setTimeout(() => {
          void update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { combinedOutput: 'done', exitCode: 0 } });
        }, 300);
      }
    }
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } });
    return { stopReason: 'end_turn' as const };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
