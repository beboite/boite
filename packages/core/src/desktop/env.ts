/*
 * The environment of a virtual desktop's programs, shared by the core that
 * starts them and the CLI that runs agent-desktop on them (docs/desktop.md).
 */
import { posix } from 'node:path';

// The desktop is an X11 session on Linux: its paths are POSIX wherever the core is built or tested.
const { join } = posix;

/** Every process of a desktop carries this variable, so a stop finds the ones that left their group. */
export const DESKTOP_MARK = 'BOITE_DESKTOP_ID';

/** The desktop's own XDG folders, named after the variable each one answers. */
export const DESKTOP_XDG_DIRS = ['home', 'config', 'cache', 'data', 'state', 'runtime'] as const;

/**
 * What a program needs to live on the desktop. An empty value removes the
 * variable: the user's Wayland, session bus and accessibility bus stay out.
 * Sound goes to an address that does not exist, so nothing plays aloud.
 * HOME and the XDG folders are the desktop's own: a single-instance app
 * (Chrome, Firefox, Electron, VS Code) finds its profile, lock and socket
 * there, so it never hands its window to the same app on another desktop or
 * in the user's session.
 */
export function desktopEnv(dir: string, display: string, bus: string, id: string): Record<string, string> {
  const silent = join(dir, 'no-sound');
  return {
    DISPLAY: display,
    XAUTHORITY: join(dir, 'Xauthority'),
    DBUS_SESSION_BUS_ADDRESS: bus,
    AT_SPI_BUS_ADDRESS: '',
    WAYLAND_DISPLAY: '',
    WAYLAND_SOCKET: '',
    SESSION_MANAGER: '',
    DESKTOP_STARTUP_ID: '',
    NO_AT_BRIDGE: '',
    XDG_SESSION_TYPE: 'x11',
    GDK_BACKEND: 'x11',
    QT_QPA_PLATFORM: 'xcb',
    // GTK reaches the bus by itself; Qt, Chromium and Electron wait to be told.
    QT_ACCESSIBILITY: '1',
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
    ACCESSIBILITY_ENABLED: '1',
    PULSE_SERVER: `unix:${silent}`,
    PIPEWIRE_REMOTE: silent,
    SDL_AUDIODRIVER: 'dummy',
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_RUNTIME_DIR: join(dir, 'runtime'),
    AGENT_DESKTOP_HOME: join(dir, 'agent-desktop'),
    [DESKTOP_MARK]: id,
  };
}

/** `env` applied on `base`, its empty values removed. */
export function withDesktopEnv(base: Record<string, string | undefined>, env: Record<string, string>): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base };
  for (const [key, value] of Object.entries(env)) merged[key] = value === '' ? undefined : value;
  return merged;
}
