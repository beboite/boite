/**
 * Whether this page runs in the Linux desktop shell, whose WebKitGTK webview
 * lacks two things the Windows and macOS shells have. A child webview is packed
 * into the window's vertical GTK box, where it cannot be moved or sized, so the
 * browser panel took the lower half of the window whatever the slot measured.
 * And media capture is off, so dictation cannot reach the microphone.
 */
export function linuxShell(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
    && /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent);
}
