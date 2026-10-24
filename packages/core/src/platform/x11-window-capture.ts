/*
 * The X11 half of `boite window` (docs/windows.md): libX11, and libXcomposite
 * when present, through bun:ffi. `posix.ts` imports this file with the first
 * `boite window` on an X11 session, never at core startup.
 *
 * Structure offsets are Xlib.h's on LP64 Linux (x86_64 and aarch64):
 * - XImage: width 0, height 4, data 16, byte_order 24, bytes_per_line 44,
 *   bits_per_pixel 48, red/green/blue_mask 56/64/72, f.destroy_image 96.
 * - XWindowAttributes (136 bytes): width 8, height 12, border_width 16,
 *   class 40, map_state 92, override_redirect 120.
 * - XErrorEvent: error_code 32.
 * A format-32 property comes back as C longs, 8 bytes each.
 *
 * Every X error lands in one handler that records it instead of the default
 * that exits the process: a window that closed between the list and the
 * capture costs a BadWindow, not the core. A lost X server calls the I/O
 * handlers; libX11 1.7 and later lets the exit handler return, older ones
 * still exit the process there.
 */
import { CFunction, dlopen, FFIType, JSCallback, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import type { NativeWindow, WindowCapture, WindowFrames, WindowPixels } from './types.ts';
import { goneError, minimizedError, WindowCaptureError } from './window-pixels.ts';

const { ptr: P, u64: U64, i64: I64, i32: I32, u32: U32, void: VOID, function: FN } = FFIType;

function loadX11() {
  return dlopen('libX11.so.6', {
    XOpenDisplay: { args: [P], returns: P },
    XCloseDisplay: { args: [P], returns: I32 },
    XDefaultRootWindow: { args: [P], returns: U64 },
    XInternAtom: { args: [P, P, I32], returns: U64 },
    XGetWindowProperty: { args: [P, U64, U64, I64, I64, I32, U64, P, P, P, P, P], returns: I32 },
    XQueryTree: { args: [P, U64, P, P, P, P], returns: I32 },
    XGetWindowAttributes: { args: [P, U64, P], returns: I32 },
    XTranslateCoordinates: { args: [P, U64, U64, I32, I32, P, P, P], returns: I32 },
    XGetImage: { args: [P, U64, I32, I32, U32, U32, U64, I32], returns: P },
    XFreePixmap: { args: [P, U64], returns: I32 },
    XClearArea: { args: [P, U64, I32, I32, U32, U32, I32], returns: I32 },
    XFree: { args: [P], returns: I32 },
    XSync: { args: [P, I32], returns: I32 },
    XSetErrorHandler: { args: [FN], returns: P },
    XSetIOErrorHandler: { args: [FN], returns: P },
  }).symbols;
}

function loadComposite() {
  return dlopen('libXcomposite.so.1', {
    XCompositeQueryExtension: { args: [P, P, P], returns: I32 },
    XCompositeQueryVersion: { args: [P, P, P], returns: I32 },
    XCompositeRedirectWindow: { args: [P, U64, I32], returns: VOID },
    XCompositeUnredirectWindow: { args: [P, U64, I32], returns: VOID },
    XCompositeNameWindowPixmap: { args: [P, U64], returns: U64 },
  }).symbols;
}

type X11 = ReturnType<typeof loadX11>;
type Composite = ReturnType<typeof loadComposite>;

const XA_ATOM = 4, XA_CARDINAL = 6, XA_WINDOW = 33, XA_WM_CLIENT_MACHINE = 36, XA_WM_NAME = 39, XA_WM_CLASS = 67;
const ANY_PROPERTY_TYPE = 0;
const INPUT_OUTPUT = 1, IS_VIEWABLE = 2, ICONIC_STATE = 3;
const Z_PIXMAP = 2;
const ALL_PLANES = 0xffff_ffff_ffff_ffffn;
const COMPOSITE_REDIRECT_AUTOMATIC = 0;
/** How long a window just redirected gets to paint what was covered before the first read. */
const REDIRECT_SETTLE_MS = 100;

const pointer = (value: number | bigint | null) => Number(value ?? 0) as Pointer;

let x11: X11 | null = null;
let composite: Composite | false | null = null;
/** The error code of the last X error, reset before each checked request. */
let failed = 0;
const lost = new Set<number>();
/** Kept for the life of the process: libX11 holds their addresses. */
const callbacks: JSCallback[] = [];
const destroyers = new Map<number, CallableFunction>();
let shared: X11WindowCapture | null = null;

function installHandlers(lib: X11): void {
  if (callbacks.length) return;
  const onError = new JSCallback((_display: number, event: number) => {
    failed = read.u8(event, 32) || 1;
    return 0;
  }, { args: [P, P], returns: I32 });
  const onIoError = new JSCallback((display: number) => {
    lost.add(Number(display));
    return 0;
  }, { args: [P], returns: I32 });
  callbacks.push(onError, onIoError);
  lib.XSetErrorHandler(onError);
  lib.XSetIOErrorHandler(onIoError);
}

/** libX11 1.7 and later: an I/O error leaves the display unusable instead of exiting. */
function keepAliveOnIoError(display: Pointer): void {
  try {
    const { XSetIOErrorExitHandler } = dlopen('libX11.so.6', {
      XSetIOErrorExitHandler: { args: [P, FN, P], returns: VOID },
    }).symbols;
    const onExit = new JSCallback((lostDisplay: number) => { lost.add(Number(lostDisplay)); }, { args: [P, P], returns: VOID });
    callbacks.push(onExit);
    XSetIOErrorExitHandler(display, onExit, null);
  } catch {
    // An older libX11 exits the process when the X server goes away.
  }
}

function openComposite(display: Pointer): Composite | null {
  if (composite === null) {
    try { composite = loadComposite(); } catch { composite = false; }
  }
  if (composite === false) return null;
  const first = new Int32Array(1), second = new Int32Array(1);
  if (!composite.XCompositeQueryExtension(display, first, second)) return null;
  // NameWindowPixmap arrived in 0.2.
  const major = new Int32Array([0]), minor = new Int32Array([4]);
  if (!composite.XCompositeQueryVersion(display, major, minor)) return null;
  return major[0]! > 0 || minor[0]! >= 2 ? composite : null;
}

function destroyImage(lib: X11, image: Pointer): void {
  // XDestroyImage is a macro calling the image's own destroy_image.
  const at = read.ptr(image, 96);
  if (!at) {
    const data = read.ptr(image, 16);
    if (data) lib.XFree(pointer(data));
    lib.XFree(image);
    return;
  }
  let destroy = destroyers.get(at);
  if (!destroy) {
    destroy = CFunction({ ptr: pointer(at), args: [P], returns: I32 });
    destroyers.set(at, destroy);
  }
  destroy(image);
}

/** What `XGetImage` says about its pixels. */
export interface XImageLayout {
  width: number;
  height: number;
  bytesPerLine: number;
  bitsPerPixel: number;
  /** `byte_order` is MSBFirst. */
  msbFirst: boolean;
  red: number;
  green: number;
  blue: number;
}

function channel(mask: number): { shift: number; max: number } {
  if (mask === 0) return { shift: 0, max: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  return { shift, max: mask >>> shift };
}

/** A ZPixmap's rows, padded and in the visual's byte order, as BGRA rows from the top with alpha 255. */
export function ximageToBgra(layout: XImageLayout, data: Uint8Array): Uint8Array {
  const { width, height, bytesPerLine, bitsPerPixel, msbFirst } = layout;
  const bytes = bitsPerPixel / 8;
  if (bytes !== 2 && bytes !== 3 && bytes !== 4) {
    throw new WindowCaptureError('failed', `X11 image has ${bitsPerPixel} bits a pixel: Boite reads 16, 24 and 32`);
  }
  if (bytesPerLine < width * bytes || data.length < bytesPerLine * height) {
    throw new WindowCaptureError('failed', 'X11 image holds fewer bytes than its size');
  }
  const out = new Uint8Array(width * height * 4);
  if (bytes === 4 && !msbFirst && layout.red === 0xff0000 && layout.green === 0xff00 && layout.blue === 0xff) {
    // Already B, G, R, X in memory.
    for (let y = 0; y < height; y++) out.set(data.subarray(y * bytesPerLine, y * bytesPerLine + width * 4), y * width * 4);
    for (let at = 3; at < out.length; at += 4) out[at] = 255;
    return out;
  }
  const [blue, green, red] = [layout.blue, layout.green, layout.red].map(channel) as [ReturnType<typeof channel>, ReturnType<typeof channel>, ReturnType<typeof channel>];
  const scale = (value: number, { shift, max }: { shift: number; max: number }) =>
    max === 0 ? 0 : Math.round((((value >>> shift) & max) * 255) / max);
  let to = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * bytesPerLine + x * bytes;
      let value = 0;
      for (let k = 0; k < bytes; k++) {
        value = msbFirst ? (value << 8) | data[at + k]! : value | (data[at + k]! << (8 * k));
      }
      value >>>= 0;
      out[to++] = scale(value, blue);
      out[to++] = scale(value, green);
      out[to++] = scale(value, red);
      out[to++] = 255;
    }
  }
  return out;
}

