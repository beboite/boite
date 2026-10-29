import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ProcessRecord } from '@boite/contracts';

export interface SpawnOptions {
  /** Bounded normal-priority initialization, ended explicitly when the agent is ready. */
  startup?: boolean;
  /** Direct spawns are agent roots unless the caller identifies a tool process. */
  agentRoot?: boolean;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /**
   * `spawn` only: this many more pipes, the child's descriptors 3, 4 and on,
   * whose ends this process holds in `fds`. The agent browser speaks the
   * DevTools protocol over two of them instead of a port anyone could reach.
   */
  extraPipes?: number;
  /**
   * `spawn` only: let the child show its windows; Windows applies `windowsHide`
   * to a GUI program's first window too. The focus and audio guards then leave
   * the thread's processes, its job's included, alone: they are the user's app.
   */
  showWindow?: boolean;
}

export type ChildProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** A child whose stdin stays open: the account login writes a pasted code into it. */
export type PipedChildProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

/** What `spawnChild` returns: node's own child, which satisfies the SDK's `SpawnedProcess`. */
export type SpawnedChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Stops one spawned process and what it started, and only that: the other
 * processes of its thread or scope keep running. Bound to the process caught
 * at spawn, its group off Windows, so it still reaches a helper left holding
 * the pipes after the process itself exited and the registry let go of it.
 * Resolves once the stop has ended (the group gone or sent SIGKILL) and the
 * process has exited. `proc.kill()` reaches the process alone.
 */
export type ManagedStop = () => Promise<void>;

export interface SpawnedProcess {
  record: ProcessRecord;
  proc: ChildProcess;
  exited: Promise<number>;
  stop: ManagedStop;
  /** This side of each `extraPipes` pipe, in order: the child's descriptor 3 first. */
  fds?: number[];
}

export interface SpawnedPipedProcess {
  record: ProcessRecord;
  proc: PipedChildProcess;
  exited: Promise<number>;
  stop: ManagedStop;
}

export interface TerminalSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  onData(bytes: Uint8Array): void;
}

export interface SpawnedTerminal {
  record: ProcessRecord;
  terminal: Bun.Terminal;
  exited: Promise<number>;
}
