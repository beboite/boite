import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Protocol } from '@boite/contracts';
import { createAcpDriver } from '../src/drivers/acp.ts';
import { createMuseDriver } from '../src/drivers/muse.ts';
import { createPiDriver } from '../src/drivers/pi.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { Driver, ProbeContext } from '../src/drivers/types.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { countProcesses, readScriptedLog, writeScriptedProvider } from './scripted-provider.ts';
import { thrown } from './settle.ts';

const cases = [
  { protocol: 'acp' as const, fixture: 'acp-agent.ts', env: 'ACP_FAKE_LOG', prompt: 'session/prompt', create: () => createAcpDriver({ loadSdk: () => import('@agentclientprotocol/sdk') }) },
  { protocol: 'pi' as const, fixture: 'pi-agent.ts', env: 'PI_FAKE_LOG', prompt: 'prompt', create: createPiDriver },
  { protocol: 'muse' as const, fixture: 'muse-server.ts', env: 'MUSE_FAKE_LOG', prompt: 'turn/start', create: createMuseDriver },
];
let harness: TestCore | undefined;
let driver: Driver | undefined;
let restore: (() => void) | undefined;

afterEach(async () => {
  driver?.shutdown?.();
  await harness?.stop();
  restore?.();
  for (const entry of cases) delete process.env[entry.env];
  driver = undefined;
  harness = undefined;
  restore = undefined;
});

async function setup(entry: typeof cases[number]) {
  harness = await startTestCore({ settings: { warmProcessMinutes: 0 } });
  driver = entry.create();
  restore = setDriver(entry.protocol, driver);
  const client = await harness.connect();
  const log = join(harness.dataDir, `${entry.protocol}.log`);
  process.env[entry.env] = log;
  writeScriptedProvider(harness.dataDir, fileURLToPath(new URL(`./fixtures/${entry.fixture}`, import.meta.url)), {
    id: 'prepared-fake', schemaVersion: 1, name: 'Prepared fixture', shortName: 'Fixture', protocol: entry.protocol as Protocol,
    roots: ['{isolationDir}'], auth: { kind: 'none' }, models: [{ id: 'default', name: 'Agent default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
  });
  await client.call('providers.reload', {});
  const project = await client.call('projects.add', { path: harness.dataDir, name: 'Prepared fixture' });
  const account = await client.call('accounts.add', { providerId: 'prepared-fake', label: 'Fixture', useDefaultLocation: true });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'prepared-fake', accountId: account.id, title: 'Lifecycle', model: 'default' });
  await client.call('threads.subscribe', { threadId: thread.id });
  const core = harness.core;
  const ctx = core.threads.contexts.makeSessionContext(core.threads.get(thread.id), core.providers.require('prepared-fake'), core.accounts.require(account.id));
  const events = countProcesses(client, thread.id);
  // Native Windows events also include descendants such as console hosts.
  // These assertions count the providers launched directly by this core.
  const processes = {
    get started() { return events.started.filter(record => record.parentPid === process.pid); },
    get exited() { return events.exited.filter(record => record.parentPid === process.pid); },
  };
  const run = async (prompt: string) => {
    const finished = client.next('turn.finished', turn => turn.threadId === thread.id);
    await client.call('turns.start', { threadId: thread.id, prompt });
    expect((await finished).status).toBe('done');
  };
  const probe: ProbeContext = {
    catalogThread: ctx.thread, provider: ctx.provider, accountId: ctx.account.id, accountEnv: ctx.accountEnv,
    cwd: core.dataDir, log: ctx.log,
    spawnChild: (cmd, args, opts) => core.procs.spawnChild('prepared-model-probe', cmd, args, opts),
    killTree: () => { core.procs.killTree('prepared-model-probe'); },
  };
  return { core, client, ctx, processes, probe, log: () => readScriptedLog(log), run };
}

