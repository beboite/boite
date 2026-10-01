/**
 * The hit a crack lands: the native window shakes, or the whole interface when
 * the window cannot move (browser, phone, maximized, fullscreen).
 */
let shaking = false;
let animation: Animation | undefined;
let generation = 0;

/** One hit at a time: a crack during a shake is heard but does not restart it. */
export async function shakeWindow(): Promise<void> {
  if (shaking) return;
  shaking = true;
  const mine = ++generation;
  try {
    if (window.__TAURI_INTERNALS__) {
      const { invoke } = await import('@tauri-apps/api/core');
      if (mine !== generation || await invoke<boolean>('whip_window')) return;
    }
    const root = document.getElementById('app');
    if (mine !== generation || !root) return;
    const cssDuration = getComputedStyle(root).getPropertyValue('--dur-whip').trim();
    const duration = parseFloat(cssDuration) * (cssDuration.endsWith('ms') ? 1 : 1000);
    animation = root.animate([
      { transform: 'translate(0, 0) rotate(0deg)' },
      { transform: 'translate(-12px, 3px) rotate(-0.35deg)' },
      { transform: 'translate(10px, -3px) rotate(0.3deg)' },
      { transform: 'translate(-8px, 2px) rotate(-0.25deg)' },
      { transform: 'translate(6px, -2px) rotate(0.2deg)' },
      { transform: 'translate(-4px, 1px) rotate(-0.1deg)' },
      { transform: 'translate(2px, -1px) rotate(0.05deg)' },
      { transform: 'translate(0, 0) rotate(0deg)' }
    ], { duration, easing: 'ease-out' });
    await animation.finished.catch(() => undefined);
  } finally {
    if (mine === generation) { animation = undefined; shaking = false; }
  }
}

/** Stops the interface shake with the overlay. A native shake restores itself. */
export function cancelShake(): void {
  generation++;
  animation?.cancel();
  animation = undefined;
  shaking = false;
}
