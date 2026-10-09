/*
 * The music playing on this computer, as the shell reads it from the system's
 * media session (Spotify first): for the companion's headphones and its player
 * controls. Outside the shell nothing plays.
 */

export interface MediaState {
  title: string;
  artist: string;
  /** The session's app id: `Spotify.exe`, `MSEdge`, an AUMID... */
  app: string;
  playing: boolean;
  /** The track's cover, 96 px at most, as a data URL: Windows only, and not every player has one. */
  art?: string | null;
}

export type MediaAction = 'toggle' | 'next' | 'previous';

export async function readMedia(): Promise<MediaState | null> {
  if (window.__TAURI_INTERNALS__ === undefined) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<MediaState | null>('companion_media');
}

export async function pressMedia(action: MediaAction): Promise<void> {
  if (window.__TAURI_INTERNALS__ === undefined) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('companion_media_control', { action });
}

/** A readable name for the app a session belongs to. */
export function appName(app: string): string {
  const id = app.toLowerCase();
  if (id.includes('spotify')) return 'Spotify';
  if (id.includes('chrome')) return 'Chrome';
  if (id.includes('msedge') || id.includes('edge')) return 'Edge';
  if (id.includes('firefox')) return 'Firefox';
  if (id.includes('deezer')) return 'Deezer';
  return app.replace(/\.exe$/i, '').split(/[!\\/]/).pop() ?? app;
}