for (const entry of cases) describe(`${entry.protocol} prompt-free preparation`, () => {
  test('preparing twice submits no prompt or turn, and both zero-warm turns reuse the process', async () => {
    const fixture = await setup(entry);
    await Promise.all([driver!.prepare!(fixture.ctx), driver!.prepare!(fixture.ctx)]);
    expect(fixture.core.journal.listTurns(fixture.ctx.thread.id)).toHaveLength(0);
    expect(fixture.log()).not.toContain(entry.prompt);
    expect(fixture.processes.started).toHaveLength(1);
    await fixture.run('first');
    await fixture.run('second');
    expect(fixture.processes.started).toHaveLength(1);
    expect(fixture.core.procs.liveCount(fixture.ctx.thread.id)).toBe(1);
    driver!.setViewed!(fixture.ctx.thread.id, true);
    driver!.setViewed!(fixture.ctx.thread.id, false);
    expect(fixture.core.procs.liveCount(fixture.ctx.thread.id)).toBe(1);
    driver!.releaseThread!(fixture.ctx.thread.id);
    await waitFor(() => fixture.core.procs.liveCount(fixture.ctx.thread.id) === 0);
  });

  test('checkpoint-only preparation reuses startup and preserves zero post-turn retention', async () => {
    const fixture = await setup(entry);
    await driver!.prepare!(fixture.ctx, { forTurn: true });
    expect(fixture.processes.started).toHaveLength(1);
    await fixture.run('checkpoint turn');
    await waitFor(() => fixture.core.procs.liveCount(fixture.ctx.thread.id) === 0);
    expect(fixture.processes.started).toHaveLength(1);
    await fixture.run('next cold turn');
    expect(fixture.processes.started).toHaveLength(2);
  });

  test('release during startup closes the owned child, rejects preparation and allows a later turn', async () => {
    const fixture = await setup(entry);
    const stalled = join(harness!.dataDir, 'stall-startup.ts');
    const booted = join(harness!.dataDir, 'stall-startup.boot');
    writeFileSync(stalled, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(booted)}, String(process.pid));
setInterval(() => {}, 1000);`);
    const launches: { pid: number | undefined; cmd: string; args: string[] }[] = [];
    const launch = fixture.core.procs.spawnChild.bind(fixture.core.procs);
    fixture.core.procs.spawnChild = (threadId, cmd, args, opts) => {
      const child = launch(threadId, cmd, args, opts);
      if (threadId === fixture.ctx.thread.id) launches.push({ pid: child.pid, cmd, args: [...args] });
      return child;
    };
    const spawnChild = fixture.ctx.spawnChild;
    fixture.ctx.spawnChild = (cmd, _args, opts) => spawnChild(cmd, [stalled], opts);
    const pending = driver!.prepare!(fixture.ctx).then(() => 'ready', () => 'closed');
    // A registry start precedes execution of the script. Release a booted agent
    // stalled in its protocol handshake, rather than racing Windows' native
    // start events for a process killed before its fixture could run.
    await waitFor(() => readScriptedLog(booted).length > 0);
    expect(launches[0]?.pid).toBe(Number(readScriptedLog(booted)));
    expect(launches).toHaveLength(1);
    await waitFor(() => fixture.processes.started.length === 1);
    driver!.releaseThread!(fixture.ctx.thread.id);
    expect(await pending).toBe('closed');
    await waitFor(() => fixture.core.procs.liveCount(fixture.ctx.thread.id) === 0);
    expect(fixture.core.journal.listTurns(fixture.ctx.thread.id)).toHaveLength(0);
    await fixture.run('recover');
    if (launches.length !== 2 || fixture.processes.started.length !== 2) {
      console.error('PREPARED_RELEASE_PROCESS_DIAGNOSTIC', JSON.stringify({
        protocol: entry.protocol, launches, started: fixture.processes.started, exited: fixture.processes.exited,
      }));
    }
    expect(launches).toHaveLength(2);
    expect(fixture.processes.started).toHaveLength(2);
  });

  test('a failed preparation closes its process and a later turn recovers', async () => {
    const fixture = await setup(entry);
    const launches: { pid: number | undefined; cmd: string; args: string[] }[] = [];
    const launch = fixture.core.procs.spawnChild.bind(fixture.core.procs);
    fixture.core.procs.spawnChild = (threadId, cmd, args, opts) => {
      const child = launch(threadId, cmd, args, opts);
      if (threadId === fixture.ctx.thread.id) launches.push({ pid: child.pid, cmd, args: [...args] });
      return child;
    };
    const spawnChild = fixture.ctx.spawnChild;
    fixture.ctx.spawnChild = (cmd, _args, opts) => spawnChild(cmd, ['-e', 'process.exit(4)'], opts);
    expect(await thrown(driver!.prepare!(fixture.ctx))).toThrow();
    await waitFor(() => fixture.core.procs.liveCount(fixture.ctx.thread.id) === 0);
    expect(fixture.core.journal.listTurns(fixture.ctx.thread.id)).toHaveLength(0);
    // Windows can report a console host beneath the failed agent. It is not
    // another provider launch, even when its executable could not be read.
    await waitFor(() => fixture.processes.started.length > 0);
    const root = fixture.processes.started[0]!;
    const descendant = fixture.client.next('process.started', record => record.parentPid === root.pid);
    fixture.core.bus.emit('process.started', { ...root, pid: root.pid + 1, parentPid: root.pid, exe: 'unknown', commandLine: null });
    await descendant;
    await fixture.run('recover');
    if (launches.length !== 2 || fixture.processes.started.length !== 2) {
      console.error('PREPARED_FAILURE_PROCESS_DIAGNOSTIC', JSON.stringify({
        protocol: entry.protocol, launches, started: fixture.processes.started, exited: fixture.processes.exited,
      }));
    }
    expect(launches).toHaveLength(2);
    expect(fixture.processes.started).toHaveLength(2);
  });
});

test('ACP prepared options supply the selected model efforts without mutating the session; refresh uses a probe', async () => {
  const fixture = await setup(cases[0]!);
  fixture.ctx.thread.model = 'fake-smart';
  fixture.ctx.thread.effort = null;
  await driver!.prepare!(fixture.ctx);
  const before = fixture.log();
  const probe = { ...fixture.probe, model: 'fake-smart' };
  const catalog = await driver!.probe!(probe);
  expect(catalog.models.find(model => model.id === 'fake-smart')?.effort?.levels.length).toBeGreaterThan(0);
  expect(fixture.log()).toBe(before);
  driver!.forgetProbes!({ providerId: probe.provider.id, accountId: probe.accountId });
  expect(driver!.probedModels!(probe.provider.id, probe.accountId)).toBeNull();
  await driver!.probe!(probe);
  expect(fixture.log().split('initialize').length).toBe(before.split('initialize').length + 1);
  expect(fixture.core.journal.listTurns(fixture.ctx.thread.id)).toHaveLength(0);
  expect(fixture.core.procs.liveCount(fixture.ctx.thread.id)).toBe(1);
});

for (const mismatch of ['unscoped', 'thread', 'cwd', 'context', 'environment', 'launch'] as const) {
  test(`ACP ${mismatch} catalog requests use an isolated probe without changing the prepared session`, async () => {
    const fixture = await setup(cases[0]!);
    await driver!.prepare!(fixture.ctx);
    const before = fixture.log();
    const scope = fixture.ctx.thread;
    const probe: ProbeContext = { ...fixture.probe };
    if (mismatch === 'unscoped') probe.catalogThread = undefined;
    else if (mismatch === 'thread') probe.catalogThread = { ...scope, id: 'other-fixture-thread' };
    else if (mismatch === 'cwd') probe.catalogThread = { ...scope, cwd: join(fixture.core.dataDir, 'other-workspace') };
    else if (mismatch === 'context') probe.catalogThread = { ...scope, contextMode: { label: 'neutral', instructions: false, guides: false, mcp: false, hooks: false, tools: null, rules: null } };
    else if (mismatch === 'environment') probe.accountEnv = { ...probe.accountEnv, FAKE_SCOPE: 'other' };
    else {
      const profiles = structuredClone(probe.provider.profiles);
      for (const profile of Object.values(profiles)) if (profile?.launch) profile.launch.args = [...(profile.launch.args ?? []), '--catalog-fixture-change'];
      probe.provider = { ...probe.provider, profiles };
    }
    await driver!.probe!(probe);
    expect(fixture.log().split('initialize').length).toBe(before.split('initialize').length + 1);
    expect(fixture.log()).not.toContain('session/prompt');
    expect(fixture.core.procs.liveCount(fixture.ctx.thread.id)).toBe(1);
    expect(fixture.core.journal.listTurns(fixture.ctx.thread.id)).toHaveLength(0);
  });
}

test('ACP releasing during SDK loading cannot spawn a late process', async () => {
  const fixture = await setup(cases[0]!);
  driver!.shutdown!();
  let releaseSdk!: (sdk: typeof import('@agentclientprotocol/sdk')) => void;
  const sdk = new Promise<typeof import('@agentclientprotocol/sdk')>(resolve => { releaseSdk = resolve; });
  driver = createAcpDriver({ loadSdk: () => sdk });
  const pending = driver.prepare!(fixture.ctx).then(() => 'ready', () => 'closed');
  driver.releaseThread!(fixture.ctx.thread.id);
  releaseSdk(await import('@agentclientprotocol/sdk'));
  expect(await pending).toBe('closed');
  expect(fixture.processes.started).toHaveLength(0);
  expect(fixture.core.procs.liveCount(fixture.ctx.thread.id)).toBe(0);
});

test('ACP a refresh asked while the draft session opens takes its catalog instead of another process', async () => {
  const fixture = await setup(cases[0]!);
  // The composer refreshes the cached list as the app opens, while the draft's own process starts.
  const preparation = driver!.prepare!(fixture.ctx);
  driver!.forgetProbes!({ providerId: fixture.probe.provider.id, accountId: fixture.probe.accountId, refresh: true });
  const catalog = await driver!.probe!(fixture.probe);
  await preparation;
  expect(catalog.models.length).toBeGreaterThan(1);
  expect(fixture.log().split('initialize').length - 1).toBe(1);
});

test('ACP catalog requests share pending preparation and probe another model without changing its selected settings', async () => {
  const fixture = await setup(cases[0]!);
  fixture.ctx.thread.model = 'fake-smart';
  fixture.ctx.thread.effort = null;
  const preparation = driver!.prepare!(fixture.ctx);
  const scoped = { ...fixture.probe, model: 'fake-smart' };
  const catalog = await driver!.probe!(scoped);
  await preparation;
  expect(fixture.log().split('initialize').length - 1).toBe(1);
  expect(catalog.models.find(model => model.id === 'fake-smart')?.effort?.levels.map(level => level.id)).toEqual(['low', 'high', 'max']);
  const other = { ...scoped, model: 'fake-fast' };
  const [first, second] = await Promise.all([driver!.probe!(other), driver!.probe!(other)]);
  expect(first.models.find(model => model.id === 'fake-fast')?.effort).toBeDefined();
  expect(second.models.find(model => model.id === 'fake-smart')?.effort?.levels.map(level => level.id)).toEqual(['low', 'high', 'max']);
  expect(fixture.log().split('initialize').length - 1).toBe(2);
  expect(fixture.log().split('set_config_option model fake-smart').length - 1).toBe(1);
  expect(fixture.log()).not.toContain('session/prompt');
  expect(fixture.core.procs.liveCount(fixture.ctx.thread.id)).toBe(1);
});

test('ACP refreshing during preparation prevents its late options from restoring an invalidated catalog', async () => {
  const fixture = await setup(cases[0]!);
  driver!.shutdown!();
  let releaseSdk!: (sdk: typeof import('@agentclientprotocol/sdk')) => void;
  const sdk = new Promise<typeof import('@agentclientprotocol/sdk')>(resolve => { releaseSdk = resolve; });
  driver = createAcpDriver({ loadSdk: () => sdk });
  const preparation = driver.prepare!(fixture.ctx);
  driver.forgetProbes!({ providerId: fixture.ctx.provider.id, accountId: fixture.ctx.account.id });
  releaseSdk(await import('@agentclientprotocol/sdk'));
  await preparation;
  expect(driver.probedModels!(fixture.ctx.provider.id, fixture.ctx.account.id)).toBeNull();
  await driver.probe!(fixture.probe);
  expect(fixture.log().split('initialize').length - 1).toBe(2);
  expect(fixture.log()).not.toContain('session/prompt');
});