interface Attributes {
  width: number;
  height: number;
  border: number;
  inputOutput: boolean;
  viewable: boolean;
  overrideRedirect: boolean;
  /** The window's visual masks: an XImage read from a pixmap has none of its own. */
  masks: Pick<XImageLayout, 'red' | 'green' | 'blue'> | null;
}

interface Property {
  type: number;
  format: number;
  bytes: Uint8Array;
}

function longs(property: Property): number[] {
  if (property.format !== 32) return [];
  const view = new DataView(property.bytes.buffer, property.bytes.byteOffset, property.bytes.byteLength);
  return Array.from({ length: property.bytes.byteLength / 8 }, (_, index) => Number(view.getBigUint64(index * 8, true)));
}

function text(property: Property | null, utf8Type: number): string | null {
  if (!property || property.format !== 8) return null;
  const decoder = new TextDecoder(property.type === utf8Type ? 'utf-8' : 'latin1');
  return decoder.decode(property.bytes).replace(/\0+$/, '');
}

/** A Visual's red, green and blue masks (LP64: ext_data, visualid, class, then the masks from byte 24). */
function visualMasks(visual: bigint): Attributes['masks'] {
  if (!visual) return null;
  const at = pointer(visual);
  return { red: Number(read.u64(at, 24)), green: Number(read.u64(at, 32)), blue: Number(read.u64(at, 40)) };
}

