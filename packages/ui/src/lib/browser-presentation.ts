import type { BrowserBridge, SurfaceRect } from './browser-bridge';

/** Replace native pixels with a snapshot while the app's menus cover them. */
export function browserPresentation(bridge: BrowserBridge, id: string, preview: (image: string | null) => void) {
  let covered = false;
  let revision = 0;
  return (rect: SurfaceRect | null, overlaps: boolean) => {
    // Fake iframes already respect the top layer. Only the native bridge has CDP.
    const next = !!rect && overlaps && !!bridge.protocol;
    if (next !== covered) {
      covered = next;
      const current = ++revision;
      preview(null);
      if (next) {
        // Queued before parking: capture the displayed page, preserving its
        // viewport and form state. Late captures never cover a restored tab.
        void bridge.protocol!(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 90, captureBeyondViewport: false }).then(result => {
          const data = (result as { data?: unknown })?.data;
          if (current === revision && typeof data === 'string') preview(`data:image/jpeg;base64,${data}`);
        }).catch(error => console.warn('[browser] overlay snapshot failed', error));
      }
    }
    bridge.setBounds(id, next ? null : rect);
  };
}
