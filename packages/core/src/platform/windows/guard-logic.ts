/**
 * What the focus guard decides, with no Win32 in sight.
 *
 * The guard Worker owns a `SetWinEventHook` and a message pump; this class owns
 * the rule. Everything native it needs is behind `GuardWin32`, so the whole
 * decision is proved by `test/guard.test.ts` on a fake, without creating a
 * single window on the user's screen.
 */

/** `HWND_BOTTOM`: behind every other window, which is where a thief goes. */
export const HWND_BOTTOM = 1n;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;

/** Move it in the Z order and nothing else, and never activate it doing so. */
export const PUSH_BACK_FLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;

/** What `GetWindowThreadProcessId` answers: the creating thread and its process. */
export interface WindowOwner {
  pid: number;
  threadId: number;
}

/** The seven Win32 calls the rule makes. The Worker binds them to `user32.dll`. */
export interface GuardWin32 {
  /** `GetWindowThreadProcessId`. Null when the window handle is not valid any more. */
  windowPid(hwnd: bigint): WindowOwner | null;
  /** `GetWindowTextW`, 256 characters. Empty when the window has no caption. */
  windowTitle(hwnd: bigint): string;
  /** `SetWindowPos` with no move and no size. */
  setWindowPos(hwnd: bigint, insertAfter: bigint, flags: number): boolean;
  /** `AttachThreadInput`. */
  attachThreadInput(from: number, to: number, attach: boolean): boolean;
  /** `SetForegroundWindow`. False when the system refused the change. */
  setForegroundWindow(hwnd: bigint): boolean;
  /** `GetForegroundWindow`. Zero when there is no foreground window. */
  foregroundWindow(): bigint;
  /** `GetCurrentThreadId` of the thread that installed the hook. */
  ownThreadId(): number;
}

/** One push back, on its way to the main thread. */
export interface ForegroundPushed {
  kind: 'foreground-pushed';
  threadId: string;
  pid: number;
  /** The window handle in decimal: it goes through `postMessage` and into a log. */
  hwnd: string;
  title: string;
  restored: boolean;
}

export class GuardLogic {
  /** pid to the thread that owns it. A window of any of these is a thief. */
  readonly #pids = new Map<number, string>();
  /** What was pushed back, drained by the Worker after every pumped message. */
  readonly events: ForegroundPushed[] = [];

  #enabled: boolean;
  /** The last foreground window that was not an agent's, and its thread. */
  #previous: bigint | null = null;
  #previousThreadId = 0;
  /** True while this class is calling `SetForegroundWindow` itself. */
  #restoring = false;
  /**
   * The window a restore just raised. Its `EVENT_SYSTEM_FOREGROUND` arrives a
   * moment later on the pump, and handling it would be acting on our own work.
   */
  #restoredHwnd: bigint | null = null;

  constructor(
    private readonly win32: GuardWin32,
    enabled: boolean,
  ) {
    this.#enabled = enabled;
    // Whatever the user is on when the guard starts is the first thing to give
    // the focus back to, before any event has been seen.
    const current = win32.foregroundWindow();
    if (current !== 0n) {
      this.#previous = current;
      this.#previousThreadId = win32.windowPid(current)?.threadId ?? 0;
    }
  }

  addPid(threadId: string, pid: number): void {
    if (pid > 0) this.#pids.set(pid, threadId);
  }

  removePid(pid: number): void {
    this.#pids.delete(pid);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  /** Everything pushed back since the last drain. */
  takeEvents(): ForegroundPushed[] {
    return this.events.splice(0, this.events.length);
  }

  /** One `EVENT_SYSTEM_FOREGROUND`: this window has just become the foreground. */
  onForeground(hwnd: bigint): void {
    if (this.#restoring) return;
    if (this.#restoredHwnd !== null && hwnd === this.#restoredHwnd) {
      this.#restoredHwnd = null;
      return;
    }

    const owner = this.win32.windowPid(hwnd);
    if (owner === null) return;

    const threadId = this.#pids.get(owner.pid);
    if (threadId === undefined) {
      // Not an agent's window: this is what the focus goes back to next time.
      this.#previous = hwnd;
      this.#previousThreadId = owner.threadId;
      return;
    }
    if (!this.#enabled) return;

    const title = this.win32.windowTitle(hwnd);
    this.win32.setWindowPos(hwnd, HWND_BOTTOM, PUSH_BACK_FLAGS);
    const restored = this.restorePrevious();
    this.events.push({
      kind: 'foreground-pushed',
      threadId,
      pid: owner.pid,
      hwnd: hwnd.toString(),
      title,
      restored,
    });
  }

  /**
   * Give the foreground back to the window the user was on. A background process
   * is refused `SetForegroundWindow` outright, so its input queue is attached to
   * the target thread's for the length of the call and detached right after.
   */
  private restorePrevious(): boolean {
    const previous = this.#previous;
    if (previous === null) return false;

    this.#restoring = true;
    try {
      const own = this.win32.ownThreadId();
      const target = this.#previousThreadId;
      const attached = target !== 0 && target !== own && this.win32.attachThreadInput(own, target, true);
      const restored = this.win32.setForegroundWindow(previous);
      if (attached) this.win32.attachThreadInput(own, target, false);
      // Only a restore that took effect raises an event to ignore. Marking one
      // that failed would swallow the next real event for that window.
      if (restored) this.#restoredHwnd = previous;
      return restored;
    } finally {
      this.#restoring = false;
    }
  }
}
