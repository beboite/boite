/**
 * The top-level windows of this desktop and pictures of them, through
 * `bun:ffi`. Windows only; `platform/windows/index.ts` loads it on first use.
 *
 * A picture comes from Windows.Graphics.Capture (WGC) on the calling thread:
 * the window's own DWM surface, so a window hidden behind others still comes
 * out whole. A free-threaded frame pool needs no DispatcherQueue; frames are
 * polled. Where WGC is missing or hands back a black picture, `PrintWindow`
 * with `PW_RENDERFULLCONTENT` draws the window into a DIB instead.
 *
 * Nothing here restores, raises or focuses a window or sends it input: no
 * `ShowWindow`, `SetForegroundWindow` or `SetWindowPos`. Titles are read with
 * `InternalGetWindowText`, which sends no message, and `PrintWindow`, which
 * does, is skipped for a window that is not responding.
 *
 * The WGC half, its COM and Direct3D calls, is in `window-capture-wgc.ts`.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { NativeWindow, WindowCapture, WindowFrames, WindowPixels } from '../types.ts';
import { goneError, isBlank, minimizedError, WindowCaptureError } from '../window-pixels.ts';
import { Capture, closeAndRelease, FIRST_FRAME_MS, forgetDevice, framePixels, message, POLL_MS } from './window-capture-wgc.ts';

// -- Win32 ------------------------------------------------------------------

const U64 = FFIType.u64;
const PTR = FFIType.ptr;
const I32 = FFIType.i32;
const U32 = FFIType.u32;

function loadUser32() {
  return dlopen('user32.dll', {
    FindWindowExW: { args: [U64, U64, PTR, PTR], returns: U64 },
    IsWindow: { args: [U64], returns: I32 },
    IsWindowVisible: { args: [U64], returns: I32 },
    IsIconic: { args: [U64], returns: I32 },
    IsHungAppWindow: { args: [U64], returns: I32 },
    GetWindowLongPtrW: { args: [U64, I32], returns: FFIType.i64 },
    GetWindow: { args: [U64, U32], returns: U64 },
    GetWindowThreadProcessId: { args: [U64, PTR], returns: U32 },
    InternalGetWindowText: { args: [U64, PTR, I32], returns: I32 },
    GetClassNameW: { args: [U64, PTR, I32], returns: I32 },
    GetWindowRect: { args: [U64, PTR], returns: I32 },
    PrintWindow: { args: [U64, U64, U32], returns: I32 },
    GetDC: { args: [U64], returns: U64 },
    ReleaseDC: { args: [U64, U64], returns: I32 },
    SetThreadDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i64 },
  }).symbols;
}

function loadDwm() {
  return dlopen('dwmapi.dll', {
    DwmGetWindowAttribute: { args: [U64, U32, PTR, U32], returns: I32 },
  }).symbols;
}

function loadKernel32() {
  return dlopen('kernel32.dll', {
    OpenProcess: { args: [U32, I32, U32], returns: U64 },
    QueryFullProcessImageNameW: { args: [U64, U32, PTR, PTR], returns: I32 },
    CloseHandle: { args: [U64], returns: I32 },
  }).symbols;
}

function loadGdi32() {
  return dlopen('gdi32.dll', {
    CreateCompatibleDC: { args: [U64], returns: U64 },
    CreateDIBSection: { args: [U64, PTR, U32, PTR, U64, U32], returns: U64 },
    SelectObject: { args: [U64, U64], returns: U64 },
    DeleteObject: { args: [U64], returns: I32 },
    DeleteDC: { args: [U64], returns: I32 },
    GdiFlush: { args: [], returns: I32 },
  }).symbols;
}

let user32Symbols: ReturnType<typeof loadUser32> | null = null;
let dwmSymbols: ReturnType<typeof loadDwm> | null = null;
let kernel32Symbols: ReturnType<typeof loadKernel32> | null = null;
let gdi32Symbols: ReturnType<typeof loadGdi32> | null = null;

const user32 = () => (user32Symbols ??= loadUser32());
const dwm = () => (dwmSymbols ??= loadDwm());
const kernel32 = () => (kernel32Symbols ??= loadKernel32());
const gdi32 = () => (gdi32Symbols ??= loadGdi32());

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80n;
const WS_EX_APPWINDOW = 0x40000n;
const GW_OWNER = 4;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PW_RENDERFULLCONTENT = 2;
/** The main and secondary taskbars: tool windows that are still part of what a person sees. */
const TASKBAR_CLASSES = new Set(['Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
/** `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`: rectangles in physical pixels on every monitor. */
const PER_MONITOR_AWARE_V2 = -4n;

/** The thread reads physical pixels for the length of `run`, then goes back to what it was. */
export function physicalPixels<T>(run: () => T): T {
  const previous = user32().SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
  try {
    return run();
  } finally {
    if (previous !== 0n) user32().SetThreadDpiAwarenessContext(previous);
  }
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectOf(values: Int32Array): Rect {
  return { left: values[0]!, top: values[1]!, right: values[2]!, bottom: values[3]! };
}

/** What a person sees of the window: DWM's frame bounds, without the invisible resize border. */
export function frameBounds(hwnd: bigint): Rect | null {
  const values = new Int32Array(4);
  if (dwm().DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ptr(values), 16) === 0) return rectOf(values);
  if (user32().GetWindowRect(hwnd, ptr(values)) !== 0) return rectOf(values);
  return null;
}

function utf16(buffer: Uint16Array, length: number): string {
  return new TextDecoder('utf-16le').decode(buffer.subarray(0, Math.max(0, length)));
}

function imagePath(pid: number): string {
  const handle = kernel32().OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === 0n) return '';
  try {
    const buffer = new Uint16Array(1024);
    const size = new Uint32Array([buffer.length]);
    if (kernel32().QueryFullProcessImageNameW(handle, 0, ptr(buffer), ptr(size)) === 0) return '';
    return utf16(buffer, size[0]!);
  } finally {
    kernel32().CloseHandle(handle);
  }
}

function listWindows(): NativeWindow[] {
  const api = user32();
  const windows: NativeWindow[] = [];
  const paths = new Map<number, string>();
  const text = new Uint16Array(512);
  const pidOut = new Uint32Array(1);
  const cloaked = new Uint32Array(1);
  physicalPixels(() => {
    for (let hwnd = api.FindWindowExW(0n, 0n, null, null); hwnd !== 0n; hwnd = api.FindWindowExW(0n, hwnd, null, null)) {
      if (api.IsWindowVisible(hwnd) === 0) continue;
      cloaked[0] = 0;
      if (dwm().DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ptr(cloaked), 4) === 0 && cloaked[0] !== 0) continue;
      const exStyle = BigInt(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      const className = utf16(text, api.GetClassNameW(hwnd, ptr(text), text.length));
      // The taskbar is a tool window, but a person sees it and `boite window point` shows them its Start button.
      const taskbar = TASKBAR_CLASSES.has(className);
      if (!taskbar && (exStyle & WS_EX_TOOLWINDOW) !== 0n && (exStyle & WS_EX_APPWINDOW) === 0n) continue;
      if (api.GetWindow(hwnd, GW_OWNER) !== 0n) continue;
      const title = utf16(text, api.InternalGetWindowText(hwnd, ptr(text), text.length));
      const bounds = frameBounds(hwnd);
      const width = bounds === null ? 0 : Math.max(0, bounds.right - bounds.left);
      const height = bounds === null ? 0 : Math.max(0, bounds.bottom - bounds.top);
      if (title === '' && (width === 0 || height === 0)) continue;
      pidOut[0] = 0;
      api.GetWindowThreadProcessId(hwnd, ptr(pidOut));
      const pid = pidOut[0]!;
      let path = paths.get(pid);
      if (path === undefined) {
        path = imagePath(pid);
        paths.set(pid, path);
      }
      windows.push({
        id: hwnd.toString(),
        pid,
        path,
        process: path === '' ? '' : path.slice(path.lastIndexOf('\\') + 1),
        title,
        className,
        width,
        height,
        minimized: api.IsIconic(hwnd) !== 0,
      });
    }
  });
  return windows;
}

/** The HWND an id names, or 0 when it names none. */
function parseWindowId(id: string): bigint {
  if (!/^\d{1,20}$/.test(id)) return 0n;
  const hwnd = BigInt(id);
  return hwnd > 0xffff_ffff_ffff_ffffn ? 0n : hwnd;
}

/** The window behind `id`, or `gone` when it never was one or has closed. */
export function windowOf(id: string): bigint {
  const hwnd = parseWindowId(id);
  if (hwnd === 0n || user32().IsWindow(hwnd) === 0) throw goneError(id);
  return hwnd;
}

/** Throws what a picture of this window cannot get past right now. */
function checkWindow(id: string, hwnd: bigint): void {
  if (user32().IsWindow(hwnd) === 0) throw goneError(id);
  if (user32().IsIconic(hwnd) !== 0) throw minimizedError();
}

// -- PrintWindow --------------------------------------------------------------

/**
 * `PrintWindow(PW_RENDERFULLCONTENT)` into a top-down 32-bit DIB of the whole
 * window rectangle, cut to the frame bounds so the size matches `list`. GDI
 * leaves alpha 0, so every alpha byte is set to 255.
 */
function printWindowPicture(hwnd: bigint): WindowPixels {
  const api = user32();
  const gdi = gdi32();
  if (api.IsHungAppWindow(hwnd) !== 0) throw new Error('PrintWindow: the window is not responding');
  return physicalPixels(() => {
    const values = new Int32Array(4);
    if (api.GetWindowRect(hwnd, ptr(values)) === 0) throw new Error('PrintWindow: GetWindowRect failed');
    const outer = rectOf(values);
    const frame = frameBounds(hwnd) ?? outer;
    const fullWidth = outer.right - outer.left;
    const fullHeight = outer.bottom - outer.top;
    if (fullWidth <= 0 || fullHeight <= 0) throw new Error(`PrintWindow: the window is ${fullWidth}x${fullHeight}`);
    const left = Math.max(0, frame.left - outer.left);
    const top = Math.max(0, frame.top - outer.top);
    const width = Math.min(fullWidth - left, frame.right - frame.left);
    const height = Math.min(fullHeight - top, frame.bottom - frame.top);
    if (width <= 0 || height <= 0) throw new Error(`PrintWindow: the frame is ${width}x${height}`);

    const screen = api.GetDC(0n);
    if (screen === 0n) throw new Error('PrintWindow: GetDC failed');
    let memory = 0n;
    let bitmap = 0n;
    let previous = 0n;
    try {
      memory = gdi.CreateCompatibleDC(screen);
      if (memory === 0n) throw new Error('PrintWindow: CreateCompatibleDC failed');
      // BITMAPINFOHEADER, then one unused RGBQUAD. A negative height is top-down.
      const info = new DataView(new ArrayBuffer(44));
      info.setUint32(0, 40, true);
      info.setInt32(4, fullWidth, true);
      info.setInt32(8, -fullHeight, true);
      info.setUint16(12, 1, true);
      info.setUint16(14, 32, true);
      const bitsOut = new BigUint64Array(1);
      bitmap = gdi.CreateDIBSection(memory, ptr(info), 0, ptr(bitsOut), 0n, 0);
      if (bitmap === 0n || bitsOut[0] === 0n) throw new Error('PrintWindow: CreateDIBSection failed');
      previous = gdi.SelectObject(memory, bitmap);
      if (api.PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT) === 0) throw new Error('PrintWindow failed');
      gdi.GdiFlush();
      const source = new Uint8Array(toArrayBuffer(Number(bitsOut[0]) as unknown as Pointer, 0, fullWidth * fullHeight * 4));
      const bgra = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        const from = ((top + row) * fullWidth + left) * 4;
        bgra.set(source.subarray(from, from + width * 4), row * width * 4);
      }
      for (let at = 3; at < bgra.length; at += 4) bgra[at] = 255;
      return { width, height, bgra, via: 'printwindow' };
    } finally {
      if (previous !== 0n) gdi.SelectObject(memory, previous);
      if (bitmap !== 0n) gdi.DeleteObject(bitmap);
      if (memory !== 0n) gdi.DeleteDC(memory);
      api.ReleaseDC(0n, screen);
    }
  });
}

