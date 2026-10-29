import {expect, spyOn, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {MuseSession} from '../src/drivers/muse/session.ts';
import * as bridgeModule from '../src/drivers/protected-bridge.ts';
import type {SessionContext} from '../src/drivers/types.ts';
import {startTestCore, waitFor} from './harness.ts';
import {thrown} from './settle.ts';

test('Muse admission failure stops its captured child even when bridge cleanup throws', async () => {
  const harness = await startTestCore(), core = harness.core;
  const client = await harness.connect(), project = await client.call('projects.add', {path: harness.dataDir});
  const echo = core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echo.id});
  const original = bridgeModule.protectedBridge;
  let directory = '', stopped = 0, ended = 0, released: Promise<unknown> | undefined;
  const logs: string[] = [];
  const bridge = spyOn(bridgeModule, 'protectedBridge').mockImplementation((...args) => {
    const actual = original(...args); directory = actual.directory;
    return {...actual, close(done) {
      released = done;
      actual.close(done);
      expect(existsSync(actual.cwd)).toBe(true);
      throw new Error('synthetic cleanup failure');
    }};
  });
  const session = new MuseSession('cleanup', 0, () => {ended++;});
  try {
    const provider = structuredClone(core.providers.require('muse'));
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: process.execPath}];
    const ctx = {provider, account: echo, accountEnv: {}, thread: {...thread, model: 'default', permissionMode: 'yolo'},
      protectedExecution: {fingerprint: 'synthetic', check() {}, async execute() {throw new Error('admission must precede tools');}}, sessionId: null, warmProcessMinutes: 0,
      log: (_level: string, message: string) => logs.push(message), context() {}, commands() {},
      spawnChild: (_cmd, _args, opts) => core.procs.spawnChild(thread.id, process.execPath, [join(import.meta.dir, 'fixtures/muse-server.ts')], opts),
      killTree: () => {stopped++; core.procs.killTree(thread.id);},
    } as SessionContext;
    // The fake host does not have the admitted native version/fingerprint.
    expect(await thrown(session.prepare(ctx))).toThrow('execution.muse.native');
    expect(stopped).toBe(1);
    expect(ended).toBe(1);
    expect(released).toBeDefined();
    await released;
    await waitFor(() => core.procs.liveCount(thread.id) === 0 && !existsSync(directory));
    expect(logs.some(line => line.includes('synthetic cleanup failure'))).toBe(true);
    session.close(null);
    expect(stopped).toBe(1);
    expect(ended).toBe(1);
  } finally {
    bridge.mockRestore(); session.close(null);
    await harness.stop();
  }
});
