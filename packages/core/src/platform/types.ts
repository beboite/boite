import type { MachineGpu, MachineVolume, ResourceByteUsage, Settings, TraceCapability } from '@boite/contracts';
import type { ServerUpdatePlatform } from '../server-update/types.ts';
import type { CgroupMemory } from './linux-cgroup.ts';
import type { NativeExecutionBoundary } from './protected.ts';

export interface NativeProcessInfo {
  exe: string;
  commandLine: string | null;
  parentPid: number | null;
  /** Creation identity read from this event's held handle, never a later open by pid. */
  startedAt?: number | null;
  /** Exact native creation time; Windows uses the decimal FILETIME, including sub-ms precision. */
  incarnation?: string | null;
}

export interface NativeProcessExit {
  exitCode: number | null;
  cpuMs: number | null;
  peakMemoryBytes: number | null;
  ioBytes: number | null;
  /** The same captured creation identity as the corresponding start. */
  startedAt?: number | null;
  incarnation?: string | null;
}

export interface ProcessSample {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
  /** The first CPU sample has no interval; unsupported or unreadable values are unavailable. */
  cpuMeasured?: boolean;
  memoryMeasured?: boolean;
  /** Working set for the UI; private commit for the Windows governor. */
  workingSets?: { pid: number; bytes: number; committedBytes?: number; exe?: string }[];
  /** Collected only while a visible task manager holds a detail lease. */
  resources?: { disk: ResourceByteUsage; network: ResourceByteUsage };
}

/** What the registry wants to hear about. Set once by `ProcRegistry`. */
export interface ProcessEventSink {
  started(threadId: string, pid: number, info: NativeProcessInfo): void;
  exited(threadId: string, pid: number, exit: NativeProcessExit): void;
  note(threadId: string, message: string): void;
  memoryLimit(threadId: string | null, kind: 'thread-cap' | 'budget'): void;
}

