import type { SpawnOptions } from './process-spawn-types.ts';
import type { ProcRegistry } from './procs.ts';

/** What one short-lived system command gave. Its output stays on the core. */
export interface CommandRun {
  /** The command's own exit code; null when it could not start. */
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
  /** It, or a helper holding its pipes, outlived the deadline and was stopped. */
  timedOut: boolean;
}

/**
 * After the stop that ends a late command, how long its pipes may still take
 * to close. A helper that left the command's group keeps them open past any
 * stop, and what had arrived is returned rather than waited on.
 */
export const DRAIN_MS = 500;

/** A pipe read to its end, or until `cancel` gives up on it with what it gave. */
function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(value);
      }
    } catch {
      // Cancelled, or the pipe broke: what arrived is the output.
    }
  })();
  return {
    done,
    cancel: () => { reader.cancel().catch(() => {}); },
    bytes: () => Buffer.concat(chunks),
  };
}

/**
 * Runs one system command in `scope` and collects it: its output, its code,
 * all within `timeoutMs`. At the deadline the command and everything it
 * started are stopped through the spawn's own `stop`, never `killTree(scope)`,
 * which would take the scope's other commands with it. A command that exited
 * while a helper it started still holds the pipes is late the same way.
 */
export async function runCommand(
  procs: Pick<ProcRegistry, 'spawn'>,
  scope: string,
  command: string,
  args: string[],
  timeoutMs: number,
  options: SpawnOptions = {},
): Promise<CommandRun> {
  let spawned: ReturnType<ProcRegistry['spawn']>;
  try {
    spawned = procs.spawn(scope, command, args, { agentRoot: false, ...options });
  } catch (error) {
    return { code: null, stdout: new Uint8Array(), stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  const stdout = collect(spawned.proc.stdout);
  const stderr = collect(spawned.proc.stderr);
  const pipes = Promise.all([stdout.done, stderr.done]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); });
  const timedOut = await Promise.race([Promise.all([pipes, spawned.exited]).then(() => false), late]);
  clearTimeout(timer);
  if (timedOut) {
    await spawned.stop();
    await Promise.race([pipes, Bun.sleep(DRAIN_MS)]);
    stdout.cancel();
    stderr.cancel();
  }
  const code = await spawned.exited;
  return { code, stdout: stdout.bytes(), stderr: new TextDecoder().decode(stderr.bytes()), timedOut };
}
