/** The login: `initialize` then `authenticate`, for an agent that has no CLI. */
import { Readable, Writable } from 'node:stream';
import type { ClientConnection } from '@agentclientprotocol/sdk';
import pkg from '../../../package.json';
import { messageOf } from '../../errors.ts';
import type { SpawnedChild, SpawnOptions } from '../../procs.ts';
import { stderrLines } from '../lines.ts';
import { CLIENT_NAME, MINUTE_MS, preferExit, STDERR_MAX, type Timer } from './protocol.ts';
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
}

export interface AcpLoginRun {
  /** Settles only once the process and its pipes have closed. */
  exited: Promise<void>;
  /** Resolves when `authenticate` answered, rejects with what the agent refused. */
  done: Promise<void>;
  /** The process and the connection go, on success and on failure alike. */
  kill(): void;
}

/** How long the whole sign-in has to finish, the user's time at the Google page included. */
const LOGIN_TIMEOUT_MS = 5 * MINUTE_MS;

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
    input.onLine(lastStderr);
  });
  // Listened for before the SDK loads: an agent that exits at once would
  // otherwise be gone before anyone heard it.
  const died = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) => {
      const head = `the agent exited with code ${code ?? 'unknown'} before it authenticated`;
      reject(new Error(lastStderr.length === 0 ? head : `${head}: ${lastStderr}`));
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

    const run = (async (): Promise<void> => {
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
    })();

    try {
      await Promise.race([run.catch((error: unknown) => preferExit(died, error)), died, expired]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })();

  return { done, kill, exited };
}
