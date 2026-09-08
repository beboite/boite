/**
 * The one thing the guard cannot be proved on without a window: a process that
 * really takes the foreground.
 *
 * It creates a top-level window off screen (x = -32000, so nothing is drawn
 * where the user can see it), steals the foreground the way a badly behaved
 * installer does, waits two seconds, and exits 0 when the foreground is no
 * longer its own window, which is the guard having pushed it back.
 *
 * It takes the keyboard focus for a few milliseconds, so `bun test` never runs
 * it: `test/guard.e2e.test.ts` is gated on `BOITE_E2E_GUARD=1` and only the
 * user starts it.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';

if (process.platform !== 'win32') {
  console.error('guard-window: Windows only');
  process.exit(2);
}

const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const SW_SHOW = 5;
const OFF_SCREEN_X = -32000;
const HOLD_MS = 2000;

const u32 = dlopen('user32.dll', {
  CreateWindowExW: {
    args: [
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.u64,
      FFIType.u64,
      FFIType.u64,
      FFIType.u64,
    ],
    returns: FFIType.u64,
  },
  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  DestroyWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  BringWindowToTop: { args: [FFIType.u64], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  PeekMessageW: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  TranslateMessage: { args: [FFIType.ptr], returns: FFIType.i32 },
  DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.u64 },
}).symbols;

const k32 = dlopen('kernel32.dll', {
  GetCurrentThreadId: { args: [], returns: FFIType.u32 },
}).symbols;

function wide(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${text}\0`, 'utf16le'));
}

// The predefined STATIC class needs no RegisterClassExW and gives a real
// top-level window with a caption the guard can read.
const className = wide('STATIC');
const title = wide('Boite focus guard fixture');
const hwnd = u32.CreateWindowExW(
  0,
  ptr(className),
  ptr(title),
  WS_OVERLAPPEDWINDOW,
  OFF_SCREEN_X,
  OFF_SCREEN_X,
  200,
  120,
  0n,
  0n,
  0n,
  0n,
);
if (hwnd === 0n) {
  console.error('guard-window: CreateWindowExW created nothing');
  process.exit(2);
}

u32.ShowWindow(hwnd, SW_SHOW);

// The same AttachThreadInput trick a real thief uses, so the steal is not left
// to whether this process happens to hold the foreground rights.
const pidOut = new Uint32Array(1);
const own = k32.GetCurrentThreadId();
const front = u32.GetForegroundWindow();
const target = front === 0n ? 0 : u32.GetWindowThreadProcessId(front, ptr(pidOut));
const attached = target !== 0 && target !== own && u32.AttachThreadInput(own, target, 1) !== 0;
u32.BringWindowToTop(hwnd);
u32.SetForegroundWindow(hwnd);
if (attached) u32.AttachThreadInput(own, target, 0);

console.log(`guard-window: hwnd ${hwnd.toString()} shown, foreground ${u32.GetForegroundWindow().toString()}`);

const message = new Uint8Array(64);
const messagePtr = ptr(message);
const until = Date.now() + HOLD_MS;
while (Date.now() < until) {
  while (u32.PeekMessageW(messagePtr, 0n, 0, 0, 1) !== 0) {
    u32.TranslateMessage(messagePtr);
    u32.DispatchMessageW(messagePtr);
  }
  await Bun.sleep(25);
}

const stillInFront = u32.GetForegroundWindow() === hwnd;
u32.DestroyWindow(hwnd);
console.log(`guard-window: still in front ${String(stillInFront)}`);
process.exit(stillInFront ? 1 : 0);
