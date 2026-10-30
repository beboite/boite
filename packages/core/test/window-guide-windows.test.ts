import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { NativeWindow, ScreenRect, WindowCapture, WindowGuide } from '../src/platform/types.ts';

/**
 * A WinForms form this file owns, in its own powershell.exe, that never takes
 * the focus: two enabled buttons, a disabled one and a text field. The box is
 * checked on the screen itself, read back with `CAPTUREBLT` so layered
 * windows are in the picture.
 */
const FORM = `
using System;
using System.Drawing;
using System.Windows.Forms;
public class BoiteGuideWindow : Form {
  public BoiteGuideWindow(string title) {
    Text = title;
    StartPosition = FormStartPosition.Manual;
    Location = new Point(120, 120);
    Size = new Size(420, 260);
    TopMost = true;
    Controls.Add(new Button { Text = "Open project", Name = "openProject", Location = new Point(20, 20), Size = new Size(140, 40) });
    Controls.Add(new Button { Text = "Build", Location = new Point(180, 20), Size = new Size(100, 40) });
    Controls.Add(new Button { Text = "Disabled", Location = new Point(20, 80), Size = new Size(100, 40), Enabled = false });
    Controls.Add(new TextBox { Name = "search", Location = new Point(20, 140), Size = new Size(200, 24) });
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { CreateParams parameters = base.CreateParams; parameters.ExStyle |= 0x08000000; return parameters; }
  }
}
`;

