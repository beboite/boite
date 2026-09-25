import { availableParallelism } from 'node:os';
import { LinuxLoad } from './linux-load.ts';
import type { ProcessPlatform } from './types.ts';

/**
 * Linux and macOS currently track direct children through the registry. Linux
 * also measures their load from procfs; macOS has no such files and reports none.
 */
export function createPosixPlatform(
  os: 'linux' | 'macos',
  load: LinuxLoad | null = os === 'linux' ? new LinuxLoad(availableParallelism()) : null,
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
    pidAdded: (threadId, pid) => {
      load?.add(threadId, pid);
    },
    pidRemoved: (threadId, pid) => {
      load?.remove(threadId, pid);
    },
    warm() {},
    forget() {},
    guardStatus: () => ({ running: false, hook: null, failure: null, audio: 'off', mutedPids: [] }),
  };
}