/** The first frame of a fresh session; WGC always sends one once it starts. */
async function wgcPicture(id: string, hwnd: bigint): Promise<WindowPixels> {
  let capture: Capture | null = null;
  try {
    capture = new Capture(hwnd, 1);
    const deadline = performance.now() + FIRST_FRAME_MS;
    for (;;) {
      const frame = capture.nextFrame();
      if (frame !== null) {
        try {
          return framePixels(frame).pixels;
        } finally {
          closeAndRelease(frame);
        }
      }
      if (performance.now() > deadline) {
        checkWindow(id, hwnd);
        throw new Error(`no frame within ${FIRST_FRAME_MS} ms`);
      }
      await Bun.sleep(POLL_MS);
    }
  } catch (error) {
    forgetDevice(error);
    throw error;
  } finally {
    capture?.close();
  }
}

function isCaptureError(error: unknown): error is WindowCaptureError {
  return error instanceof WindowCaptureError;
}

/** WGC first; PrintWindow when WGC fails or comes out black. Black from both is returned as it is. */
async function capturePicture(id: string): Promise<WindowPixels> {
  const hwnd = windowOf(id);
  checkWindow(id, hwnd);
  let wgc: WindowPixels | null = null;
  let wgcFailure = '';
  try {
    wgc = await wgcPicture(id, hwnd);
    if (!isBlank(wgc)) return wgc;
  } catch (error) {
    if (isCaptureError(error)) throw error;
    wgcFailure = message(error);
  }
  checkWindow(id, hwnd);
  try {
    const printed = printWindowPicture(hwnd);
    if (wgc === null || !isBlank(printed)) return printed;
    return wgc;
  } catch (error) {
    if (wgc !== null) return wgc;
    checkWindow(id, hwnd);
    throw new WindowCaptureError('failed', `capture of window ${id} failed: WGC: ${wgcFailure}; ${message(error)}`);
  }
}

