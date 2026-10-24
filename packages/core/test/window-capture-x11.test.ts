import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dlopen, FFIType } from 'bun:ffi';
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { createPosixPlatform } from '../src/platform/posix.ts';
import type { WindowCapture, WindowPixels } from '../src/platform/types.ts';
import { isBlank } from '../src/platform/window-pixels.ts';
import { openX11WindowCapture, X11WindowCapture, ximageToBgra } from '../src/platform/x11-window-capture.ts';
import { rejection } from './settle.ts';

/** The `WindowCaptureError.code` a capture rejected with. */
const failure = async (promise: Promise<unknown>) => ((await rejection(promise)).reason as { code?: string }).code;

test('X11 pixels of every byte order, depth and row padding come out as BGRA rows', () => {
  const standard = { red: 0xff0000, green: 0xff00, blue: 0xff };
  // 32 bits, LSBFirst, each row padded to 8 bytes.
  expect([...ximageToBgra({ width: 1, height: 2, bytesPerLine: 8, bitsPerPixel: 32, msbFirst: false, ...standard },
    Uint8Array.of(0x33, 0x22, 0x11, 0, 9, 9, 9, 9, 0x66, 0x55, 0x44, 0, 9, 9, 9, 9))])
    .toEqual([0x33, 0x22, 0x11, 255, 0x66, 0x55, 0x44, 255]);
  // 32 bits, MSBFirst, a 4-byte pad after two pixels.
  expect([...ximageToBgra({ width: 2, height: 1, bytesPerLine: 12, bitsPerPixel: 32, msbFirst: true, ...standard },
    Uint8Array.of(0, 0x11, 0x22, 0x33, 0, 0x44, 0x55, 0x66, 9, 9, 9, 9))])
    .toEqual([0x33, 0x22, 0x11, 255, 0x66, 0x55, 0x44, 255]);
  // 16 bits RGB565, LSBFirst: full red, then full green.
  expect([...ximageToBgra({ width: 2, height: 1, bytesPerLine: 4, bitsPerPixel: 16, msbFirst: false, red: 0xf800, green: 0x07e0, blue: 0x1f },
    Uint8Array.of(0x00, 0xf8, 0xe0, 0x07))])
    .toEqual([0, 0, 255, 255, 0, 255, 0, 255]);
});

const { ptr: P, u64: U64, i32: I32, u32: U32 } = FFIType;

function loadTestX11() {
  return dlopen('libX11.so.6', {
    XOpenDisplay: { args: [P], returns: P },
    XCloseDisplay: { args: [P], returns: I32 },
    XDefaultRootWindow: { args: [P], returns: U64 },
    XDefaultDepth: { args: [P, I32], returns: I32 },
    XCreateSimpleWindow: { args: [P, U64, I32, I32, U32, U32, U32, U64, U64], returns: U64 },
    XInternAtom: { args: [P, P, I32], returns: U64 },
    XChangeProperty: { args: [P, U64, U64, U64, I32, I32, P, I32], returns: I32 },
    XStoreName: { args: [P, U64, P], returns: I32 },
    XMapWindow: { args: [P, U64], returns: I32 },
    XUnmapWindow: { args: [P, U64], returns: I32 },
    XDestroyWindow: { args: [P, U64], returns: I32 },
    XGetWindowAttributes: { args: [P, U64, P], returns: I32 },
    XSync: { args: [P, I32], returns: I32 },
  }).symbols;
}

function hasComposite(): boolean {
  try {
    dlopen('libXcomposite.so.1', { XCompositeQueryExtension: { args: [P, P, P], returns: I32 } }).close();
    return true;
  } catch {
    return false;
  }
}

const pixel = (picture: WindowPixels, x: number, y: number) => {
  const at = (y * picture.width + x) * 4;
  return [picture.bgra[at], picture.bgra[at + 1], picture.bgra[at + 2]];
};

const BLUE = 0x3366cc, RED = 0xcc3333, GREEN = 0x33cc66, GREY = 0x808080;
const asBgr = (rgb: number) => [rgb & 0xff, (rgb >> 8) & 0xff, (rgb >> 16) & 0xff];

