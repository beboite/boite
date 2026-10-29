import { expect, test } from 'bun:test';
import { createTcpDiagnostics } from '../src/platform/linux-netlink.ts';

test.skipIf(process.platform !== 'linux' && process.platform !== 'android')('TCP diagnostics load the native libc and release their sockets', async () => {
  const diagnostics = createTcpDiagnostics();
  try {
    const counters = await diagnostics.dump();
    // Android can deny the diagnostic socket to an ordinary app.
    expect(counters === null || Array.isArray(counters)).toBe(true);
  } finally {
    diagnostics.close();
  }
  expect(await diagnostics.dump()).toBeNull();
});
