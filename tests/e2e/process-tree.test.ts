import { expect, test } from 'bun:test';
import { rejection } from '../../packages/core/test/settle.ts';
import { windowsProcessTree } from './lib/process-tree.ts';

// A shell's diagnosis lists WebView2's processes under it with their `--type`.
// The PowerShell and WMI listing it replaces gave nothing within 10 s on a
// loaded runner; this one reads the same in this process.
test.skipIf(process.platform !== 'win32')('the process tree lists every descendant with its command line, in well under a second', async () => {
  const marker = `tree-${process.pid}-${Date.now()}`;
  // A child that starts a grandchild, both kept alive until the test ends.
  const script = `const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', '${marker}-grandchild'], { stdout: 'ignore' }); console.log(child.pid); setInterval(() => {}, 1000);`;
  const parent = Bun.spawn([process.execPath, '-e', script, `${marker}-child`], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
  let grandchild = 0;
  try {
    const reader = parent.stdout.getReader();
    grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    const started = performance.now();
    const tree = await windowsProcessTree(parent.pid);
    const took = performance.now() - started;
    // A console child also gets its conhost.exe, under the same parent.
    expect(tree.every(entry => entry.ProcessId === parent.pid || entry.ParentProcessId === parent.pid)).toBe(true);
    const child = tree.find(entry => entry.ProcessId === parent.pid)!;
    const below = tree.find(entry => entry.ProcessId === grandchild)!;
    expect(child.Name.toLowerCase()).toBe('bun.exe');
    expect(child.CommandLine).toContain(`${marker}-child`);
    expect(below).toMatchObject({ ParentProcessId: parent.pid, Name: child.Name });
    expect(below.CommandLine).toContain(`${marker}-grandchild`);
    expect(took).toBeLessThan(1000);
    expect(await windowsProcessTree(2 ** 31)).toEqual([]);
  } finally {
    if (grandchild > 0) try { process.kill(grandchild); } catch {}
    parent.kill();
    await parent.exited;
  }
}, 20_000);

// import('bun:ffi') yields before opening the native library. Revoking the
// attempt during that suspension must work even on Linux, without kernel32.
test('a process-tree observation revoked while FFI loads cancels before native access', async () => {
  let authorized = true;
  const sampling = windowsProcessTree(process.pid, () => authorized);
  authorized = false;
  const failure = await rejection(sampling);
  expect(failure.reason).toMatchObject({ code: 'ABORT_ERR' });
});
