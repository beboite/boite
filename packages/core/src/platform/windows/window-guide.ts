/**
 * `boite window read`, `point` and `wait-click` on Windows, through `bun:ffi`:
 * the controls of a window (`window-controls.ts`), a box drawn above every
 * window, and the mouse's state. `platform/windows/index.ts` loads it on first
 * use, never at startup.
 *
 * The box is a layered, click-through popup of the core's own thread:
 * `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE |
 * WS_EX_TOOLWINDOW`. It never takes the focus, has no taskbar button, lets
 * every click through to the control under it and has no window procedure of
 * its own (`DefWindowProcW`). It is drawn once into a premultiplied 32-bit DIB
 * and handed to `UpdateLayeredWindow`; moving it is a `SetWindowPos`. A timer
 * pumps its messages, so the system never takes it for a hung window, and puts
 * it back on top of the taskbar, which raises itself when clicked.
 *
 * It belongs to the core and not to an agent: the focus guard sends a window
 * of an agent's process that takes the foreground to the bottom, which also
 * takes it out of the topmost band (`guard-logic.ts`).
 *
 * Every rectangle is in physical pixels: the thread is per-monitor aware
 * (V2) for each call, as `window-capture.ts` does, so a box lands on the
 * control at 100 % and 150 % scaling and on every monitor.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { DrawnPointer, ScreenRect, WindowGuide } from '../types.ts';
import { frameBounds, physicalPixels, windowOf } from './window-capture.ts';
import { readControls } from './window-controls.ts';

const U64 = FFIType.u64;
const PTR = FFIType.ptr;
const I32 = FFIType.i32;
const U32 = FFIType.u32;

function loadUser32() {
  return dlopen('user32.dll', {
    RegisterClassExW: { args: [PTR], returns: FFIType.u16 },
    CreateWindowExW: { args: [U32, PTR, PTR, U32, I32, I32, I32, I32, U64, U64, U64, PTR], returns: U64 },
    DestroyWindow: { args: [U64], returns: I32 },
    ShowWindow: { args: [U64, I32], returns: I32 },
    SetWindowPos: { args: [U64, U64, I32, I32, I32, I32, U32], returns: I32 },
    UpdateLayeredWindow: { args: [U64, U64, PTR, PTR, U64, PTR, U32, PTR, U32], returns: I32 },
    PeekMessageW: { args: [PTR, U64, U32, U32, U32], returns: I32 },
    TranslateMessage: { args: [PTR], returns: I32 },
    DispatchMessageW: { args: [PTR], returns: FFIType.i64 },
    GetDC: { args: [U64], returns: U64 },
    ReleaseDC: { args: [U64, U64], returns: I32 },
    DrawTextW: { args: [U64, PTR, I32, PTR, U32], returns: I32 },
    MonitorFromRect: { args: [PTR, U32], returns: U64 },
    GetMonitorInfoW: { args: [U64, PTR], returns: I32 },
    GetCursorPos: { args: [PTR], returns: I32 },
    GetAsyncKeyState: { args: [I32], returns: FFIType.i16 },
    GetSystemMetrics: { args: [I32], returns: I32 },
    IsWindow: { args: [U64], returns: I32 },
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

function loadGdi32() {
  return dlopen('gdi32.dll', {
    CreateCompatibleDC: { args: [U64], returns: U64 },
    CreateDIBSection: { args: [U64, PTR, U32, PTR, U64, U32], returns: U64 },
    SelectObject: { args: [U64, U64], returns: U64 },
    DeleteObject: { args: [U64], returns: I32 },
    DeleteDC: { args: [U64], returns: I32 },
    GdiFlush: { args: [], returns: I32 },
    CreateFontW: { args: [I32, I32, I32, I32, I32, U32, U32, U32, U32, U32, U32, U32, U32, PTR], returns: U64 },
    SetTextColor: { args: [U64, U32], returns: U32 },
    SetBkMode: { args: [U64, I32], returns: I32 },
    GetTextExtentPoint32W: { args: [U64, PTR, I32, PTR], returns: I32 },
  }).symbols;
}

function loadShcore() {
  return dlopen('shcore.dll', {
    GetDpiForMonitor: { args: [U64, U32, PTR, PTR], returns: I32 },
  }).symbols;
}

let user32Symbols: ReturnType<typeof loadUser32> | null = null;
let kernel32Symbols: ReturnType<typeof loadKernel32> | null = null;
let gdi32Symbols: ReturnType<typeof loadGdi32> | null = null;
let shcoreSymbols: ReturnType<typeof loadShcore> | null = null;
const user32 = () => (user32Symbols ??= loadUser32());
const kernel32 = () => (kernel32Symbols ??= loadKernel32());
const gdi32 = () => (gdi32Symbols ??= loadGdi32());
const shcore = () => (shcoreSymbols ??= loadShcore());

const WS_POPUP = 0x8000_0000;
const WS_EX_LAYERED = 0x0008_0000;
const WS_EX_TRANSPARENT = 0x0000_0020;
const WS_EX_TOPMOST = 0x0000_0008;
const WS_EX_NOACTIVATE = 0x0800_0000;
const WS_EX_TOOLWINDOW = 0x0000_0080;
const SW_SHOWNOACTIVATE = 4;
const SW_HIDE = 0;
const HWND_TOPMOST = 0xffff_ffff_ffff_ffffn;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const ULW_ALPHA = 2;
const PM_REMOVE = 1;
const MONITOR_DEFAULTTONEAREST = 2;
const MDT_EFFECTIVE_DPI = 0;
const DT_CENTER = 0x1;
const DT_VCENTER = 0x4;
const DT_SINGLELINE = 0x20;
const DT_NOPREFIX = 0x800;
const DT_END_ELLIPSIS = 0x8000;
const TRANSPARENT = 1;
const ANTIALIASED_QUALITY = 4;
const FW_SEMIBOLD = 600;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const SM_SWAPBUTTON = 23;

/** How often a shown box pumps its messages and goes back above the taskbar. */
const TICK_MS = 250;
const CLASS_NAME = 'BoiteWindowPointer';

