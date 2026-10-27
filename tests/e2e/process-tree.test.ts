import { expect, test } from 'bun:test';
import { rejection } from '../../packages/core/test/settle.ts';
import { windowsProcessTree } from './lib/process-tree.ts';

// A shell's diagnosis lists WebView2's processes under it with their `--type`.
// The PowerShell and WMI listing it replaces gave nothing within 10 s on a
// loaded runner; this one reads the same in this process.
test.skipIf(process.platform !== 'win32')('the process tree lists every descendant with its command line, in well under a second', async () => {
  const marker = `tree-${process.pid}-${Date.now()}`;
  // Two levels below the captured root, all kept alive until the test ends.
  const descendant = `const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', '${marker}-great-grandchild'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true }); console.log(child.pid); setInterval(() => {}, 1000);`;
  const script = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendant)}, '${marker}-grandchild'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }); console.log(child.pid); await Bun.write(Bun.stdout, child.stdout);`;
  const parent = Bun.spawn([process.execPath, '-e', script, `${marker}-child`], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
  const descendants: number[] = [];
  try {
    const reader = parent.stdout.getReader();
    try {
      let output = '';
      while (descendants.length < 2) {
        const { value, done } = await reader.read();
        if (done) throw new Error('process-tree fixture exited before both descendants were ready');
        output += new TextDecoder().decode(value);
        let end: number;
        while ((end = output.indexOf('\n')) !== -1) {
          const pid = Number(output.slice(0, end).trim());
          output = output.slice(end + 1);
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('process-tree fixture returned an invalid PID');
          descendants.push(pid);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const started = performance.now();
    const tree = await windowsProcessTree(parent.pid);
    const took = performance.now() - started;
    // Console helpers can appear at either level; every ancestry must reach the root.
    const parents = new Map(tree.map(entry => [entry.ProcessId, entry.ParentProcessId]));
    expect(tree.every(entry => {
      let pid = entry.ProcessId;
      const visited = new Set<number>();
      while (pid !== parent.pid) {
        if (visited.has(pid) || !parents.has(pid)) return false;
        visited.add(pid);
        pid = parents.get(pid)!;
      }
      return true;
    }), JSON.stringify(tree, null, 2)).toBe(true);
    expect(tree.some(entry => entry.ProcessId === process.pid)).toBe(false);
    const child = tree.find(entry => entry.ProcessId === parent.pid)!;
    const below = tree.find(entry => entry.ProcessId === descendants[0])!;
    const leaf = tree.find(entry => entry.ProcessId === descendants[1])!;
    expect(child.Name.toLowerCase()).toBe('bun.exe');
    expect(child.CommandLine).toContain(`${marker}-child`);
    expect(below).toMatchObject({ ParentProcessId: parent.pid, Name: child.Name });
    expect(below.CommandLine).toContain(`${marker}-grandchild`);
    expect(leaf).toMatchObject({ ParentProcessId: below.ProcessId, Name: child.Name });
    expect(leaf.CommandLine).toContain(`${marker}-great-grandchild`);
    expect(took).toBeLessThan(1000);
    expect(await windowsProcessTree(2 ** 31)).toEqual([]);
  } finally {
    for (const pid of descendants.toReversed()) try { process.kill(pid); } catch {}
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
