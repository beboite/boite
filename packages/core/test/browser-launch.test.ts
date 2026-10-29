import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp } from '../src/browser/cdp.ts';
import { startChromium, type SpawnBrowser } from '../src/browser/launch.ts';
import { rejection } from './settle.ts';

test.each(['throw', 'reject'] as const)('a live browser surfaces a stop failure that would %s', async kind => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-browser-launch-'));
  const error = new Error('access denied while stopping browser');
  const cdp = { send: async () => ({}) } as unknown as Cdp;
  const pipe = spyOn(Cdp, 'pipe').mockResolvedValue(cdp);
  const connect = spyOn(Cdp, 'connect').mockResolvedValue(cdp);
  const spawn: SpawnBrowser = () => {
    writeFileSync(join(dir, 'DevToolsActivePort'), '1234\n/devtools/browser/test');
    return {
      proc: { stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }) },
      fds: [1, 2], exited: new Promise(() => {}),
      stop() {
        if (kind === 'throw') throw error;
        return Promise.reject(error);
      },
    } as unknown as ReturnType<SpawnBrowser>;
  };
  try {
    const started = await startChromium(spawn, 'chromium', dir, 1000);
    expect((await rejection(Promise.resolve().then(() => started.kill()))).reason).toBe(error);
  } finally {
    pipe.mockRestore(); connect.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
