import { appendFileSync } from 'node:fs';

/** Leave time for cleanup inside the native test's existing 20-second deadline. */
const STARTUP_MS = 5_000;

/** A real two-level Bun tree; the optional journal captures PIDs at spawn, independently of stdout. */
export function processTreeFixture(marker: string, announce = true, journal?: string) {
  const record = journal === undefined ? '' : `require('node:fs').appendFileSync(${JSON.stringify(journal)}, child.pid + '\\n');`;
  // Each child owns the next one's stdin and awaits its exit on EOF. Closing
  // the root's input reaches even descendants whose PID never reached stdout.
  const leaf = 'await Bun.stdin.text()';
  const descendant = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(leaf)}, '${marker}-great-grandchild'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', windowsHide: true }); try { ${record} console.log(child.pid); await Bun.stdin.text(); } finally { await child.stdin.end(); await child.exited; }`;
  const script = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendant)}, '${marker}-grandchild'], { stdin: 'pipe', stdout: '${announce ? 'pipe' : 'ignore'}', stderr: 'ignore', windowsHide: true }); let forwarding = Promise.resolve(); try { ${record} ${announce ? 'console.log(child.pid); forwarding = Bun.write(Bun.stdout, child.stdout).catch(() => {});' : ''} await Bun.stdin.text(); } finally { await child.stdin.end(); await child.exited; await forwarding; }`;
  const parent = Bun.spawn([process.execPath, '-e', script, `${marker}-child`], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', windowsHide: true });
  if (journal !== undefined) appendFileSync(journal, parent.pid + '\n');
  let closing: Promise<void> | undefined;
  return {
    parent,
    async ready(signal?: AbortSignal): Promise<number[]> {
      const reader = parent.stdout.getReader();
      let failure: unknown;
      const cancel = (reason: unknown) => { failure = reason; void reader.cancel().catch(() => {}); };
      const abort = () => cancel(signal!.reason);
      const timer = setTimeout(() => cancel(new Error(`process-tree fixture startup timed out after ${STARTUP_MS} ms`)), STARTUP_MS);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      try {
        const descendants: number[] = [];
        let output = '';
        while (descendants.length < 2) {
          const { value, done } = await reader.read();
          if (failure !== undefined) throw failure;
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
        return descendants;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    close(): Promise<void> {
      return closing ??= (async () => { await parent.stdin.end(); await parent.exited; })();
    },
  };
}
