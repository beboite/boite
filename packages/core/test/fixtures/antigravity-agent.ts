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
 * `fetched:<path>` when that URL is hit, and `authenticated`. The session token
 * lands under `GEMINI_HOME`, which is how the account is rechecked.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

/** The variables a test asserts on: the isolation, the harness and the browser suppression. */
const WATCHED = ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'BROWSER', 'GEMINI_API_KEY'];

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
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'agy-fake', version: '1' },
      authMethods: [{ id: 'oauth-personal', name: 'Sign in with Google', description: null }],
    };
  })
  .onRequest('authenticate', async ({ params }) => {
    log(`authenticate ${params.methodId}`);
    const callback = waitForCallback();
    log(`callback:${callback.url}`);
    // Not JSON, and on stdout: the line the driver has to keep out of the
    // protocol stream and hand to the Accounts page instead.
    process.stdout.write(
      `Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&redirect_uri=${encodeURIComponent(callback.url)}\n`,
    );
    await callback.hit;
    callback.stop();
    writeToken();
    log('authenticated');
    return {};
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