/** The box's colours as premultiplied BGRA: an orange that reads on light and dark, with a dark halo. */
const ACCENT = [0x00, 0x5a, 0xff, 0xff] as const;
const HALO = [0x00, 0x00, 0x00, 0x8c] as const;
/** `COLORREF` of the label's text: white. */
const LABEL_TEXT = 0x00ffffff;

/** UTF-16 code units with a terminating zero, surrogate pairs kept. */
function utf16z(text: string): Uint16Array {
  const units = new Uint16Array(text.length + 1);
  for (let index = 0; index < text.length; index += 1) units[index] = text.charCodeAt(index);
  return units;
}

let classAtom = 0;
let instance = 0n;

/** The window class every box uses, registered once, with `DefWindowProcW` as its procedure. */
function registerClass(): string {
  if (classAtom !== 0) return CLASS_NAME;
  instance = kernel32().GetModuleHandleW(null);
  const user32Module = kernel32().GetModuleHandleW(ptr(utf16z('user32.dll')));
  const procedure = kernel32().GetProcAddress(user32Module, ptr(new TextEncoder().encode('DefWindowProcW\0')));
  if (procedure === 0n) throw new Error('GetProcAddress(DefWindowProcW) failed');
  const name = utf16z(CLASS_NAME);
  const info = new DataView(new ArrayBuffer(80));
  info.setUint32(0, 80, true);
  info.setBigUint64(8, procedure, true);
  info.setBigUint64(24, instance, true);
  info.setBigUint64(64, BigInt(ptr(name)), true);
  classAtom = user32().RegisterClassExW(ptr(info));
  if (classAtom === 0) throw new Error('RegisterClassExW failed');
  return CLASS_NAME;
}

interface Monitor {
  /** The monitor's whole area, physical pixels. */
  area: { left: number; top: number; right: number; bottom: number };
  scale: number;
}

function monitorOf(rect: ScreenRect): Monitor {
  const values = new Int32Array([rect.left, rect.top, rect.left + rect.width, rect.top + rect.height]);
  const monitor = user32().MonitorFromRect(ptr(values), MONITOR_DEFAULTTONEAREST);
  const info = new Int32Array(10);
  info[0] = 40;
  const area = user32().GetMonitorInfoW(monitor, ptr(info)) !== 0
    ? { left: info[1]!, top: info[2]!, right: info[3]!, bottom: info[4]! }
    : { left: -32768, top: -32768, right: 32767, bottom: 32767 };
  const dpiX = new Uint32Array(1);
  const dpiY = new Uint32Array(1);
  let scale = 1;
  try {
    if (shcore().GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, ptr(dpiX), ptr(dpiY)) === 0 && dpiX[0]! > 0) scale = dpiX[0]! / 96;
  } catch { /* no shcore: 100 % */ }
  return { area, scale };
}

/** The picture of one box and where its top-left corner goes on the screen. */
interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The control's box inside the picture. */
  box: { left: number; top: number; right: number; bottom: number };
  stroke: number;
  label: { left: number; top: number; right: number; bottom: number } | null;
}

