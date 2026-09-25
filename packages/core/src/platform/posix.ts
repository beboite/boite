import type { ProcessPlatform } from './types.ts';

/** Linux and macOS currently track direct children through the registry. */
export function createPosixPlatform(os: 'linux' | 'macos'): ProcessPlatform {
  return {
    retain() {},
    release: () => Promise.resolve(),
    capability: () => ({ os, mode: 'poll', note: 'direct children only; Job Objects are Windows-only' }),
    applySettings() {},
    attach: () => false,
    terminate: () => false,
    terminateProcess: () => false,
    terminateUnassigned() {},
    sample: () => null,
    pidAdded() {},
    pidRemoved() {},
    warm() {},
    forget() {},
    guardStatus: () => ({ running: false, hook: null, failure: null, audio: 'off', mutedPids: [] }),
  };
}
