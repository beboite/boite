import { availableParallelism, freemem, totalmem } from 'node:os';
import { LinuxLoad, linuxMachineMemory, linuxStartedAt } from './linux-load.ts';
import type { ProcessPlatform } from './types.ts';

/**
 * Linux and macOS currently track direct children through the registry. Linux
 * also measures CPU and reads start times from procfs. macOS supplies resident
 * memory through libproc when the platform entry loads its native backend.
 */
export function createPosixPlatform(
  os: 'linux' | 'macos',
  load: Pick<LinuxLoad, 'add' | 'remove' | 'sample'> | null = os === 'linux' ? new LinuxLoad(availableParallelism()) : null,
): ProcessPlatform {
  return {
    retain() {},
    release: () => Promise.resolve(),
    capability: () => ({ os, mode: 'poll', note: 'direct children only; Job Objects are Windows-only' }),
    applySettings() {},
    attach: () => false,
    terminate: () => false,
    terminateProcess: () => false,
    terminateUnassigned() {},
    sample: (threadId) => load?.sample(threadId) ?? null,
    machineMemory: () => os === 'linux' ? linuxMachineMemory() : { totalBytes: totalmem(), availableBytes: freemem() },
    pidAdded: (threadId, pid) => {
      load?.add(threadId, pid);
    },
    pidRemoved: (threadId, pid) => {
      load?.remove(threadId, pid);
    },
    warm() {},
    forget() {},
    guardStatus: () => ({ running: false, hook: null, failure: null, audio: 'off', mutedPids: [] }),
    startedAt: (pid) => (os === 'linux' ? linuxStartedAt(pid) : null),
  };
}
