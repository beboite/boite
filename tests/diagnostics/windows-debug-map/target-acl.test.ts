import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../../../packages/core/src/journal.ts';
import {Bus} from '../../../packages/core/src/bus.ts';
import {ProcRegistry} from '../../../packages/core/src/procs.ts';
import {capture} from './capture.ts';
import {selectedEnvironment} from './environment.ts';

const compiler = process.platform === 'win32' ? null : Bun.which('cc');
test.skipIf(!compiler)('target ACL comparison accepts mapped rights and rejects authority or descriptor changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-target-acl-'));
  const journal = new Journal(join(directory, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    const executable = join(directory, 'target-acl-cases');
    const built = await capture(procs, 'compile-acl', procs.spawnPiped('compile-acl', compiler!,
      ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', join(import.meta.dir, 'target-acl-cases.c'), '-o', executable],
      {cwd: directory, env: selectedEnvironment(), agentRoot: false}), 15000);
    expect(built.timedOut).toBe(false); expect(built.code, built.out + built.err).toBe(0);
    const result = await capture(procs, 'acl-cases', procs.spawnPiped('acl-cases', executable, [],
      {cwd: directory, env: selectedEnvironment(), agentRoot: false}), 5000);
    expect(result.timedOut).toBe(false); expect(result.code, result.out + result.err).toBe(0);
    expect(result.out).toBe('TARGET_ACL_CASES_PASS: 18 cases\n');
  } finally {await procs.killAll(); await procs.close(); journal.close(); rmSync(directory, {recursive: true, force: true});}
}, 30000);
