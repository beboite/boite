import { describe, expect, test } from 'bun:test';
import { createPosixPlatform, windowCaptureRefusal } from '../src/platform/posix.ts';

describe('window capture refusals on Linux and macOS', () => {
  test('macOS names ScreenCaptureKit, whatever the environment', () => {
    expect(windowCaptureRefusal('macos', { DISPLAY: ':0' })).toContain('ScreenCaptureKit');
  });

  test('a Wayland session is refused through either variable, naming the portal', () => {
    for (const env of [{ WAYLAND_DISPLAY: 'wayland-0' }, { XDG_SESSION_TYPE: 'wayland' }]) {
      const refusal = windowCaptureRefusal('linux', env);
      expect(refusal).toContain('Wayland session');
      expect(refusal).toContain('portal');
      expect(refusal).toContain('an X11 session works');
    }
  });

  test('XWayland is refused too: its display shows only X11 apps', () => {
    const refusal = windowCaptureRefusal('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', DISPLAY: ':1' });
    expect(refusal).toContain('XWayland on :1 shows only X11 apps');
  });

  test('no DISPLAY, or an empty one, reads as headless', () => {
    expect(windowCaptureRefusal('linux', {})).toContain('DISPLAY is not set');
    expect(windowCaptureRefusal('linux', { DISPLAY: '', XDG_SESSION_TYPE: 'tty' })).toContain('DISPLAY is not set');
  });

  test('an X11 session is not refused', () => {
    expect(windowCaptureRefusal('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' })).toBeNull();
    expect(windowCaptureRefusal('linux', { DISPLAY: ':99' })).toBeNull();
  });

  test('the macOS platform answers unavailable without loading a native backend', async () => {
    expect(await createPosixPlatform('macos', null).windowCapture!()).toEqual({
      unavailable: 'window capture on macOS needs ScreenCaptureKit, which Boite does not drive yet',
    });
  });
});
