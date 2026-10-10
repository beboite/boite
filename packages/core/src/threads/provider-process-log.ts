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

/**
 * Logs one agent process from spawn to exit: the program and the version it
 * last reported, new or resumed session, how long it lived, its exit code or
 * signal, and on an abnormal end the tail of what it printed on stderr.
 */
export function watchProviderProcess(core: Core, child: SpawnedChild, command: string, who: ProviderProcess): void {
  const program = programName(command);
  const version = knownVersion(command);
  const startedAt = performance.now();
  const base = { source: who.providerId, threadId: who.threadId, ...(who.turnId === undefined ? {} : { turnId: who.turnId }) };
  core.logs.info(`Started ${program}${version ? ` ${version}` : ''} for ${who.providerId}, pid ${child.pid ?? 'unknown'}, ${who.resume ? 'resuming its saved session' : 'new session'}`, {
    ...base, event: 'driver.process.started', data: { program, version, pid: child.pid ?? null, resume: who.resume },
  });
  let reported = false;
  child.once('error', (error) => {
    if (reported) return;
    reported = true;
    core.logs.warn(`${program} for ${who.providerId} could not start: ${error.message}`, {
      ...base, event: 'driver.process.spawn-failed', durationMs: performance.now() - startedAt,
      data: { program, version, code: (error as NodeJS.ErrnoException).code ?? null },
    });
  });
  // `close` and not `exit`: stderr is drained by then, so the tail holds the last line.
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (reported) return;
    reported = true;
    const lifetime = performance.now() - startedAt;
    const abnormal = abnormalExit(code, signal);
    const tail = abnormal ? stderrTail(who.threadId) : null;
    const how = signal !== null ? `was ended by ${signal}` : `exited with code ${code ?? 'unknown'}`;
    core.logs.record(abnormal ? 'warn' : 'info', `${program} for ${who.providerId}, pid ${child.pid ?? 'unknown'}, ${how} after ${Math.round(lifetime / 100) / 10} s${tail ? `; its last ${tail.length} characters of stderr are in data.stderrTail` : abnormal ? '; it printed nothing on stderr' : ''}`, {
      ...base, event: abnormal ? 'driver.process.crashed' : 'driver.process.exited', durationMs: lifetime,
      data: { program, version, pid: child.pid ?? null, exitCode: code, signal, ...(tail ? { stderrTail: tail } : {}) },
    });
  });
}