export interface ProcessLimits {
  agentCpuCapPercent: number;
  /** Effective MB limits, with auto settings already resolved against physical RAM. */
  budgetMb: number;
  threadMemoryCapMb: number;
  memoryReserveMb: number;
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

/** What the firewall's allow command exits with when nobody accepted the administrator prompt. */
export const FIREWALL_PROMPT_REFUSED = 3;

/** A top-level window a person sees on this machine's desktop (docs/windows.md). */
export interface NativeWindow {
  /** The HWND or X11 window id, in decimal. */
  id: string;
  pid: number;
  /** The executable's full path, or '' when the OS will not say: such an app can never be allowed. */
  path: string;
  /** The executable's file name: `Unity.exe`. */
  process: string;
  title: string;
  /** The window class (Windows) or WM_CLASS (X11), to tell the sign-in and lock screens apart. */
  className: string;
  /** Physical pixels, the size a capture comes out at. */
  width: number;
  height: number;
  minimized: boolean;
}

/** One picture of a window: BGRA rows from the top, 4 bytes a pixel, no padding. */
export interface WindowPixels {
  width: number;
  height: number;
  bgra: Uint8Array;
  /** The path that produced it, for the log: `wgc`, `printwindow`, `x11`. */
  via: string;
}

/** Repeated pictures of one window for a clip or the Window panel, keeping what the OS set up between them. */
export interface WindowFrames {
  next(): Promise<WindowPixels>;
  close(): void;
}

/**
 * Why a capture failed, as `WindowCaptureError.code`: the service turns each
 * into the sentence an agent reads.
 */
export type WindowCaptureFailure = 'minimized' | 'gone' | 'black' | 'failed';

/**
 * The OS half of `boite window`. Never restores, raises or focuses a window,
 * sends it no input and draws no cursor. Loaded on first use.
 */
export interface WindowCapture {
  list(): Promise<NativeWindow[]>;
  /** Throws `WindowCaptureError` (`platform/window-pixels.ts`). */
  capture(id: string): Promise<WindowPixels>;
  frames(id: string): WindowFrames;
}

/** Delete-only access to vaults used by older Boite releases. Never read or store a value. */
export interface SecretVault {
  readonly kind: 'dpapi' | 'keychain' | 'libsecret' | 'memory';
  readonly persistent: boolean;
  delete(id: string): Promise<void>;
  /** Every id stored where the backend supports enumeration; null elsewhere. */
  ids?(): Promise<string[] | null>;
}

/** OS services used by the shared process registry. No native imports here. */
export interface ProcessPlatform {
  /** Model tool execution only. Trusted account/control processes never gain authority from this descriptor. */
  protectedExecution?: NativeExecutionBoundary;
  serverUpdates?: ServerUpdatePlatform;
  /** Absolute path of the tailscale CLI, or null when it is not installed. */
  tailscaleCli?(): string | null;
  /** The command lines that read and fix the OS firewall for `program`; Windows only (`windows/firewall.ts`). */
  firewall?: { query(program: string): string[]; allow(program: string): string[] };
  /**
   * Native window capture, loaded on first call, or why this machine has none:
   * Wayland, no display, macOS. Absent reads as unavailable.
   */
  windowCapture?(): Promise<WindowCapture | { unavailable: string }>;
  retain(jobs: ProcessEventSink, guards: GuardEventSink): void;
  /** Resolves once nothing native is left holding the user's state: hooks, muted sessions. */
  release(): Promise<void>;
  capability(): TraceCapability;
  applySettings(settings: Settings): void;
  attach(threadId: string, pid: number): boolean;
  /** Reconcile captured exits when the native job is empty; true if occupied or unreadable. */
  hasProcesses?(threadId: string): boolean;
  /** Normal priority during agent initialization; platform CPU and memory caps still apply. */
  startup?(threadId: string, active: boolean): void;
  terminate(threadId: string): boolean;
  /** A held Windows handle, or a matching registered/sampled Linux birth. */
  terminateProcess(threadId: string, pid: number, startedAt?: number | null): boolean;
  /** Windows' fallback tree kill, for a pid outside the job: `killAll` waits for a returned promise. */
  terminateUnassigned(pid: number): void | Promise<unknown>;
  sample(threadId: string): ProcessSample | null;
  /** Toggle optional detailed counters without changing protection sampling. */
  watchResources?(active: boolean): void;
  /** Finish a shared detail tick after every thread supplied its observed members. */
  finishResources?(): void;
  /** Null `availableBytes` when the OS gives no honest reading; the reserve check then sits out. */
  machineMemory(): { totalBytes: number; availableBytes: number | null } | null;
  /** Fixed volumes with their size and free space; removable, network and virtual ones are left out. */
  machineVolumes?(): MachineVolume[];
  /**
   * Every GPU and its load, and on Windows each listed pid's share of its
   * busiest engine. Null when this OS has no reader. Readers open lazily and
   * close themselves once nobody has asked for a while.
   */
  machineGpus?(pids: ReadonlySet<number>): Promise<{ gpus: MachineGpu[]; pids: Map<number, number> | null } | null>;
  /** The system's display name, such as "Windows 11 Pro". */
  osLabel?(): string | null;
  /**
   * The memory readings of the cgroup holding `pid`, or null when the OS has no
   * such group, it has no throttling limit or its files cannot be read. Linux only.
   */
  cgroupMemory?(pid: number): CgroupMemory | null;
  /**
   * A traced process started or ended. `guarded` is false for a process whose
   * windows the user is meant to see, a desktop-app plugin's: the focus guard
   * leaves its windows in place and the audio guard leaves its sound on.
   */
  pidAdded(threadId: string, pid: number, guarded: boolean): void;
  pidRemoved(threadId: string, pid: number, guarded: boolean): void;
  /** A turn is starting: have the process drain and the protections ready before its first process. */
  warm(): void;
  /** The registry forgot an idle thread: drop what the platform keeps for it. */
  forget(threadId: string): void;
  guardStatus(): GuardStatus;
  /**
   * When the process that holds `pid` now started, in ms since the epoch, or
   * null when none does or the OS will not say. A pid given back is handed out
   * again, so this is what tells the process that wrote a pid down from the one
   * wearing it today.
   */
  startedAt(pid: number): number | null;
  /**
   * How the OS names one run of the process holding `pid`, where `startedAt`
   * is not absolute: Linux rebuilds it from a boot time that moves with every
   * step of the wall clock. Two equal keys are the same run. Absent where
   * `startedAt` is enough.
   */
  startKey?(pid: number): string | null;
  /**
   * The same reading for a process that is still running: null too once it has
   * exited, even while something keeps a handle on it. The orphan sweep asks
   * this before it stops a process whose parent the registry does not hold.
   */
  runningSince(pid: number): number | null;
}
