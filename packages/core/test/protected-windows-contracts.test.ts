import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';

test('production Null scheduler grows, replays queued traps and validates native outputs', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'boite-production-null-contracts-'));
  const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    const compiler = process.platform === 'win32' ? Bun.which('gcc') || Bun.which('clang') : Bun.which('cc');
    if (!compiler) throw new Error('Production Null contract harness requires a C compiler');
    const binary = join(scratch, process.platform === 'win32' ? 'contracts.exe' : 'contracts');
    const run = async (id: string, command: string, args: string[]) => {
      const child = procs.spawnPiped(id, command, args, {cwd: scratch, agentRoot: false}); child.proc.stdin.end();
      const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
      expect(code, err).toBe(0); return out;
    };
    await run('compile-production-contracts', compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-I' + join(import.meta.dir, '../src/platform/windows'), join(import.meta.dir, 'fixtures/protected-null-contracts.c'), '-o', binary]);
    expect((await run('run-production-contracts', binary, [])).trim()).toBe(
      'PROTECTED_NULL growth=300 queued-replay=1 terminating-workers=2 balanced=1 cancellation=1 output-spans=1 qos-snapshot=1 create-abi=1');
  } finally {await procs.killAll(); await procs.close(); journal.close(); rmSync(scratch, {recursive: true, force: true});}
}, 20000);