/** Whether WM_CLIENT_MACHINE names this host, short or fully qualified. */
function thisHost(machine: string): boolean {
  const [a, b] = [machine.toLowerCase(), hostname().toLowerCase()];
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function executable(pid: number): string {
  if (pid <= 0) return '';
  try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ''; }
}

const lostError = () => new WindowCaptureError('failed', 'the connection to the X server was lost');

export class X11WindowCapture implements WindowCapture {
  private readonly root: number;
  private readonly atoms: Record<'clientList' | 'pid' | 'netName' | 'utf8' | 'state' | 'hidden' | 'wmState', number>;
  /** Windows this connection redirected, with how many captures hold each. */
  private readonly redirects = new Map<number, number>();
  private closed = false;

  constructor(private readonly lib: X11, private readonly display: Pointer, private readonly composite: Composite | null) {
    this.root = Number(lib.XDefaultRootWindow(display));
    const atom = (name: string) => Number(lib.XInternAtom(display, Buffer.from(`${name}\0`), 0));
    this.atoms = {
      clientList: atom('_NET_CLIENT_LIST'),
      pid: atom('_NET_WM_PID'),
      netName: atom('_NET_WM_NAME'),
      utf8: atom('UTF8_STRING'),
      state: atom('_NET_WM_STATE'),
      hidden: atom('_NET_WM_STATE_HIDDEN'),
      wmState: atom('WM_STATE'),
    };
  }

  /** Whether the display still answers; a lost one is never used again. */
  get alive(): boolean {
    return !this.closed && !lost.has(Number(this.display));
  }

