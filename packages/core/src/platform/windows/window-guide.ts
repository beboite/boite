/**
 * `boite window read`, `point` and `wait-click` on Windows, through `bun:ffi`:
 * the controls of a window (`window-controls.ts`), where a window lies, and
 * the mouse's state. `platform/windows/index.ts` loads it on first use, never
 * at startup.
 *
 * The box itself is drawn by the desktop app (`pointer_window.rs` in the
 * shell): the core sends it where to go with `windows.pointer`.
 *
 * Every rectangle is in physical pixels: the thread is per-monitor aware
 * (V2) for each call, as `window-capture.ts` does, so a box lands on the
 * control at 100 % and 150 % scaling and on every monitor.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { ScreenRect, WindowGuide } from '../types.ts';
import { frameBounds, physicalPixels, windowOf } from './window-capture.ts';
import { readControls } from './window-controls.ts';

const U64 = FFIType.u64;
const PTR = FFIType.ptr;
const I32 = FFIType.i32;

function loadUser32() {
  return dlopen('user32.dll', {
    GetCursorPos: { args: [PTR], returns: I32 },
    GetAsyncKeyState: { args: [I32], returns: FFIType.i16 },
    GetSystemMetrics: { args: [I32], returns: I32 },
    IsIconic: { args: [U64], returns: I32 },
    IsHungAppWindow: { args: [U64], returns: I32 },
  }).symbols;
}

function loadKernel32() {
  return dlopen('kernel32.dll', {
    GetModuleHandleW: { args: [PTR], returns: U64 },
    GetProcAddress: { args: [U64, PTR], returns: U64 },
  }).symbols;
}

let user32Symbols: ReturnType<typeof loadUser32> | null = null;
let kernel32Symbols: ReturnType<typeof loadKernel32> | null = null;
const user32 = () => (user32Symbols ??= loadUser32());
const kernel32 = () => (kernel32Symbols ??= loadKernel32());

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const SM_SWAPBUTTON = 23;
const ZBID_DESKTOP = 1;

/** UTF-16 code units with a terminating zero. */
function utf16z(text: string): Uint16Array {
  const units = new Uint16Array(text.length + 1);
  for (let index = 0; index < text.length; index += 1) units[index] = text.charCodeAt(index);
  return units;
}

/**
 * `GetWindowBand`, when user32 exports it. It is not documented: it names the
 * layer of the Z order a window lives in. Every app's window, topmost ones and
 * the box included, is in `ZBID_DESKTOP` (1); the Start menu, search and the
 * other system flyouts are in higher ones that only the system can draw over.
 */
type BandReader = (hwnd: bigint, band: Uint32Array) => boolean;
let bandReader: BandReader | null | undefined;

function windowBand(): BandReader | null {
  if (bandReader !== undefined) return bandReader;
  bandReader = null;
  try {
    const user32Module = kernel32().GetModuleHandleW(ptr(utf16z('user32.dll')));
    if (kernel32().GetProcAddress(user32Module, ptr(new TextEncoder().encode('GetWindowBand\0'))) !== 0n) {
      const { GetWindowBand } = dlopen('user32.dll', { GetWindowBand: { args: [U64, PTR], returns: I32 } }).symbols;
      bandReader = (hwnd, band) => GetWindowBand(hwnd, ptr(band)) !== 0;
    }
  } catch { /* no band: every window reads as an app's */ }
  return bandReader;
}

function frameOf(id: string): { rect: ScreenRect; minimized: boolean; above: boolean } | null {
  try {
    const hwnd = windowOf(id);
    const bounds = physicalPixels(() => frameBounds(hwnd));
    if (bounds === null) return null;
    const band = new Uint32Array(1);
    const above = windowBand()?.(hwnd, band) === true && band[0]! > ZBID_DESKTOP;
    return { rect: { left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }, minimized: user32().IsIconic(hwnd) !== 0, above };
  } catch {
    return null;
  }
}

function mouse(): { pressed: boolean; x: number; y: number } {
  const api = user32();
  // GetAsyncKeyState reads the physical buttons: with them swapped, the primary one is the right.
  const primary = api.GetSystemMetrics(SM_SWAPBUTTON) !== 0 ? VK_RBUTTON : VK_LBUTTON;
  const pressed = (api.GetAsyncKeyState(primary) & 0x8000) !== 0;
  const point = new Int32Array(2);
  physicalPixels(() => api.GetCursorPos(ptr(point)));
  return { pressed, x: point[0]!, y: point[1]! };
}

export async function loadWindowGuide(): Promise<WindowGuide | { unavailable: string }> {
  if (process.platform !== 'win32') return { unavailable: 'the on-screen guide needs Windows' };
  try {
    user32();
    kernel32();
  } catch (error) {
    return { unavailable: `user32 cannot be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    controls: async (id, limit) => {
      const hwnd = windowOf(id);
      if (user32().IsHungAppWindow(hwnd) !== 0) throw new Error('the window is not responding');
      return physicalPixels(() => readControls(hwnd, limit));
    },
    frame: frameOf,
    mouse,
  };
}
