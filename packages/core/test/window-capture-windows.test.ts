import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import type { NativeWindow, WindowCapture, WindowPixels } from '../src/platform/types.ts';
import { WindowCaptureError } from '../src/platform/window-pixels.ts';

/**
 * Test windows this file owns: a WinForms form in its own powershell.exe,
 * which never takes focus (`ShowWithoutActivation`, `WS_EX_NOACTIVATE`) so the
 * person working on this machine keeps theirs. `minimized` minimizes it from
 * inside its own process with `SW_SHOWMINNOACTIVE`.
 */
const FORM = `
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class BoiteTestWindow : Form {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  bool topMost;
  public BoiteTestWindow(string title, int color, int x, int y, bool topMost, bool minimized) {
    this.topMost = topMost;
    Text = title;
    BackColor = Color.FromArgb(color);
    StartPosition = FormStartPosition.Manual;
    Location = new Point(x, y);
    Size = new Size(360, 260);
    if (minimized) Shown += delegate { ShowWindow(Handle, 7); };
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams parameters = base.CreateParams;
      parameters.ExStyle |= 0x08000000;
      if (topMost) parameters.ExStyle |= 0x8;
      return parameters;
    }
  }
}
`;

const RED = 0xff0000;
const BLUE = 0x0000ff;

function openWindow(title: string, color: number, x: number, y: number, topMost: boolean, minimized: boolean): Subprocess {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'\n${FORM}\n'@`,
    `[System.Windows.Forms.Application]::Run((New-Object BoiteTestWindow -ArgumentList '${title}', ${color | 0xff000000 | 0}, ${x}, ${y}, $${topMost}, $${minimized}))`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdout: 'ignore',
    stderr: 'pipe',
    windowsHide: true,
  });
}

/** Share of the sampled pixels close to the colour `[r, g, b]`. */
function share(pixels: WindowPixels, [r, g, b]: [number, number, number]): number {
  const count = pixels.width * pixels.height;
  const step = Math.max(1, Math.floor(count / 20_000));
  let matching = 0;
  let sampled = 0;
  for (let index = 0; index < count; index += step) {
    const at = index * 4;
    sampled += 1;
    if (Math.abs(pixels.bgra[at + 2]! - r) < 40 && Math.abs(pixels.bgra[at + 1]! - g) < 40 && Math.abs(pixels.bgra[at]! - b) < 40) matching += 1;
  }
  return matching / sampled;
}

async function failure(run: () => Promise<unknown>): Promise<WindowCaptureError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof WindowCaptureError) return error;
    throw error;
  }
  throw new Error('expected a WindowCaptureError');
}

describe.skipIf(process.platform !== 'win32')('window capture on Windows', () => {
  const tag = `boite-capture-${process.pid}-${Date.now()}`;
  const processes: Subprocess[] = [];
  let capture: WindowCapture;
  let red: NativeWindow;
  let minimized: NativeWindow;

  async function find(proc: Subprocess, wanted: (window: NativeWindow) => boolean): Promise<NativeWindow> {
    // PowerShell loading WinForms takes seconds on a busy machine or CI runner.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const found = (await capture.list()).find((window) => window.pid === proc.pid && wanted(window));
      if (found !== undefined) return found;
      if (proc.exitCode !== null) throw new Error(`test window exited ${proc.exitCode}: ${await new Response(proc.stderr as ReadableStream).text()}`);
      await Bun.sleep(100);
    }
    throw new Error(`test window of pid ${proc.pid} never showed`);
  }

  beforeAll(async () => {
    const { loadWindowCapture } = await import('../src/platform/windows/window-capture.ts');
    const loaded = await loadWindowCapture();
    if ('unavailable' in loaded) throw new Error(loaded.unavailable);
    capture = loaded;
    const redProcess = openWindow(`${tag}-red`, RED, 40, 40, false, false);
    const blueProcess = openWindow(`${tag}-blue`, BLUE, 60, 60, true, false);
    const minimizedProcess = openWindow(`${tag}-minimized`, RED, 80, 80, false, true);
    processes.push(redProcess, blueProcess, minimizedProcess);
    [red, minimized] = await Promise.all([
      find(redProcess, (window) => window.title === `${tag}-red`),
      find(minimizedProcess, (window) => window.title === `${tag}-minimized` && window.minimized),
      find(blueProcess, (window) => window.title === `${tag}-blue`),
    ]);
  }, 45_000);

  afterAll(() => {
    for (const proc of processes) proc.kill();
  });

  test('lists the window with its process and physical size', () => {
    expect(red.process.toLowerCase()).toBe('powershell.exe');
    expect(red.path.toLowerCase()).toEndWith('\\powershell.exe');
    expect(red.className).toStartWith('WindowsForms10.');
    expect(red.minimized).toBe(false);
    expect(red.width).toBeGreaterThan(200);
    expect(red.height).toBeGreaterThan(150);
  });

  test('captures a window hidden behind a topmost one, at the size list gave', async () => {
    const picture = await capture.capture(red.id);
    expect({ width: picture.width, height: picture.height }).toEqual({ width: red.width, height: red.height });
    expect(share(picture, [255, 0, 0])).toBeGreaterThan(0.6);
    expect(share(picture, [0, 0, 255])).toBeLessThan(0.05);
  });

  test('PrintWindow alone gives the same window at the same size', async () => {
    const { printWindow } = await import('../src/platform/windows/window-capture.ts');
    const picture = printWindow(red.id);
    expect(picture.via).toBe('printwindow');
    expect({ width: picture.width, height: picture.height }).toEqual({ width: red.width, height: red.height });
    expect(share(picture, [255, 0, 0])).toBeGreaterThan(0.6);
  });

  test('frames keep answering pictures of the window until closed', async () => {
    const frames = capture.frames(red.id);
    try {
      const first = await frames.next();
      const second = await frames.next();
      expect(share(first, [255, 0, 0])).toBeGreaterThan(0.6);
      expect({ width: second.width, height: second.height }).toEqual({ width: red.width, height: red.height });
    } finally {
      frames.close();
      frames.close();
    }
    expect((await failure(() => frames.next())).code).toBe('failed');
  });

  test('refuses a minimized window and a window that does not exist', async () => {
    expect((await failure(() => capture.capture(minimized.id))).code).toBe('minimized');
    expect((await failure(() => capture.frames(minimized.id).next())).code).toBe('minimized');
    expect((await failure(() => capture.capture('1'))).code).toBe('gone');
    expect((await failure(() => capture.capture('not-a-window'))).code).toBe('gone');
  });
});