// -- frames -----------------------------------------------------------------

/** How often an open stream takes the newest frame out of the pool, so the pool never fills and drops a change. */
const PUMP_MS = 40;
/**
 * How long `next` waits for a frame already on its way, about one composition,
 * before it answers the previous picture: the pump has kept the newest one.
 */
const CHANGE_WAIT_MS = 20;

/**
 * A capture session left running between pictures. WGC sends a frame only
 * when the window changes, and drops new ones while the pool is full, so a
 * timer keeps the newest frame held and the other buffer free; `next` reads
 * the held frame, or answers the previous picture when nothing changed.
 * With PrintWindow, each `next` is a fresh PrintWindow.
 */
class Frames implements WindowFrames {
  readonly #hwnd: bigint;
  #capture: Capture | null = null;
  #held: Pointer | null = null;
  #read = false;
  #last: WindowPixels | null = null;
  #mode: 'wgc' | 'printwindow' = 'wgc';
  #wgcFailure = '';
  #pump: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();

  readonly #id: string;

  constructor(id: string) {
    this.#id = id;
    // A bad id becomes window 0, which `next` reports as gone.
    this.#hwnd = parseWindowId(id);
  }

  next(): Promise<WindowPixels> {
    const run = this.#queue.then(() => this.#step());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopWgc();
  }

