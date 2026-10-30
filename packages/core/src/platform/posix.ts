import { availableParallelism, totalmem } from 'node:os';
import { CgroupMemoryReader } from './linux-cgroup.ts';
import { LinuxLoad, linuxMachineMemory, linuxStartKey, linuxStartedAt } from './linux-load.ts';
import type { ProcessPlatform } from './types.ts';
import { linuxServerUpdates } from './linux-server-update.ts';
import { findTailscaleCli } from './tailscale.ts';
import { LinuxExecutionBoundary } from './linux-protected.ts';
import { linuxGpus, linuxOsLabel, linuxVolumes, macosOsLabel, macosVolumes } from './posix-machine.ts';

/**
 * Why this machine cannot capture windows, or null on an X11 session. Pure,
 * so the test reads every case without touching the real environment.
 */
export function windowCaptureRefusal(os: 'linux' | 'macos', env: Record<string, string | undefined>): string | null {
  if (os === 'macos') return 'window capture on macOS needs ScreenCaptureKit, which Boite does not drive yet';
  const portal = 'a Wayland compositor gives one app no other app\'s window except through the desktop portal\'s own picker';
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) {
    return env.DISPLAY
      ? `this is a Wayland session: ${portal}, and XWayland on ${env.DISPLAY} shows only X11 apps; an X11 session works`
      : `this is a Wayland session: ${portal}; an X11 session works`;
  }
  if (!env.DISPLAY) return 'no display: DISPLAY is not set, as on a server or in a container, so there is no desktop to capture';
  return null;
}

/**
 * Linux and macOS track direct children through the registry. Their load
 * backends also sample descendants and verify process identities before a
 * memory stop, using procfs on Linux and libproc on macOS.
 */
export function createPosixPlatform(
  os: 'linux' | 'macos',
  load: Pick<LinuxLoad, 'add' | 'remove' | 'sample'> & Partial<Pick<LinuxLoad, 'killTree' | 'watchResources' | 'finishResources' | 'closeResources' | 'forget'>> | null = os === 'linux' ? new LinuxLoad(availableParallelism()) : null,
): ProcessPlatform {
  const cgroups = os === 'linux' ? new CgroupMemoryReader() : null;
  return {
    ...(os === 'linux' ? {protectedExecution: new LinuxExecutionBoundary()} : {}),
    ...(os === 'linux' ? { serverUpdates: linuxServerUpdates() } : {}),
    tailscaleCli: () => findTailscaleCli(os),
    // libX11 loads with the first `boite window` on an X11 session, never at startup.
    windowCapture: async () => {
      const refusal = windowCaptureRefusal(os, process.env);
      if (refusal !== null) return { unavailable: refusal };
      return (await import('./x11-window-capture.ts')).loadX11WindowCapture();
    },
    // AT-SPI (Linux) and the AX API (macOS) are not driven yet: `boite window screenshot` still shows the window.
    windowGuide: async () => ({ unavailable: `boite window read and point need Windows: ${os === 'linux' ? 'AT-SPI' : 'the macOS Accessibility API'} is not supported yet` }),
    retain() {},
    release: async () => { load?.watchResources?.(false); await load?.closeResources?.(); },
    capability: () => ({ os, mode: 'poll', note: 'direct children only; Job Objects are Windows-only' }),
    applySettings() {},
    attach: () => false,
    terminate: () => false,
    terminateProcess: (threadId, pid, startedAt) => load?.killTree?.(pid, threadId, startedAt) ?? false,
    terminateUnassigned() {},
    sample: (threadId) => load?.sample(threadId) ?? null,
    watchResources: (active) => load?.watchResources?.(active),
    finishResources: () => load?.finishResources?.(),
    // macOS `freemem()` leaves out inactive and purgeable pages, far below what the system can hand out.
    machineMemory: () => os === 'linux' ? linuxMachineMemory() : { totalBytes: totalmem(), availableBytes: null },
    machineVolumes: () => os === 'linux' ? linuxVolumes() : macosVolumes(),
    // macOS has no GPU reader here: IOKit's performance statistics are private API.
    ...(os === 'linux' ? { machineGpus: linuxGpus } : {}),
    osLabel: () => os === 'linux' ? linuxOsLabel() : macosOsLabel(),
    ...(cgroups !== null ? { cgroupMemory: (pid: number) => cgroups.read(pid) } : {}),
    pidAdded: (threadId, pid) => {
      load?.add(threadId, pid);
    },
    pidRemoved: (threadId, pid) => {
      load?.remove(threadId, pid);
      cgroups?.forget(pid);
    },
    warm() {},
    forget(threadId) { load?.forget?.(threadId); },
    guardStatus: () => ({ running: false, hook: null, failure: null, audio: 'off', mutedPids: [] }),
    startedAt: (pid) => (os === 'linux' ? linuxStartedAt(pid) : null),
    ...(os === 'linux' ? { startKey: (pid: number) => linuxStartKey(pid) } : {}),
    // Every process traced here is the core's own child, so the sweep never asks.
    runningSince: () => null,
  };
}
