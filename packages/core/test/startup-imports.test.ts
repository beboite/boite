import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

test('the core starts without unzip, provider SDKs or lazy review inference implementations', async () => {
  const loaded = await modulesLoadedBy(join(import.meta.dir, '../src/core.ts'));
  expect(loaded.length).toBeGreaterThan(20);
  expect(loaded.filter((path) => path.replaceAll('\\', '/').includes('/fflate/'))).toEqual([]);
  for (const lazy of ['/@anthropic-ai/claude-agent-sdk/', '/@agentclientprotocol/sdk/', '/drivers/claude/side-question.ts']) {
    expect(loaded.filter(path => path.replaceAll('\\', '/').includes(lazy))).toEqual([]);
  }
}, 30_000);

/**
 * Every module the core's static imports reach from `entry`, with the
 * built-in modules each one imports. Built-ins never enter `require.cache`,
 * so the graph is read from the sources; `await import()` stays out of it.
 */
function staticBuiltins(entry: string): Map<string, string[]> {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const builtins = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    for (const { kind, path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (kind !== 'import-statement') continue;
      if (/^(node|bun):/.test(path)) { builtins.set(path, [...(builtins.get(path) ?? []), file]); continue; }
      const resolved = Bun.resolveSync(path, dirname(file));
      if (!resolved.replaceAll('\\', '/').includes('/node_modules/')) queue.push(resolved);
    }
  }
  expect(seen.size).toBeGreaterThan(100);
  return builtins;
}

test('the core starts without node:util or node:dns, which cost 9 and 2 MiB for two parsers and a tailnet lookup', () => {
  const builtins = staticBuiltins(join(import.meta.dir, '../src/core.ts'));
  expect(builtins.has('node:fs')).toBe(true);
  for (const name of ['node:util', 'node:dns', 'node:dns/promises']) expect([name, builtins.get(name) ?? []]).toEqual([name, []]);
});
