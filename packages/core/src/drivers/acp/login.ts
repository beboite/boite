/**
 * The login: `initialize` then `authenticate`, for an agent that has no CLI,
 * then one session that lists the account's models.
 */
import { Readable, Writable } from 'node:stream';
import type { ClientConnection } from '@agentclientprotocol/sdk';
import pkg from '../../../package.json';
import { messageOf } from '../../errors.ts';
import type { SpawnedChild, SpawnOptions } from '../../procs.ts';
import { stderrDrained, stderrLines } from '../lines.ts';
import { canDeleteSessions, CLIENT_NAME, discardSession, MINUTE_MS, preferExit, STDERR_MAX, type Timer } from './protocol.ts';
import { jsonLinesOnly } from './stdout.ts';

export interface AcpLoginInput {
  /** The `authenticate` method id the descriptor names. */
  methodId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  spawnChild(cmd: string, args: string[], opts?: SpawnOptions): SpawnedChild;
  /** Every line the agent wrote outside the ndjson stream, the sign-in link included. */
  onLine(line: string): void;
  /**
   * An empty directory to open one session in once `authenticate` answered,
   * so the models the account may run are read by the process already
   * started. Absent: the login opens no session.
   */
  catalogCwd?: string;
}

/** What the session opened after the sign-in said, or why there is none. */
export interface AcpLoginCatalog {
  /** The raw `session/new` answer, null when no session was read. */
  created: unknown;
  /** Why no session was read; null when one was, or none was asked for. */
  error: string | null;
}

export interface AcpLoginRun {
  /** Settles only once the process and its pipes have closed. */
  exited: Promise<void>;
  /** Resolves when `authenticate` answered, rejects with what the agent refused. */
  done: Promise<void>;
  /** The process and the connection go, on success and on failure alike. */
  kill(): void;
  /**
   * The catalog session, settled before `done` resolves. It never fails the
   * sign-in: an account signed in whose session did not open is still signed in.
   */
  catalog?: Promise<AcpLoginCatalog>;
}

/** How long the whole sign-in has to finish, the user's time at the Google page included. */
const LOGIN_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long the agent, already signed in and running, has to open the catalog session. */
const CATALOG_TIMEOUT_MS = 30_000;

/**
 * One `session/new` on a signed-in agent, then the session goes. Every failure,
 * the process exiting included, becomes the answer's `error`.
 */
async function readCatalog(
  agent: ClientConnection['agent'],
  canDelete: boolean,
  cwd: string,
  child: SpawnedChild,
): Promise<AcpLoginCatalog> {
  let timer: Timer | null = null;
  const died = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`the agent exited with code ${code ?? 'unknown'}`)));
  });
  died.catch(() => undefined);
  try {
    const read = (async () => {
      const created = await agent.request('session/new', { cwd, mcpServers: [] });
      await discardSession(agent, canDelete, created.sessionId);
      return created;
    })();
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the agent did not open a session within ${CATALOG_TIMEOUT_MS / 1000} s`));
      }, CATALOG_TIMEOUT_MS);
      timer.unref?.();
    });
    const created: unknown = await Promise.race([read.catch((error: unknown) => preferExit(died, error)), died, expired]);
    return { created, error: null };
  } catch (error) {
    return { created: null, error: messageOf(error) };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * One agent process whose only job is the protocol's `authenticate`. It is
 * started like a turn's, so it sits in the login thread's Job Object and in the
 * trace; what it prints outside the protocol goes to `onLine`, which is how the
 * Google sign-in link reaches the Accounts page.
 */
export function runAcpLogin(input: AcpLoginInput): AcpLoginRun {
  const child = input.spawnChild(input.executable, input.args, { cwd: input.cwd, env: input.env });
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  child.stdin.on('error', () => undefined);
  let lastStderr = '';
  stderrLines(child.stderr, (text) => {
    lastStderr = text.slice(0, STDERR_MAX);
    // Whole: Antigravity prints its sign-in link here too, and a link cut at
    // the error message's length asks Google for a scope that ends mid-URL.
    input.onLine(text);
  });
  // Listened for before the SDK loads: an agent that exits at once would
  // otherwise be gone before anyone heard it.
  const died = new Promise<never>((_resolve, reject) => {
    // The exit can land before the last stderr line is read: wait a moment for the pipe.
    child.once('exit', (code) => {
      void stderrDrained(child.stderr).then(() => {
        const head = `the agent exited with code ${code ?? 'unknown'} before it authenticated`;
        reject(new Error(lastStderr.length === 0 ? head : `${head}: ${lastStderr}`));
      });
    });
    child.once('error', (error) => {
      reject(new Error(`the agent did not start: ${messageOf(error)}`));
    });
  });
  died.catch(() => undefined);

  let connection: ClientConnection | null = null;
  let timer: Timer | null = null;
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    if (timer !== null) clearTimeout(timer);
    try {
      connection?.close();
    } catch {
      // already closed
    }
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    try {
      child.kill();
    } catch {
      // already exited
    }
  };

  let catalog: AcpLoginCatalog = { created: null, error: null };
  const done = (async (): Promise<void> => {
    const sdk = await import('@agentclientprotocol/sdk');
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the sign-in was not finished within ${LOGIN_TIMEOUT_MS / MINUTE_MS} minutes`));
      }, LOGIN_TIMEOUT_MS);
      timer.unref?.();
    });

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, input.onLine),
    );
    const open = sdk.client({ name: CLIENT_NAME }).connect(stream);
    connection = open;

    const run = (async (): Promise<boolean> => {
      const init = await open.agent.request('initialize', {
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, version: pkg.version },
      });
      const offered = (init.authMethods ?? []).map((method) => method.id);
      if (offered.length > 0 && !offered.includes(input.methodId)) {
        throw new Error(`the agent offers no ${input.methodId} sign-in, only ${offered.join(', ')}`);
      }
      await open.agent.request('authenticate', { methodId: input.methodId });
      return canDeleteSessions(init);
    })();

    let canDelete: boolean;
    try {
      canDelete = await Promise.race([run.catch((error: unknown) => preferExit(died, error)), died, expired]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    // Signed in. A second launch would unpack and start the whole agent again
    // to list the models; this one is already running.
    if (input.catalogCwd !== undefined) catalog = await readCatalog(open.agent, canDelete, input.catalogCwd, child);
  })();

  return { done, kill, exited, catalog: done.then(() => catalog, () => ({ created: null, error: null })) };
}