  async list(): Promise<NativeWindow[]> {
    this.assertAlive();
    const managed = this.property(this.root, this.atoms.clientList, XA_WINDOW);
    const ids = managed ? longs(managed) : this.topLevels();
    const windows: NativeWindow[] = [];
    for (const window of ids) {
      const attributes = this.attributes(window);
      // Closed since the window manager listed it.
      if (!attributes) continue;
      // No window manager: what a person sees is every mapped child of the root but popups.
      if (!managed && (!attributes.inputOutput || !attributes.viewable || attributes.overrideRedirect)) continue;
      const pidProperty = this.property(window, this.atoms.pid, XA_CARDINAL);
      // _NET_WM_PID is a process of the host in WM_CLIENT_MACHINE: a window forwarded from another
      // machine (ssh -X) has no program here, and the service refuses a window with no path.
      const machine = text(this.property(window, XA_WM_CLIENT_MACHINE, ANY_PROPERTY_TYPE), this.atoms.utf8);
      const pid = (!machine || thisHost(machine)) ? ((pidProperty && longs(pidProperty)[0]) || 0) : 0;
      const path = executable(pid);
      const title = text(this.property(window, this.atoms.netName, this.atoms.utf8), this.atoms.utf8)
        ?? text(this.property(window, XA_WM_NAME, ANY_PROPERTY_TYPE), this.atoms.utf8) ?? '';
      // "instance\0class\0"
      const [instance, className] = (text(this.property(window, XA_WM_CLASS, ANY_PROPERTY_TYPE), this.atoms.utf8) ?? '').split('\0');
      windows.push({
        id: String(window),
        pid,
        path,
        process: path ? basename(path) : '',
        title,
        className: className || instance || '',
        width: attributes.width,
        height: attributes.height,
        // A window manager unmaps what it iconifies, and what sits on another workspace.
        minimized: this.hidden(window) || (managed !== null && !attributes.viewable),
      });
    }
    this.assertAlive();
    return windows;
  }

  capture(id: string): Promise<WindowPixels> {
    return this.grab(id, null);
  }

  frames(id: string): WindowFrames {
    const held = new Set<number>();
    let closed = false;
    return {
      next: () => closed ? Promise.reject(new WindowCaptureError('failed', 'these frames are closed')) : this.grab(id, held),
      close: () => {
        if (closed) return;
        closed = true;
        for (const window of held) this.unredirect(window);
        held.clear();
      },
    };
  }

  /** Closes this connection; a later `loadX11WindowCapture` opens a new one. */
  close(): void {
    if (this.closed) return;
    for (const window of [...this.redirects.keys()]) {
      this.redirects.set(window, 1);
      this.unredirect(window);
    }
    this.closed = true;
    if (shared === this) shared = null;
    if (!lost.has(Number(this.display))) this.lib.XCloseDisplay(this.display);
  }

  /**
   * One picture. With Composite, the window is redirected to its own pixmap,
   * which holds its pixels even under another window; `held` keeps the
   * redirect for the next frame. Without it, X11 gives what is on screen in
   * the window's place, another window's pixels included.
   */
  private async grab(id: string, held: Set<number> | null): Promise<WindowPixels> {
    const window = this.viewable(id).window;
    let redirected = held?.has(window) ?? false;
    let fresh = false;
    if (!redirected && this.composite) {
      fresh = !this.redirects.has(window);
      redirected = this.redirect(window);
      if (redirected) held?.add(window);
    }
    try {
      if (redirected && fresh) await Bun.sleep(REDIRECT_SETTLE_MS);
      const { attributes } = this.viewable(id);
      return (redirected && this.fromPixmap(window, attributes)) || this.fromScreen(id, window, attributes);
    } finally {
      if (redirected && !held) this.unredirect(window);
    }
  }

  private viewable(id: string): { window: number; attributes: Attributes } {
    this.assertAlive();
    if (!/^\d{1,10}$/.test(id) || Number(id) === 0 || Number(id) > 0xffff_ffff) throw goneError(id);
    const window = Number(id);
    const attributes = this.attributes(window);
    if (!attributes) {
      this.assertAlive();
      throw goneError(id);
    }
    if (!attributes.viewable || this.hidden(window)) throw minimizedError();
    if (attributes.width <= 0 || attributes.height <= 0) throw new WindowCaptureError('failed', `window ${id} has no size`);
    return { window, attributes };
  }

  private fromPixmap(window: number, attributes: Attributes): WindowPixels | null {
    const composite = this.composite!;
    failed = 0;
    const pixmap = Number(composite.XCompositeNameWindowPixmap(this.display, window));
    this.lib.XSync(this.display, 0);
    if (failed || !pixmap) return null;
    try {
      // The pixmap includes the border; the window's own pixels start inside it.
      const image = this.image(pixmap, attributes.border, attributes.border, attributes.width, attributes.height, attributes.masks);
      return image && { ...image, via: 'x11-composite' };
    } finally {
      this.lib.XFreePixmap(this.display, pixmap);
      this.lib.XSync(this.display, 0);
      failed = 0;
    }
  }

