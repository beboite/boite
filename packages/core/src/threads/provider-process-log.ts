import { basename } from 'node:path';
import type { Core } from '../core.ts';
import type { SpawnedChild } from '../procs.ts';
import { knownVersion } from '../providers/versions.ts';
import { stderrTail } from '../drivers/stderr-tail.ts';

export interface ProviderProcess {
  threadId: string;
  turnId?: string;
  providerId: string;
  /** Resuming a saved agent session, or starting a new one. */
  resume: boolean;
}

/** Signals the core sends to stop a process on purpose; any other one is a crash. */
const STOP_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);

/** Only the program's file name: a path would name the user and arguments are never logged. */
export function programName(command: string): string {
  return basename(command.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '') || 'unknown';
}

/**
 * Whether an agent process ended on its own terms: exit code 0, or a signal
 * the core uses to stop it. Anything else is what a developer reading the log
 * needs explained.
 */
export function abnormalExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal !== null) return !STOP_SIGNALS.has(signal);
  return code !== null && code !== 0;
}

/** How long `close` gets after `exit` before the end is logged from `exit` alone. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Logs one agent process from spawn to exit: the program and the version it
 * last reported, new or resumed session, how long it lived, its exit code or
 * signal, and on an abnormal end the tail of what it printed on stderr.
 */
export function watchProviderProcess(core: Core, child: SpawnedChild, command: string, who: ProviderProcess): void {
  const program = programName(command);
  const version = knownVersion(command);
  const startedAt = performance.now();
  // Wall time, as `noteStderr` stamps lines: only what this process printed describes its end.
  const startedWall = Date.now();
  // The provider this process runs, named here: the thread may have switched to another since.
  const base = { source: who.providerId, providerId: who.providerId, threadId: who.threadId, ...(who.turnId === undefined ? {} : { turnId: who.turnId }) };
  const started = (): void => core.logs.info(`Started ${program}${version ? ` ${version}` : ''} for ${who.providerId}, pid ${child.pid ?? 'unknown'}, ${who.resume ? 'resuming its saved session' : 'new session'}`, {
    ...base, event: 'driver.process.started', data: { program, version, pid: child.pid ?? null, resume: who.resume },
  });
  // A program that cannot start has no pid and never emits `spawn`: its only record is the failure.
  if (child.pid === undefined) child.once('spawn', started);
  else started();
  let reported = false;
  child.once('error', (error) => {
    if (reported) return;
    reported = true;
    // The code and not the message: `spawn /home/<name>/... ENOENT` names the user.
    const code = (error as NodeJS.ErrnoException).code ?? null;
    core.logs.warn(`${program} for ${who.providerId} could not start${code ? ` (${code})` : ''}`, {
      ...base, event: 'driver.process.spawn-failed', durationMs: performance.now() - startedAt,
      data: { program, version, code },
    });
  });
  // `close` and not `exit`: stderr is drained by then, so the tail holds the last line.
  // `exit` is the fallback: on macOS CI the test of a child that exited at once
  // sometimes never saw `close`, and such an end would be missing from the log.
  let exitedAt: number | null = null;
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => ended(code, signal));
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    exitedAt = performance.now();
    setTimeout(() => ended(code, signal), CLOSE_GRACE_MS).unref?.();
  });
  function ended(code: number | null, signal: NodeJS.Signals | null): void {
    if (reported) return;
    reported = true;
    const lifetime = (exitedAt ?? performance.now()) - startedAt;
    const abnormal = abnormalExit(code, signal);
    const tail = abnormal ? stderrTail(who.threadId, undefined, undefined, startedWall) : null;
    const how = signal !== null ? `was ended by ${signal}` : `exited with code ${code ?? 'unknown'}`;
    core.logs.record(abnormal ? 'warn' : 'info', `${program} for ${who.providerId}, pid ${child.pid ?? 'unknown'}, ${how} after ${Math.round(lifetime / 100) / 10} s${tail ? `; its last ${tail.length} characters of stderr are in data.stderrTail` : abnormal ? '; it printed nothing on stderr' : ''}`, {
      ...base, event: abnormal ? 'driver.process.crashed' : 'driver.process.exited', durationMs: lifetime,
      data: { program, version, pid: child.pid ?? null, exitCode: code, signal, ...(tail ? { stderrTail: tail } : {}) },
    });
  }
}
