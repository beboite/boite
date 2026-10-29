import {expect, spyOn, test} from 'bun:test';
import {mkdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {Bus} from '../src/bus.ts';
import type {Core} from '../src/core.ts';
import {SharedNativeExecution} from '../src/contacts/native-execution.ts';
import {ProcRegistry} from '../src/procs.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import {startTestCore, waitFor} from './harness.ts';

for (const state of ['drained', 'revoked', 'occupied'] as const) {
  test(`shared native preparation drains untraced worktree processes: ${state}`, async () => {
    const harness = await startTestCore(), client = await harness.connect();
    const root = join(realpathSync(harness.dataDir), 'project'); mkdirSync(root);
    const project = await client.call('projects.add', {path: root});
    const account = await client.call('accounts.add', {providerId: 'pi', label: 'Synthetic preparation account'});
    const thread = await client.call('threads.create', {projectId: project.id, providerId: 'pi', accountId: account.id, permissionMode: 'yolo'});
    let nativePending = false, closed = false, opens = 0;
    const membershipRead = Promise.withResolvers<void>();
    const procs = new ProcRegistry(harness.core.journal, new Bus(), {...createPosixPlatform('linux', null),
      hasProcesses: id => {
        if (id !== thread.id || !nativePending) return false;
        membershipRead.resolve(); return true;
      },
      protectedExecution: {available: () => true, open: async () => {
        opens++;
        return {launch: (command, args, cwd) => ({command, args, cwd, env: {...process.env}}), flush() {}, close() {}};
      }},
    });
    // Real scope preparation and registry with a synthetic external scope and
    // OS boundary. No installed provider or credential is needed.
    const core: Core = Object.assign(Object.create(harness.core), {procs});
    const execution = new SharedNativeExecution(core, () => ({threadId: thread.id, checkoutPath: root,
      job: {id: null, sharedProjectId: 'preparation', grantRevision: 1,
        source: {project: {ownerCoreId: 'source', coreId: 'source', projectId: 'source'}, threadId: 'source', address: {coreId: 'source', threadId: 'source'}}},
    }), () => {if (closed) throw new Error('captured scope was revoked');});
    let outcome: Promise<unknown> | undefined;
    let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined;
    try {
      const prelude = procs.spawn(thread.id, 'git', ['--version'], {cwd: root});
      expect(await prelude.exited).toBe(0);
      await waitFor(() => procs.liveCount(thread.id) === 0);
      // Windows can still hold Git's untraced console after its root's exit.
      nativePending = true;
      outcome = execution.prepare(thread.id)!.then(() => null, error => error);
      await membershipRead.promise;
      await Bun.sleep(50);
      expect(opens).toBe(0);
      closed = state === 'revoked';
      if (state !== 'occupied') nativePending = false;
      else clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
      const error = await outcome;
      if (state === 'revoked') {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('captured scope was revoked');
        expect(opens).toBe(0);
      } else if (state === 'occupied') {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('did not exit within five seconds');
        expect(opens).toBe(0);
      } else {
        expect(error).toBeNull();
        expect(opens).toBe(1);
        expect(execution.context(thread.id)).toBeDefined();
        expect(procs.protection.policy(thread.id)?.route).toMatchObject({providerId: 'pi', accountId: account.id, permissionMode: 'yolo'});
      }
    } finally {
      clock?.mockRestore();
      nativePending = false;
      await outcome;
      await procs.close(); await harness.stop();
    }
  });
}
