/**
 * The focus guard's Worker: one `SetWinEventHook` on `EVENT_SYSTEM_FOREGROUND`
 * and the message pump that hook needs. A window of a process a thread launched
 * that takes the foreground is sent to the bottom without activation, and the
 * window the user was on gets the focus back.
 *
 * The audio mute rides the same thread and the same pid set. There is no
 * notification to hook for it: registering `IAudioSessionNotification` would
 * need an MTA thread and a JS COM object, so the sessions of the default render
 * endpoint are polled every second and right after every pid, and a session of
 * a traced pid is muted until that pid exits.
 *
 * It lives in a Worker because the hook is delivered on the thread that
 * installed it and only while that thread pumps messages: the main thread must
 * stay free to serve RPC. Both rules are plain classes, `GuardLogic` and
 * `MuteLogic`, which know nothing about Win32 or COM, so they are tested
 * without ever creating a window or making a sound.
 */
import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi';
import { coInitialize, coUninitialize, openSessions } from './audio-sessions.ts';
import type { AudioSession } from './audio-sessions.ts';
import { AudioEndpoint } from './audio-endpoint.ts';
import { GuardLogic } from './guard-logic.ts';
import type { ForegroundPushed, GuardWin32 } from './guard-logic.ts';
import { MuteLogic } from './mute-logic.ts';
import type { MuteEvent } from './mute-logic.ts';

export interface GuardWorkerStart {
  kind: 'start';
  /** One Int32: the main thread writes 1 to ask the pump to stop. */
  stop: SharedArrayBuffer;
  /** Milliseconds one bounded wait on the message queue lasts. */
  waitMs: number;
  /** The focus guard's own setting. `mute` is the audio one. */
  enabled: boolean;
  mute: boolean;
}

export type GuardWorkerCommand =
  | GuardWorkerStart
  | { kind: 'pid-add'; threadId: string; pid: number }
  | { kind: 'pid-remove'; threadId: string; pid: number }
  | { kind: 'set'; enabled: boolean; mute: boolean };

export type GuardWorkerMessage =
  /** `hook` is the `HWINEVENTHOOK` in decimal, never "0" once the hook is in. */
  | { kind: 'ready'; hook: string }
  /** Nothing native can run: the Worker does nothing more and waits to be stopped. */
  | { kind: 'failed'; reason: string }
  /** The focus hook was refused; the pump and the audio mute run without it. */
  | { kind: 'hook-failed'; reason: string }
  | { kind: 'stopped' }
  | ForegroundPushed
  | MuteEvent;

// -- Win32 constants --------------------------------------------------------

const EVENT_SYSTEM_FOREGROUND = 0x0003;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;
/** The hook only ever wants the window itself: OBJID_WINDOW with CHILDID_SELF. */
const OBJID_WINDOW = 0;
const CHILDID_SELF = 0;
const PM_REMOVE = 0x0001;
const QS_ALLINPUT = 0x04ff;
/** MSG on x64: hwnd, message, wParam, lParam, time, POINT, with the padding. */
const MSG_SIZE = 64;
const TITLE_CHARS = 256;
/**
 * How long between two walks of the audio sessions. A session that opens and
 * closes inside one interval can play a burst; anything shorter is a COM walk
 * every few hundred milliseconds for a case that barely exists.
 */
const AUDIO_INTERVAL_MS = 1000;

const scope = globalThis as unknown as {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: GuardWorkerMessage): void;
};

function send(message: GuardWorkerMessage): void {
  scope.postMessage(message);
}

function loadUser32() {
  // Every HANDLE-like value (HWND, HWINEVENTHOOK) travels as u64: Bun's own
  // note says `ptr` does not represent them correctly on Windows.
  return dlopen('user32.dll', {
    SetWinEventHook: {
      args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.function, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.u64,
    },
    UnhookWinEvent: { args: [FFIType.u64], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    SetWindowPos: {
      args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
    GetForegroundWindow: { args: [], returns: FFIType.u64 },
    MsgWaitForMultipleObjects: {
      args: [FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.u32],
      returns: FFIType.u32,
    },
    PeekMessageW: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    TranslateMessage: { args: [FFIType.ptr], returns: FFIType.i32 },
    DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.u64 },
  });
}

function loadKernel32() {
  return dlopen('kernel32.dll', {
    GetCurrentThreadId: { args: [], returns: FFIType.u32 },
  });
}

type User32 = ReturnType<typeof loadUser32>['symbols'];
type Kernel32 = ReturnType<typeof loadKernel32>['symbols'];

function nativeWin32(u32: User32, k32: Kernel32): GuardWin32 {
  const pidOut = new Uint32Array(1);
  const title = new Uint16Array(TITLE_CHARS);
  return {
    windowPid(hwnd: bigint) {
      pidOut[0] = 0;
      const threadId = u32.GetWindowThreadProcessId(hwnd, ptr(pidOut));
      if (threadId === 0) return null;
      return { pid: pidOut[0] ?? 0, threadId };
    },
    windowTitle(hwnd: bigint): string {
      const length = u32.GetWindowTextW(hwnd, ptr(title), TITLE_CHARS);
      if (length <= 0) return '';
      return Buffer.from(title.buffer, 0, length * 2).toString('utf16le');
    },
    setWindowPos: (hwnd: bigint, insertAfter: bigint, flags: number): boolean =>
      u32.SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, flags) !== 0,
    attachThreadInput: (from: number, to: number, attach: boolean): boolean =>
      u32.AttachThreadInput(from, to, attach ? 1 : 0) !== 0,
    setForegroundWindow: (hwnd: bigint): boolean => u32.SetForegroundWindow(hwnd) !== 0,
    foregroundWindow: (): bigint => BigInt(u32.GetForegroundWindow()),
    ownThreadId: (): number => k32.GetCurrentThreadId(),
  };
}