function openWindow(title: string): Subprocess {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'\n${FORM}\n'@`,
    `[System.Windows.Forms.Application]::Run((New-Object BoiteGuideWindow -ArgumentList '${title}'))`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdout: 'ignore', stderr: 'pipe', windowsHide: true });
}

/** The screen's pixels in `rect`, BGRA, layered windows included. */
function screenPixels(rect: ScreenRect): Uint8Array {
  const user32 = dlopen('user32.dll', {
    GetDC: { args: [FFIType.u64], returns: FFIType.u64 },
    ReleaseDC: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    SetThreadDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i64 },
  }).symbols;
  const gdi32 = dlopen('gdi32.dll', {
    CreateCompatibleDC: { args: [FFIType.u64], returns: FFIType.u64 },
    CreateDIBSection: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.u64 },
    SelectObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
    BitBlt: { args: [FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    DeleteObject: { args: [FFIType.u64], returns: FFIType.i32 },
    DeleteDC: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
  const previous = user32.SetThreadDpiAwarenessContext(-4n);
  const screen = user32.GetDC(0n);
  const memory = gdi32.CreateCompatibleDC(screen);
  const info = new DataView(new ArrayBuffer(44));
  info.setUint32(0, 40, true);
  info.setInt32(4, rect.width, true);
  info.setInt32(8, -rect.height, true);
  info.setUint16(12, 1, true);
  info.setUint16(14, 32, true);
  const bits = new BigUint64Array(1);
  const bitmap = gdi32.CreateDIBSection(memory, ptr(info), 0, ptr(bits), 0n, 0);
  const old = gdi32.SelectObject(memory, bitmap);
  try {
    // SRCCOPY | CAPTUREBLT
    gdi32.BitBlt(memory, 0, 0, rect.width, rect.height, screen, rect.left, rect.top, 0x00cc0020 | 0x40000000);
    return new Uint8Array(toArrayBuffer(Number(bits[0]) as unknown as Pointer, 0, rect.width * rect.height * 4)).slice();
  } finally {
    gdi32.SelectObject(memory, old);
    gdi32.DeleteObject(bitmap);
    gdi32.DeleteDC(memory);
    user32.ReleaseDC(0n, screen);
    if (previous !== 0n) user32.SetThreadDpiAwarenessContext(previous);
  }
}

/** Pixels of the pointer's orange (B 0, G 0x5a, R 0xff) in a strip. */
function orange(bgra: Uint8Array): number {
  let count = 0;
  for (let at = 0; at < bgra.length; at += 4) if (bgra[at]! < 40 && Math.abs(bgra[at + 1]! - 0x5a) < 40 && bgra[at + 2]! > 215) count += 1;
  return count;
}

describe.skipIf(process.platform !== 'win32')('window guide on Windows', () => {
  const tag = `boite-guide-${process.pid}-${Date.now()}`;
  let proc: Subprocess;
  let capture: WindowCapture;
  let guide: WindowGuide;
  let form: NativeWindow;

  beforeAll(async () => {
    const { loadWindowCapture } = await import('../src/platform/windows/window-capture.ts');
    const { loadWindowGuide } = await import('../src/platform/windows/window-guide.ts');
    const [loadedCapture, loadedGuide] = await Promise.all([loadWindowCapture(), loadWindowGuide()]);
    if ('unavailable' in loadedCapture) throw new Error(loadedCapture.unavailable);
    if ('unavailable' in loadedGuide) throw new Error(loadedGuide.unavailable);
    capture = loadedCapture;
    guide = loadedGuide;
    proc = openWindow(tag);
    // PowerShell loading WinForms takes seconds on a busy machine or CI runner.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const found = (await capture.list()).find(window => window.pid === proc.pid && window.title === tag);
      if (found) { form = found; return; }
      if (proc.exitCode !== null) throw new Error(`test window exited ${proc.exitCode}: ${await new Response(proc.stderr as ReadableStream).text()}`);
      await Bun.sleep(100);
    }
    throw new Error(`test window of pid ${proc.pid} never showed`);
  }, 45_000);

  afterAll(() => {
    proc?.kill();
  });

  test('reads the enabled controls with their names and places inside the window', async () => {
    const frame = guide.frame(form.id)!;
    expect(frame.minimized).toBe(false);
    expect({ width: frame.rect.width, height: frame.rect.height }).toEqual({ width: form.width, height: form.height });
    const { controls, total } = await guide.controls(form.id, 50);
    expect(total).toBe(controls.length);
    const names = controls.map(control => `${control.type} ${control.name}`);
    expect(names).toContain('Button Open project');
    expect(names).toContain('Button Build');
    expect(names).toContain('Edit ');
    expect(names).not.toContain('Button Disabled');
    const open = controls.find(control => control.name === 'Open project')!;
    expect(open.automationId).toBe('openProject');
    const build = controls.find(control => control.name === 'Build')!;
    // Same row, left to right, both inside the window's frame, in physical pixels at any scaling.
    expect(build.rect.left).toBeGreaterThan(open.rect.left + open.rect.width - 1);
    expect(Math.abs(build.rect.top - open.rect.top)).toBeLessThan(2);
    for (const control of [open, build]) {
      expect(control.rect.left).toBeGreaterThanOrEqual(frame.rect.left);
      expect(control.rect.top).toBeGreaterThanOrEqual(frame.rect.top);
      expect(control.rect.left + control.rect.width).toBeLessThanOrEqual(frame.rect.left + frame.rect.width);
    }
    expect(await guide.controls(form.id, 1)).toMatchObject({ total });
  });

  test('draws a box above the window around the control, and takes it away', async () => {
    const { controls } = await guide.controls(form.id, 50);
    const build = controls.find(control => control.name === 'Build')!;
    // The strip right above the button: the box's top edge lies there, the label above it.
    const strip = { left: build.rect.left, top: build.rect.top - 12, width: build.rect.width, height: 12 };
    const before = orange(screenPixels(strip));
    const drawn = guide.point(build.rect, 'Click Build');
    try {
      await Bun.sleep(300);
      expect(orange(screenPixels(strip))).toBeGreaterThan(before + build.rect.width);
      drawn.move(null);
      await Bun.sleep(300);
      expect(orange(screenPixels(strip))).toBeLessThanOrEqual(before);
    } finally {
      drawn.close();
      drawn.close();
    }
  });

  test('a window that is gone has no frame and no controls', async () => {
    expect(guide.frame('1')).toBeNull();
    expect(await guide.controls('1', 5).then(() => 'read', error => (error as Error).message)).toContain('window 1 is gone');
    const mouse = guide.mouse();
    expect(typeof mouse.pressed).toBe('boolean');
    expect(Number.isInteger(mouse.x) && Number.isInteger(mouse.y)).toBe(true);
  });
});