  /** XGetImage refuses a rectangle past the screen's edge: read the part on screen and leave the rest black. */
  private fromScreen(id: string, window: number, attributes: Attributes): WindowPixels {
    const screen = this.attributes(this.root);
    const x = new Int32Array(1), y = new Int32Array(1), child = new BigUint64Array(1);
    failed = 0;
    if (!screen || !this.lib.XTranslateCoordinates(this.display, window, this.root, 0, 0, x, y, child) || failed) {
      this.assertAlive();
      throw goneError(id);
    }
    const { width, height } = attributes;
    const left = Math.max(0, -x[0]!), top = Math.max(0, -y[0]!);
    const right = Math.min(width, screen.width - x[0]!), bottom = Math.min(height, screen.height - y[0]!);
    if (right <= left || bottom <= top) {
      throw new WindowCaptureError('failed', `window ${id} is off the screen, and without the X Composite extension only what is on screen can be read`);
    }
    const part = this.image(window, left, top, right - left, bottom - top);
    if (!part) {
      this.assertAlive();
      if (!this.attributes(window)) throw goneError(id);
      throw new WindowCaptureError('failed', `XGetImage refused window ${id} (X error ${failed})`);
    }
    if (part.width === width && part.height === height) return { ...part, via: 'x11' };
    const bgra = new Uint8Array(width * height * 4);
    for (let at = 3; at < bgra.length; at += 4) bgra[at] = 255;
    for (let row = 0; row < part.height; row++) {
      bgra.set(part.bgra.subarray(row * part.width * 4, (row + 1) * part.width * 4), ((top + row) * width + left) * 4);
    }
    return { width, height, bgra, via: 'x11' };
  }

  private image(drawable: number, x: number, y: number, width: number, height: number, masks: Attributes['masks'] = null): { width: number; height: number; bgra: Uint8Array } | null {
    failed = 0;
    const image = pointer(this.lib.XGetImage(this.display, drawable, x, y, width, height, ALL_PLANES, Z_PIXMAP));
    if (!image) return null;
    try {
      if (failed) return null;
      const layout: XImageLayout = {
        width: read.i32(image, 0),
        height: read.i32(image, 4),
        bytesPerLine: read.i32(image, 44),
        bitsPerPixel: read.i32(image, 48),
        msbFirst: read.i32(image, 24) === 1,
        red: Number(read.u64(image, 56)),
        green: Number(read.u64(image, 64)),
        blue: Number(read.u64(image, 72)),
      };
      // A pixmap has no visual, so Xlib leaves its masks at 0: use the window's.
      if (masks && layout.red === 0 && layout.green === 0 && layout.blue === 0) Object.assign(layout, masks);
      const data = read.ptr(image, 16);
      if (!data || layout.bytesPerLine * layout.height === 0) return null;
      const bytes = new Uint8Array(toArrayBuffer(pointer(data), 0, layout.bytesPerLine * layout.height));
      return { width: layout.width, height: layout.height, bgra: ximageToBgra(layout, bytes) };
    } finally {
      destroyImage(this.lib, image);
    }
  }

  private redirect(window: number): boolean {
    const count = this.redirects.get(window) ?? 0;
    if (count === 0) {
      failed = 0;
      this.composite!.XCompositeRedirectWindow(this.display, window, COMPOSITE_REDIRECT_AUTOMATIC);
      this.lib.XSync(this.display, 0);
      if (failed) {
        failed = 0;
        return false;
      }
      // The new pixmap holds nothing where the window was covered, and the server
      // exposes nothing by itself: ask for the background and an Expose, so the
      // app paints the whole window into it during the settle.
      this.lib.XClearArea(this.display, window, 0, 0, 0, 0, 1);
      this.lib.XSync(this.display, 0);
      failed = 0;
    }
    this.redirects.set(window, count + 1);
    return true;
  }

  private unredirect(window: number): void {
    const count = this.redirects.get(window) ?? 0;
    if (count > 1) {
      this.redirects.set(window, count - 1);
      return;
    }
    this.redirects.delete(window);
    if (count === 0 || !this.alive) return;
    // A window closed meanwhile answers BadWindow, which the handler swallows.
    this.composite!.XCompositeUnredirectWindow(this.display, window, COMPOSITE_REDIRECT_AUTOMATIC);
    this.lib.XSync(this.display, 0);
    failed = 0;
  }

