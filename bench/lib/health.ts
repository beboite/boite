import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDirectory } from '../../tests/e2e/lib/core.ts';

export async function startHealthProbe(url: string) {
  const directory = mkdtempSync(join(tmpdir(), 'boite-health-probe-'));
  const output = join(directory, 'samples.json');
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'health-worker.ts'), url, output], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  const errors = new Response(child.stderr).text();
  const stdout = child.stdout.getReader();
  let guard: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    guard = setTimeout(() => { child.kill(); reject(new Error('health probe did not start')); }, 15_000);
  });
  try {
    const ready = await Promise.race([stdout.read(), timeout]);
    assert(!ready.done && new TextDecoder().decode(ready.value).includes('ready'), 'health probe exited before ready');
  } catch (error) {
    child.kill(); await child.exited; await removeDirectory(directory); throw error;
  } finally { clearTimeout(guard); }
  let stopping: Promise<{ samples: number[]; errors: string[] }> | undefined;
  const stop = async (): Promise<{ samples: number[]; errors: string[] }> => {
    child.stdin.write('stop\n');
    child.stdin.end();
    const code = await child.exited;
    const diagnostic = await errors;
    await stdout.cancel();
    try {
      assert.equal(code, 0, diagnostic);
      return JSON.parse(readFileSync(output, 'utf8'));
    } finally { await removeDirectory(directory); }
  };
  return { stop() { return stopping ??= stop(); } };
}
