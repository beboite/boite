import type { Settings, TraceCapability } from '@boite/contracts';

export interface NativeProcessInfo {
  exe: string;
  commandLine: string | null;
  parentPid: number | null;
}

export interface NativeProcessExit {
  exitCode: number | null;
  cpuMs: number | null;
  peakMemoryBytes: number | null;
  ioBytes: number | null;
}

export interface ProcessSample {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
}

/** What the registry wants to hear about. Set once by `ProcRegistry`. */
export interface ProcessEventSink {
  started(threadId: string, pid: number, info: NativeProcessInfo): void;
  exited(threadId: string, pid: number, exit: NativeProcessExit): void;
  note(threadId: string, message: string): void;
}

export interface ProcessLimits {
  agentCpuCapPercent: number;
  threadMemoryCapMb: number;
}

/** What the registry wants to hear about. Set once by `ProcRegistry`. */
export interface GuardEventSink {
  pushed(threadId: string, pid: number, title: string, restored: boolean): void;
  muted(threadId: string, pid: number): void;
  note(message: string): void;
}

/** What a test reads to know the hook is really in and what is muted. */
export interface GuardStatus {
  /** True between the first traced pid and the core's own teardown. */
  running: boolean;
  /** The `HWINEVENTHOOK` in decimal, once the Worker answered `ready`. */
  hook: string | null;
  failure: string | null;
  /**
   * `on` while agent audio is being muted, `off` when the setting is off, and
   * `failed` when Core Audio refused: no render endpoint, no COM, no device.
   */
  audio: 'on' | 'off' | 'failed';
  /** Every pid whose audio session this core is holding muted. */
  mutedPids: number[];
}

/** OS services used by the shared process registry. No native imports here. */
export interface ProcessPlatform {
  retain(jobs: ProcessEventSink, guards: GuardEventSink): void;
  /** Resolves once nothing native is left holding the user's state: hooks, muted sessions. */
  release(): Promise<void>;
  capability(): TraceCapability;
  applySettings(settings: Settings): void;
  attach(threadId: string, pid: number): boolean;
  terminate(threadId: string): boolean;
  /** One process the thread's job reported, through the handle held since its start. */
  terminateProcess(threadId: string, pid: number): boolean;
  terminateUnassigned(pid: number): void;
  sample(threadId: string): ProcessSample | null;
  pidAdded(threadId: string, pid: number): void;
  pidRemoved(threadId: string, pid: number): void;
  /** The registry forgot an idle thread: drop what the platform keeps for it. */
  forget(threadId: string): void;
  guardStatus(): GuardStatus;
}
