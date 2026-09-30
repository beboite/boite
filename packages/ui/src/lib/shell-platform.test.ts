import { afterEach, expect, test } from 'vitest';
import { linuxShell } from './shell-platform';

const tauri = window as { __TAURI_INTERNALS__?: unknown };
afterEach(() => { delete tauri.__TAURI_INTERNALS__; });

test('only the Linux desktop shell lacks the child webview and the microphone', () => {
  const webkitgtk = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  expect(linuxShell(webkitgtk)).toBe(false);
  tauri.__TAURI_INTERNALS__ = {};
  expect(linuxShell(webkitgtk)).toBe(true);
  expect(linuxShell('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe(false);
  expect(linuxShell('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140.0')).toBe(false);
  expect(linuxShell('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36')).toBe(false);
});
