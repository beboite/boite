import {expect, test} from 'bun:test';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Bus} from '../src/bus.ts';
import type {Core} from '../src/core.ts';
import {ProcRegistry} from '../src/procs.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import {overlap, snapshot} from '../src/threads/checkpoint-files.ts';
import {startTestCore} from './harness.ts';

test.each(['snapshot', 'overlap'] as const)('protected checkpoint %s keeps provider control alive and honors Git exclusions', async operation => {
  const h = await startTestCore();
  const root = join(realpathSync(h.dataDir), 'project'); mkdirSync(root);
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(root, 'ignored.txt'), 'ignored');
  writeFileSync(join(root, 'sub', 'ordinary.txt'), 'checkpoint');
  const init = Bun.spawn(['git', 'init', '-q', root], {stdout: 'ignore', stderr: 'pipe', windowsHide: true});
  expect(await init.exited).toBe(0);
  let toolLaunches = 0;
  const procs = new ProcRegistry(h.core.journal, new Bus(), {...createPosixPlatform('linux', null),
    protectedExecution: {available: () => true, open: async () => ({
      launch() {toolLaunches++; throw new Error('execution.command: Git is not a captured model tool');},
      flush() {}, close() {},
    })},
  });
  const core = {dataDir: h.core.dataDir, procs, sharedAccess: h.core.sharedAccess, threads: h.core.threads} as Core;
  const id = 'checkpoint';
  try {
    await procs.protection.install(id, {scope: {kind: 'letter', id: 'letter', associationId: 'shared', grantRevision: 1},
      checkout: root, credentialPaths: [], executables: [], expiresAt: Date.now() + 60000}, () => {});
    const control = procs.protection.control(id);
    procs.spawn(control, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    if (operation === 'snapshot') {
      const saved = await snapshot(core, id, root, join(h.dataDir, 'objects'));
      expect(Object.keys(saved).sort()).toEqual(['.gitignore', 'sub/ordinary.txt']);
    } else expect(await overlap(core, id, root, join(root, 'sub'))).toBe(true);
    expect(toolLaunches).toBe(0);
    expect(() => procs.protection.assert(id)).not.toThrow();
    expect(procs.liveCount(control)).toBe(1);
  } finally {await procs.close(); await h.stop();}
}, 15000);