let logic: GuardLogic | null = null;
let mute: MuteLogic | null = null;
/**
 * The default render endpoint, opened on the first walk and reopened after a
 * failure, after the user switched output device, and every half minute on a
 * machine that had none. A walk that throws is what puts the reason in a single
 * `audio-failed`.
 */
const endpoint = new AudioEndpoint(openSessions);
/** True once COM refused this thread: the audio half stays off for the Worker's life. */
let comFailed = false;
/** True between a `CoInitializeEx` that took and its matching `CoUninitialize`. */
let comReady = false;

function listSessions(skipped: (message: string) => void): AudioSession[] {
  return endpoint.list(skipped);
}
scope.onmessage = (event: { data: unknown }): void => {
  const command = event.data as GuardWorkerCommand;
  if (command.kind !== 'start') {
    onCommand(command);
    return;
  }

  let u32: User32;
  let k32: Kernel32;
  try {
    u32 = loadUser32().symbols;
    k32 = loadKernel32().symbols;
  } catch (error) {
    send({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    return;
  }

  const guard = new GuardLogic(nativeWin32(u32, k32), command.enabled);
  logic = guard;

  // Out-of-context events are delivered on this thread, so a plain callback is
  // enough: `threadsafe` would make the return value unspecified and is only
  // needed for a callback another thread invokes.
  const callback = new JSCallback(
    (_hook: unknown, _event: number, hwnd: number, idObject: number, idChild: number): void => {
      if (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return;
      guard.onForeground(BigInt(hwnd));
    },
    {
      args: ['ptr', 'u32', 'ptr', 'i32', 'i32', 'u32', 'u32'],
      returns: 'void',
      threadsafe: false,
    },
  );

  // A refused hook turns the focus half off, not the audio one: a core with no
  // interactive desktop still mutes what its agents play.
  let hook = 0n;
  if (callback.ptr === null) {
    callback.close();
    send({ kind: 'hook-failed', reason: 'the WinEventProc callback has no pointer' });
  } else {
    hook = u32.SetWinEventHook(
      EVENT_SYSTEM_FOREGROUND,
      EVENT_SYSTEM_FOREGROUND,
      0n,
      callback.ptr,
      0,
      0,
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
    );
    if (hook === 0n) {
      callback.close();
      send({ kind: 'hook-failed', reason: 'SetWinEventHook returned no hook' });
    } else {
      send({ kind: 'ready', hook: hook.toString() });
    }
  }

  // COM comes after the hook, on this same thread: the apartment is the
  // message-pumping one, and only outgoing calls are ever made from it.
  const audio = new MuteLogic(listSessions, command.mute);
  mute = audio;
  try {
    coInitialize();
    comReady = true;
  } catch (error) {
    audio.setEnabled(false);
    comFailed = true;
    send({ kind: 'audio-failed', message: error instanceof Error ? error.message : String(error) });
  }

  const stop = new Int32Array(command.stop);
  const message = new Uint8Array(MSG_SIZE);
  const messagePtr = ptr(message);

  /**
   * One bounded wait plus one drain of the queue. This is a tick rather than a
   * `while` loop on purpose: the pump has to give the JS event loop its turn or
   * `pid-add`, `pid-remove` and `set` would never reach this thread.
   */
  let nextWalk = 0;
  const tick = (): void => {
    if (Atomics.load(stop, 0) !== 0) {
      if (hook !== 0n) {
        u32.UnhookWinEvent(hook);
        callback.close();
      }
      logic = null;
      shutDownAudio(audio);
      send({ kind: 'stopped' });
      return;
    }
    u32.MsgWaitForMultipleObjects(0, null, 0, command.waitMs, QS_ALLINPUT);
    while (u32.PeekMessageW(messagePtr, 0n, 0, 0, PM_REMOVE) !== 0) {
      u32.TranslateMessage(messagePtr);
      u32.DispatchMessageW(messagePtr);
    }
    // The wait above returns early on any message, so the walk is on the clock
    // rather than on a count of turns.
    const now = Date.now();
    if (now >= nextWalk) {
      nextWalk = now + AUDIO_INTERVAL_MS;
      audio.tick();
    }
    for (const pushed of guard.takeEvents()) send(pushed);
    for (const muted of audio.takeEvents()) send(muted);
    setTimeout(tick, 0);
  };
  tick();
};

/** Give every muted process its sound back, then let this thread out of COM. */
function shutDownAudio(audio: MuteLogic): void {
  audio.releaseAll();
  mute = null;
  endpoint.release();
  if (!comReady) return;
  comReady = false;
  try {
    coUninitialize();
  } catch {
    // The thread is going away; a refused CoUninitialize changes nothing.
  }
}

function onCommand(command: Exclude<GuardWorkerCommand, GuardWorkerStart>): void {
  if (logic === null) return;
  switch (command.kind) {
    case 'pid-add':
      logic.addPid(command.threadId, command.pid);
      mute?.addPid(command.threadId, command.pid);
      break;
    case 'pid-remove':
      logic.removePid(command.pid);
      mute?.removePid(command.pid);
      break;
    case 'set':
      logic.setEnabled(command.enabled);
      // A thread COM refused stays off whatever the user asks.
      if (!comFailed) mute?.setEnabled(command.mute);
      break;
    default:
      return;
  }
  // `addPid` walks the sessions on the spot, so its events are here already and
  // waiting for the next pump tick would delay them by a whole wait.
  if (mute !== null) for (const muted of mute.takeEvents()) send(muted);
}