  private topLevels(): number[] {
    const root = new BigUint64Array(1), parent = new BigUint64Array(1), children = new BigUint64Array(1), count = new Uint32Array(1);
    failed = 0;
    if (!this.lib.XQueryTree(this.display, this.root, root, parent, children, count) || failed) return [];
    const at = pointer(children[0]!);
    if (!at) return [];
    try {
      const view = new DataView(toArrayBuffer(at, 0, count[0]! * 8));
      return Array.from({ length: count[0]! }, (_, index) => Number(view.getBigUint64(index * 8, true)));
    } finally {
      this.lib.XFree(at);
    }
  }

  private attributes(window: number): Attributes | null {
    const buffer = new Uint8Array(136);
    failed = 0;
    if (!this.lib.XGetWindowAttributes(this.display, window, buffer) || failed) return null;
    const view = new DataView(buffer.buffer);
    return {
      width: view.getInt32(8, true),
      height: view.getInt32(12, true),
      border: view.getInt32(16, true),
      inputOutput: view.getInt32(40, true) === INPUT_OUTPUT,
      viewable: view.getInt32(92, true) === IS_VIEWABLE,
      overrideRedirect: view.getInt32(120, true) !== 0,
      masks: visualMasks(view.getBigUint64(24, true)),
    };
  }

  /** `_NET_WM_STATE_HIDDEN`, or an ICCCM IconicState. */
  private hidden(window: number): boolean {
    const state = this.property(window, this.atoms.state, XA_ATOM);
    if (state && longs(state).includes(this.atoms.hidden)) return true;
    const wmState = this.property(window, this.atoms.wmState, this.atoms.wmState);
    return wmState !== null && longs(wmState)[0] === ICONIC_STATE;
  }

  private property(window: number, atom: number, type: number): Property | null {
    const actualType = new BigUint64Array(1), actualFormat = new Int32Array(1), items = new BigUint64Array(1);
    const after = new BigUint64Array(1), data = new BigUint64Array(1);
    failed = 0;
    // 64k longs: 256 KB of text, or 64k window ids.
    const status = this.lib.XGetWindowProperty(this.display, window, atom, 0, 65_536, 0, type, actualType, actualFormat, items, after, data);
    const at = pointer(data[0]!);
    try {
      if (status !== 0 || failed || !at || actualType[0] === 0n) return null;
      const format = actualFormat[0]!;
      const length = Number(items[0]!) * (format === 32 ? 8 : format / 8);
      const bytes = length > 0 ? new Uint8Array(toArrayBuffer(at, 0, length)).slice() : new Uint8Array();
      return { type: Number(actualType[0]!), format, bytes };
    } finally {
      if (at) this.lib.XFree(at);
    }
  }

  private assertAlive(): void {
    if (lost.has(Number(this.display))) {
      if (shared === this) shared = null;
      throw lostError();
    }
    if (this.closed) throw new WindowCaptureError('failed', 'this X11 window capture is closed');
  }
}

/**
 * A new connection to the X server `DISPLAY` names, or why there is none.
 * `composite: false` reads the screen even where the Composite extension
 * exists, as the test of that path does.
 */
export function openX11WindowCapture(options: { composite?: boolean } = {}): X11WindowCapture | { unavailable: string } {
  let lib: X11;
  try {
    lib = x11 ??= loadX11();
  } catch (error) {
    return { unavailable: `libX11.so.6 could not be loaded (${error instanceof Error ? error.message : String(error)}): install libx11-6 to capture X11 windows` };
  }
  installHandlers(lib);
  const display = pointer(lib.XOpenDisplay(null));
  if (!display) {
    return { unavailable: `XOpenDisplay could not open the X display ${process.env.DISPLAY ?? ''}: the X server is not running or refuses this user (xauth)` };
  }
  keepAliveOnIoError(display);
  return new X11WindowCapture(lib, display, options.composite === false ? null : openComposite(display));
}

/** The core's one connection, opened on first use and kept until the X server goes away. */
export function loadX11WindowCapture(): WindowCapture | { unavailable: string } {
  if (shared?.alive) return shared;
  const opened = openX11WindowCapture();
  if (opened instanceof X11WindowCapture) shared = opened;
  return opened;
}