describe.skipIf(process.platform !== 'linux' || !process.env.DISPLAY)('X11 window capture under the test\'s own windows', () => {
  let x11: ReturnType<typeof loadTestX11>;
  let display: ReturnType<ReturnType<typeof loadTestX11>['XOpenDisplay']>;
  let root = 0, rootWidth = 0;
  const made: number[] = [];
  let platformCapture: WindowCapture;
  let screenOnly: X11WindowCapture;
  let covered = 0, cover = 0, edge = 0;

  const attributes = (window: number) => {
    const buffer = new Uint8Array(136);
    if (!x11.XGetWindowAttributes(display, window, buffer)) return null;
    const view = new DataView(buffer.buffer);
    return { width: view.getInt32(8, true), viewable: view.getInt32(92, true) === 2 };
  };

  async function makeWindow(x: number, y: number, width: number, height: number, rgb: number, title: string): Promise<number> {
    const window = Number(x11.XCreateSimpleWindow(display, root, x, y, width, height, 0, 0, rgb));
    made.push(window);
    const atom = (name: string) => x11.XInternAtom(display, Buffer.from(`${name}\0`), 0);
    x11.XChangeProperty(display, window, atom('_NET_WM_PID'), 6, 32, 0, BigInt64Array.of(BigInt(process.pid)), 1);
    const name = Buffer.from(title);
    x11.XChangeProperty(display, window, atom('_NET_WM_NAME'), atom('UTF8_STRING'), 8, 0, name, name.length);
    const wmClass = Buffer.from('boite-test\0BoiteTest\0');
    x11.XChangeProperty(display, window, 67, 31, 8, 0, wmClass, wmClass.length);
    x11.XStoreName(display, window, Buffer.from('boite test\0'));
    x11.XMapWindow(display, window);
    x11.XSync(display, 0);
    for (let tries = 0; !attributes(window)?.viewable; tries++) {
      if (tries > 100) throw new Error(`window ${window} (${title}) never became viewable`);
      await Bun.sleep(20);
    }
    return window;
  }

  beforeAll(async () => {
    x11 = loadTestX11();
    display = x11.XOpenDisplay(null);
    if (!display) throw new Error(`the test cannot open DISPLAY=${process.env.DISPLAY}`);
    root = Number(x11.XDefaultRootWindow(display));
    rootWidth = attributes(root)!.width;
    console.log(`X11 test: DISPLAY=${process.env.DISPLAY} root ${root} width ${rootWidth} depth ${x11.XDefaultDepth(display, 0)} composite library ${hasComposite()}`);
    covered = await makeWindow(50, 50, 200, 150, BLUE, 'Boîte covered');
    cover = await makeWindow(50, 50, 200, 150, RED, 'Boîte cover');
    // Half past the right edge of the screen.
    edge = await makeWindow(rootWidth - 50, 300, 100, 80, GREEN, 'Boîte edge');
    const loaded = await createPosixPlatform('linux', null).windowCapture!();
    if ('unavailable' in loaded) throw new Error(`the platform refused: ${loaded.unavailable}`);
    platformCapture = loaded;
    const opened = openX11WindowCapture({ composite: false });
    if ('unavailable' in opened) throw new Error(`no screen-only capture: ${opened.unavailable}`);
    screenOnly = opened;
  });

  afterAll(() => {
    if (x11 && display) {
      for (const window of made) x11.XDestroyWindow(display, window);
      x11.XSync(display, 0);
      x11.XCloseDisplay(display);
    }
    screenOnly?.close();
    if (platformCapture instanceof X11WindowCapture) platformCapture.close();
  });

  test('lists the test\'s window with its pid, executable, title, class and size', async () => {
    const windows = await platformCapture.list();
    const found = windows.find(window => window.id === String(covered));
    if (!found) throw new Error(`window ${covered} not listed; listed: ${JSON.stringify(windows)}`);
    const path = readlinkSync('/proc/self/exe');
    expect(found).toEqual({
      id: String(covered),
      pid: process.pid,
      path,
      process: basename(path),
      title: 'Boîte covered',
      className: 'BoiteTest',
      width: 200,
      height: 150,
      minimized: false,
    });
  });

  test('a window forwarded from another host (ssh -X) gets no pid or executable from this /proc', async () => {
    const forwarded = await makeWindow(400, 50, 60, 40, GREEN, 'Boîte forwarded');
    const elsewhere = Buffer.from('elsewhere.invalid');
    x11.XChangeProperty(display, forwarded, 36, 31, 8, 0, elsewhere, elsewhere.length);
    const here = Buffer.from(hostname());
    x11.XChangeProperty(display, covered, 36, 31, 8, 0, here, here.length);
    x11.XSync(display, 0);
    const windows = await platformCapture.list();
    expect(windows.find(window => window.id === String(forwarded))).toMatchObject({ pid: 0, path: '', process: '' });
    expect(windows.find(window => window.id === String(covered))).toMatchObject({ pid: process.pid, path: readlinkSync('/proc/self/exe') });
  });
  test('captures a covered window at its size, with its own pixels when Composite is there', async () => {
    const picture = await platformCapture.capture(String(covered));
    const seen = { via: picture.via, width: picture.width, height: picture.height, bytes: picture.bgra.length, centre: pixel(picture, 100, 75), blank: isBlank(picture) };
    console.log(`X11 test: covered window ${JSON.stringify(seen)}`);
    expect({ width: seen.width, height: seen.height, bytes: seen.bytes, blank: seen.blank }).toEqual({ width: 200, height: 150, bytes: 200 * 150 * 4, blank: false });
    if (hasComposite()) expect({ via: seen.via, centre: seen.centre }).toEqual({ via: 'x11-composite', centre: asBgr(BLUE) });
  });

  test('frames repeat the capture, and close twice without throwing', async () => {
    const frames = platformCapture.frames(String(covered));
    const first = await frames.next();
    const second = await frames.next();
    expect([first.width, first.height, second.width, second.height]).toEqual([200, 150, 200, 150]);
    expect(pixel(second, 100, 75)).toEqual(pixel(first, 100, 75));
    frames.close();
    frames.close();
    expect(await failure(frames.next())).toBe('failed');
  });

  test('without Composite, reads the on-screen part of a window past the edge and leaves the rest black', async () => {
    const picture = await screenOnly.capture(String(edge));
    const seen = { via: picture.via, width: picture.width, height: picture.height, onScreen: pixel(picture, 10, 40), offScreen: pixel(picture, 90, 40) };
    console.log(`X11 test: edge window ${JSON.stringify(seen)}`);
    expect(seen).toEqual({ via: 'x11', width: 100, height: 80, onScreen: asBgr(GREEN), offScreen: [0, 0, 0] });
  });

  test('an unmapped window reads as minimized (Xvfb runs no window manager to iconify one)', async () => {
    const window = await makeWindow(400, 400, 60, 40, GREY, 'Boîte unmapped');
    x11.XUnmapWindow(display, window);
    x11.XSync(display, 0);
    expect(await failure(platformCapture.capture(String(window)))).toBe('minimized');
    expect(await failure(screenOnly.capture(String(window)))).toBe('minimized');
    expect((await platformCapture.list()).some(listed => listed.id === String(window))).toBe(false);
  });

  test('a destroyed window, or an id that is no window, is gone and the core survives the BadWindow', async () => {
    const window = await makeWindow(500, 400, 60, 40, GREY, 'Boîte destroyed');
    x11.XDestroyWindow(display, window);
    x11.XSync(display, 0);
    made.splice(made.indexOf(window), 1);
    expect(await failure(platformCapture.capture(String(window)))).toBe('gone');
    expect(await failure(screenOnly.capture(String(window)))).toBe('gone');
    expect(await failure(platformCapture.capture('not-a-window'))).toBe('gone');
    // The connection still answers after the errors.
    expect((await platformCapture.list()).some(listed => listed.id === String(cover))).toBe(true);
  });
});
