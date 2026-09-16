import type { ProcessPlatform } from './types.ts';

/** Linux and macOS currently track direct children through the registry. */
export function createPosixPlatform(os: 'linux' | 'macos'): ProcessPlatform {
  return {
    retain() {},
    release() {},
    capability: () => ({ os, mode: 'poll', note: 'direct children only; Job Objects are Windows-only' }),
    applySettings() {},
    attach: () => false,
    terminate: () => false,
    terminateUnassigned() {},
    sample: () => null,
    pidAdded() {},
    pidRemoved() {},
    guardStatus: () => ({ running: false, hook: null, failure: null, audio: 'off', mutedPids: [] }),
  };
}
