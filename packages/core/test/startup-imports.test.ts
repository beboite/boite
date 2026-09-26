import { expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * What evaluating the core's module graph loads, in a fresh process: the test
 * runner shares one module registry across files, so another test having
 * imported a library would hide a static import of it here.
 */
async function modulesLoadedBy(entry: string): Promise<string[]> {
  const script = `await import(${JSON.stringify(entry)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`importing ${entry} exited ${code}: ${err}`);
  return JSON.parse(out.trim().split('\n').at(-1) ?? '[]') as string[];
}

test('the core starts without the unzip library, which only installs use', async () => {
  const loaded = await modulesLoadedBy(join(import.meta.dir, '../src/core.ts'));
  expect(loaded.length).toBeGreaterThan(20);
  expect(loaded.filter((path) => path.replaceAll('\\', '/').includes('/fflate/'))).toEqual([]);
}, 30_000);