  async #step(): Promise<WindowPixels> {
    if (this.#closed) throw new WindowCaptureError('failed', 'the frames of this window were closed');
    checkWindow(this.#id, this.#hwnd);
    if (this.#mode === 'wgc') {
      try {
        const picture = await this.#wgcStep();
        if (picture !== null) return picture;
      } catch (error) {
        if (isCaptureError(error)) throw error;
        forgetDevice(error);
        this.#wgcFailure = message(error);
        this.#stopWgc();
        this.#mode = 'printwindow';
      }
    }
    if (this.#closed) throw new WindowCaptureError('failed', 'the frames of this window were closed');
    checkWindow(this.#id, this.#hwnd);
    try {
      this.#last = printWindowPicture(this.#hwnd);
      return this.#last;
    } catch (error) {
      checkWindow(this.#id, this.#hwnd);
      const wgc = this.#wgcFailure === '' ? '' : `WGC: ${this.#wgcFailure}; `;
      throw new WindowCaptureError('failed', `capture of window ${this.#id} failed: ${wgc}${message(error)}`);
    }
  }

  /** The newest picture from WGC, or null when this window should go to PrintWindow instead. */
  async #wgcStep(): Promise<WindowPixels | null> {
    if (this.#capture === null) {
      this.#capture = new Capture(this.#hwnd, 2);
      this.#pump = setInterval(() => {
        try { this.#drain(); } catch { /* the next `next` meets the same failure and reports it */ }
      }, PUMP_MS);
      this.#pump.unref?.();
    }
    const wait = this.#last === null ? FIRST_FRAME_MS : CHANGE_WAIT_MS;
    const deadline = performance.now() + wait;
    this.#drain();
    while ((this.#held === null || this.#read) && performance.now() < deadline) {
      await Bun.sleep(POLL_MS);
      if (this.#closed || this.#capture === null) throw new WindowCaptureError('failed', 'the frames of this window were closed');
      this.#drain();
    }
    if (this.#held === null || this.#read) {
      if (this.#last !== null) return this.#last;
      checkWindow(this.#id, this.#hwnd);
      throw new Error(`no frame within ${FIRST_FRAME_MS} ms`);
    }
    const first = this.#last === null;
    const { pixels: picture, content } = framePixels(this.#held);
    this.#read = true;
    if (content.width > 0 && content.height > 0 && (content.width !== this.#capture.width || content.height !== this.#capture.height)) {
      this.#releaseHeld();
      this.#capture.resize(content.width, content.height);
    }
    if (first && isBlank(picture)) {
      // A window WGC sees black (exclusive fullscreen, protected content) may print.
      try {
        const printed = printWindowPicture(this.#hwnd);
        if (!isBlank(printed)) {
          this.#stopWgc();
          this.#mode = 'printwindow';
          this.#last = printed;
          return printed;
        }
      } catch { /* the black picture is the answer; the service reports it */ }
    }
    this.#last = picture;
    return picture;
  }

  /** Keeps only the newest frame in hand, closing the ones it replaces. */
  #drain(): void {
    if (this.#capture === null) return;
    for (let frame = this.#capture.nextFrame(); frame !== null; frame = this.#capture.nextFrame()) {
      this.#releaseHeld();
      this.#held = frame;
      this.#read = false;
    }
  }

  #releaseHeld(): void {
    const frame = this.#held;
    this.#held = null;
    if (frame !== null) closeAndRelease(frame);
  }

  #stopWgc(): void {
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    try { this.#releaseHeld(); } catch { /* the session is closed below either way */ }
    const capture = this.#capture;
    this.#capture = null;
    try { capture?.close(); } catch { /* nothing left to release it with */ }
  }
}

// -- entry --------------------------------------------------------------------

/** The PrintWindow fallback alone, for the test and the bench to compare with WGC. */
export function printWindow(id: string): WindowPixels {
  const hwnd = windowOf(id);
  checkWindow(id, hwnd);
  return printWindowPicture(hwnd);
}

export async function loadWindowCapture(): Promise<WindowCapture | { unavailable: string }> {
  if (process.platform !== 'win32') return { unavailable: 'window capture through user32 needs Windows' };
  try {
    user32();
    dwm();
  } catch (error) {
    return { unavailable: `user32 or dwmapi cannot be loaded: ${message(error)}` };
  }
  return {
    list: async () => listWindows(),
    capture: (id: string) => capturePicture(id),
    frames: (id: string) => new Frames(id),
  };
}
