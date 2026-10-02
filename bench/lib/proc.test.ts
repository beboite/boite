import { expect, test } from 'bun:test';
import { workingSet } from './proc.ts';

test.skipIf(process.platform !== 'linux')('workingSet measures a captured live Linux PID and distinguishes its exit from a supplied snapshot', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000);'], {
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  try {
    const reader = child.stdout.getReader();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('ready');
    } finally {
      reader.releaseLock();
    }
    const bytes = workingSet(child.pid);
    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    console.log(JSON.stringify({ scenario: 'captured Linux RSS', pid: child.pid, bytes }));

    const supplied = new Map([[child.pid, {
      pid: child.pid, parentPid: process.pid, name: 'supplied',
      workingSetBytes: 123, executablePath: null,
    }]]);
    expect(workingSet(child.pid, supplied)).toBe(123);
    expect(workingSet(child.pid, new Map())).toBe(0);
    for (const pid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => workingSet(pid)).toThrow('pid: expected a positive safe integer');
    }
  } finally {
    child.kill();
    await child.exited;
  }
  expect(workingSet(child.pid)).toBe(0);
}, 10_000);
