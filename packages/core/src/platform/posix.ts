import { availableParallelism, totalmem } from 'node:os';
import { LinuxLoad, linuxMachineMemory, linuxStartedAt } from './linux-load.ts';
import type { ProcessPlatform } from './types.ts';
import { linuxServerUpdates } from './linux-server-update.ts';
import { findTailscaleCli } from './tailscale.ts';

/**
 * Linux and macOS currently track direct children through the registry. Linux
 * also samples descendants and reads start times from procfs. macOS supplies resident
 * memory through libproc when the platform entry loads its native backend.
 */
export function createPosixPlatform(
  os: 'linux' | 'macos',
  load: Pick<LinuxLoad, 'add' | 'remove' | 'sample'> & Partial<Pick<LinuxLoad, 'killTree' | 'watchResources' | 'finishResources' | 'closeResources' | 'forget'>> | null = os === 'linux' ? new LinuxLoad(availableParallelism()) : null,
): ProcessPlatform {
  return {
    ...(os === 'linux' ? { serverUpdates: linuxServerUpdates() } : {}),
    tailscaleCli: () => findTailscaleCli(os),
    retain() {},
    release: async () => { load?.watchResources?.(false); await load?.closeResources?.(); },
    capability: () => ({ os, mode: 'poll', note: 'direct children only; Job Objects are Windows-only' }),
    applySettings() {},
    attach: () => false,
    terminate: () => false,
    terminateProcess: (_threadId, pid) => load?.killTree?.(pid) ?? false,
    terminateUnassigned() {},
    sample: (threadId) => load?.sample(threadId) ?? null,
    watchResources: (active) => load?.watchResources?.(active),
    finishResources: () => load?.finishResources?.(),
    // macOS `freemem()` leaves out inactive and purgeable pages, far below what the system can hand out.
    machineMemory: () => os === 'linux' ? linuxMachineMemory() : { totalBytes: totalmem(), availableBytes: null },
    pidAdded: (threadId, pid) => {
      load?.add(threadId, pid);
    },
    pidRemoved: (threadId, pid) => {
      load?.remove(threadId, pid);
    },
    warm() {},
    forget(threadId) { load?.forget?.(threadId); },
    guardStatus: () => ({ running: false, hook: null, failure: null, audio: 'off', mutedPids: [] }),
    startedAt: (pid) => (os === 'linux' ? linuxStartedAt(pid) : null),
    // Every process traced here is the core's own child, so the sweep never asks.
    runningSince: () => null,
  };
}
