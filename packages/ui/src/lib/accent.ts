export const ACCENT_KEY = 'boite.accent-hue';
export const ACCENT_PRESETS = [260, 300, 355, 50, 85, 145, 190] as const;

export function readAccent(): number {
  try {
    const value = localStorage.getItem(ACCENT_KEY);
    const hue = value === null ? NaN : Number(value);
    return Number.isFinite(hue) && hue >= 0 && hue <= 360 ? hue : 260;
  } catch { return 260; }
}

export function setAccent(hue: number): void {
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) return;
  document.documentElement.style.setProperty('--accent-hue', String(hue));
  try { localStorage.setItem(ACCENT_KEY, String(hue)); } catch { /* Keep the selection for this window. */ }
}

export function startAccent(): () => void {
  setAccent(readAccent());
  const update = (event: StorageEvent) => { if (event.key === ACCENT_KEY) setAccent(readAccent()); };
  window.addEventListener('storage', update);
  return () => window.removeEventListener('storage', update);
}