/** A box `pad` outside the control, and the label above it, or below where the screen's top edge is too close. */
function layout(rect: ScreenRect, label: { width: number; height: number } | null, monitor: Monitor): Layout {
  const scaled = (value: number) => Math.max(1, Math.round(value * monitor.scale));
  const stroke = scaled(3);
  const halo = scaled(1);
  const pad = scaled(4);
  const gap = scaled(4);
  // Kept on the monitor: a control at its edge, like the Start button, still gets all four sides.
  const outer = {
    left: Math.max(monitor.area.left, rect.left - pad - stroke - halo),
    top: Math.max(monitor.area.top, rect.top - pad - stroke - halo),
    right: Math.min(monitor.area.right, rect.left + rect.width + pad + stroke + halo),
    bottom: Math.min(monitor.area.bottom, rect.top + rect.height + pad + stroke + halo),
  };
  let labelRect: Layout['label'] = null;
  if (label !== null) {
    const above = outer.top - gap - label.height >= monitor.area.top;
    const top = above ? outer.top - gap - label.height : outer.bottom + gap;
    let left = outer.left;
    left = Math.min(left, monitor.area.right - label.width);
    left = Math.max(left, monitor.area.left);
    labelRect = { left, top, right: left + label.width, bottom: top + label.height };
  }
  const x = Math.min(outer.left, labelRect?.left ?? outer.left);
  const y = Math.min(outer.top, labelRect?.top ?? outer.top);
  const right = Math.max(outer.right, labelRect?.right ?? outer.right);
  const bottom = Math.max(outer.bottom, labelRect?.bottom ?? outer.bottom);
  const local = (r: { left: number; top: number; right: number; bottom: number }) => ({ left: r.left - x, top: r.top - y, right: r.right - x, bottom: r.bottom - y });
  return { x, y, width: right - x, height: bottom - y, box: local(outer), stroke, label: labelRect && local(labelRect) };
}

function fill(bits: Uint8Array, width: number, area: { left: number; top: number; right: number; bottom: number }, colour: readonly number[]): void {
  for (let row = Math.max(0, area.top); row < area.bottom; row += 1) {
    for (let column = Math.max(0, area.left); column < Math.min(width, area.right); column += 1) {
      const at = (row * width + column) * 4;
      bits[at] = colour[0]!;
      bits[at + 1] = colour[1]!;
      bits[at + 2] = colour[2]!;
      bits[at + 3] = colour[3]!;
    }
  }
}

/** A rectangle's outline `thickness` wide, inside `area`. */
function frame(bits: Uint8Array, width: number, area: { left: number; top: number; right: number; bottom: number }, thickness: number, colour: readonly number[]): void {
  fill(bits, width, { ...area, bottom: area.top + thickness }, colour);
  fill(bits, width, { ...area, top: area.bottom - thickness }, colour);
  fill(bits, width, { ...area, right: area.left + thickness }, colour);
  fill(bits, width, { ...area, left: area.right - thickness }, colour);
}

class Box implements DrawnPointer {
  #hwnd: bigint;
  #label: string;
  #shown = false;
  #timer: ReturnType<typeof setInterval>;
  readonly #message = new Uint8Array(48);

  constructor(rect: ScreenRect, label: string) {
    this.#label = label;
    const className = registerClass();
    this.#hwnd = physicalPixels(() => user32().CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
      ptr(utf16z(className)), ptr(utf16z('Boite pointer')), WS_POPUP, 0, 0, 1, 1, 0n, 0n, instance, null,
    ));
    if (this.#hwnd === 0n) throw new Error('CreateWindowExW failed for the pointer');
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
    this.#timer.unref?.();
    try {
      this.move(rect);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  move(rect: ScreenRect | null): void {
    if (this.#hwnd === 0n) return;
    if (rect === null) {
      if (this.#shown) user32().ShowWindow(this.#hwnd, SW_HIDE);
      this.#shown = false;
      return;
    }
    physicalPixels(() => this.#draw(rect));
    if (!this.#shown) user32().ShowWindow(this.#hwnd, SW_SHOWNOACTIVATE);
    this.#shown = true;
    this.#raise();
  }

  close(): void {
    clearInterval(this.#timer);
    if (this.#hwnd !== 0n) user32().DestroyWindow(this.#hwnd);
    this.#hwnd = 0n;
  }

  #tick(): void {
    if (this.#hwnd === 0n) return;
    const message = ptr(this.#message);
    while (user32().PeekMessageW(message, this.#hwnd, 0, 0, PM_REMOVE) !== 0) {
      user32().TranslateMessage(message);
      user32().DispatchMessageW(message);
    }
    if (this.#shown) this.#raise();
  }

  /** Back on top of the topmost band: the taskbar raises itself above it when clicked. */
  #raise(): void {
    user32().SetWindowPos(this.#hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }

  #draw(rect: ScreenRect): void {
    const api = user32();
    const gdi = gdi32();
    const monitor = monitorOf(rect);
    const screen = api.GetDC(0n);
    if (screen === 0n) throw new Error('GetDC failed for the pointer');
    let memory = 0n, bitmap = 0n, font = 0n, previousBitmap = 0n, previousFont = 0n;
    try {
      memory = gdi.CreateCompatibleDC(screen);
      if (memory === 0n) throw new Error('CreateCompatibleDC failed for the pointer');
      const text = utf16z(this.#label);
      let labelSize: { width: number; height: number } | null = null;
      if (this.#label !== '') {
        font = gdi.CreateFontW(-Math.round(14 * monitor.scale), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, 1, 0, 0, ANTIALIASED_QUALITY, 0, ptr(utf16z('Segoe UI')));
        if (font !== 0n) previousFont = gdi.SelectObject(memory, font);
        const size = new Int32Array(2);
        gdi.GetTextExtentPoint32W(memory, ptr(text), this.#label.length, ptr(size));
        const padX = Math.round(8 * monitor.scale);
        const padY = Math.round(4 * monitor.scale);
        labelSize = { width: Math.min(size[0]! + padX * 2, monitor.area.right - monitor.area.left), height: size[1]! + padY * 2 };
      }
      const shape = layout(rect, labelSize, monitor);
      const info = new DataView(new ArrayBuffer(44));
      info.setUint32(0, 40, true);
      info.setInt32(4, shape.width, true);
      info.setInt32(8, -shape.height, true);
      info.setUint16(12, 1, true);
      info.setUint16(14, 32, true);
      const bitsOut = new BigUint64Array(1);
      bitmap = gdi.CreateDIBSection(memory, ptr(info), 0, ptr(bitsOut), 0n, 0);
      if (bitmap === 0n || bitsOut[0] === 0n) throw new Error('CreateDIBSection failed for the pointer');
      previousBitmap = gdi.SelectObject(memory, bitmap);
      const bits = new Uint8Array(toArrayBuffer(Number(bitsOut[0]) as unknown as Pointer, 0, shape.width * shape.height * 4));
      bits.fill(0);
      const halo = Math.max(1, Math.round(monitor.scale));
      frame(bits, shape.width, shape.box, shape.stroke + 2 * halo, HALO);
      const inner = { left: shape.box.left + halo, top: shape.box.top + halo, right: shape.box.right - halo, bottom: shape.box.bottom - halo };
      frame(bits, shape.width, inner, shape.stroke, ACCENT);
      if (shape.label !== null) {
        fill(bits, shape.width, shape.label, ACCENT);
        gdi.SetBkMode(memory, TRANSPARENT);
        gdi.SetTextColor(memory, LABEL_TEXT);
        const area = new Int32Array([shape.label.left, shape.label.top, shape.label.right, shape.label.bottom]);
        gdi.GdiFlush();
        api.DrawTextW(memory, ptr(text), this.#label.length, ptr(area), DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
        gdi.GdiFlush();
        // GDI clears alpha where it draws text: the label is opaque all over, so it goes back to 255.
        for (let row = shape.label.top; row < shape.label.bottom; row += 1) {
          for (let column = shape.label.left; column < shape.label.right; column += 1) bits[(row * shape.width + column) * 4 + 3] = 255;
        }
      }
      const position = new Int32Array([shape.x, shape.y]);
      const size = new Int32Array([shape.width, shape.height]);
      const origin = new Int32Array([0, 0]);
      const blend = new Uint8Array([0, 0, 255, 1]);
      if (api.UpdateLayeredWindow(this.#hwnd, screen, ptr(position), ptr(size), memory, ptr(origin), 0, ptr(blend), ULW_ALPHA) === 0) {
        throw new Error('UpdateLayeredWindow failed for the pointer');
      }
    } finally {
      if (previousBitmap !== 0n) gdi.SelectObject(memory, previousBitmap);
      if (previousFont !== 0n) gdi.SelectObject(memory, previousFont);
      if (bitmap !== 0n) gdi.DeleteObject(bitmap);
      if (font !== 0n) gdi.DeleteObject(font);
      if (memory !== 0n) gdi.DeleteDC(memory);
      api.ReleaseDC(0n, screen);
    }
  }
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

const ZBID_DESKTOP = 1;

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
    gdi32();
    kernel32();
  } catch (error) {
    return { unavailable: `user32 or gdi32 cannot be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    controls: async (id, limit) => {
      const hwnd = windowOf(id);
      if (user32().IsHungAppWindow(hwnd) !== 0) throw new Error('the window is not responding');
      return physicalPixels(() => readControls(hwnd, limit));
    },
    frame: frameOf,
    point: (rect, label) => new Box(rect, label),
    mouse,
  };
}
