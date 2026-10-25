import {test, expect} from 'bun:test';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir, release} from 'node:os';
import {join} from 'node:path';
import {capture, type Captured} from './capture.ts';
import {selectedEnvironment} from './environment.ts';

const native = process.platform === 'win32' && process.env.BOITE_TEST_DEBUG_MAP === '1';

test.skipIf(!native)('initial diagnostic: red root map, then concurrent LPAC debugger marker routing', async () => {
  const helper = process.env.BOITE_DEBUG_MAP_HELPER, output = process.env.BOITE_DEBUG_MAP_OUTPUT;
  if (!helper || !output) throw new Error('diagnostic requires BOITE_DEBUG_MAP_HELPER and BOITE_DEBUG_MAP_OUTPUT');
  // Do this before importing/constructing the real core. Installed accounts and
  // live provider probes are outside this fixture even on an opted-in runner.
  for (const key of Object.keys(process.env)) {
    if (/^BOITE_(E2E|BENCH|TEST_NATIVE)_/.test(key)) delete process.env[key];
  }
  process.env.BOITE_HOST_AGENTS = '0'; process.env.BOITE_TAILNET = '0';
  const {startTestCore, waitFor} = await import('../../../packages/core/test/harness.ts');
  const state = mkdtempSync(join(tmpdir(), 'boite-debug-map-'));
  const steps: ({id: string} & Captured)[] = [];
  const failures: string[] = [];
  const report: Record<string, unknown> = {kernel: release(), state, steps, failures, initialGatePassed: false, productionAccepted: false};
  const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  const harness = await startTestCore({dataDir: join(state, 'core-data')});
  const procs = harness.core.procs;
  const jobs = ['RED', 'A', 'B'].map(label => {
    const root = join(state, label), project = join(root, 'project'), runtime = join(root, 'runtime'), home = join(root, 'home');
    const marker = `TASK_ROUTE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
    return {label, root, project, runtime, home, marker, profile: `boite.debug.route.${crypto.randomUUID().replaceAll('-', '')}`};
  });
  const tasks: Promise<Captured>[] = [];
  const profileCleanup: Captured[] = [];
  async function execute(id: string, args: string[], home = state, extra: Record<string, string | undefined> = {}) {
    const child = procs.spawnPiped(id, helper!, args, {cwd: state, agentRoot: false,
      env: selectedEnvironment({HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TEMP: home, TMP: home, ...extra})});
    const result = await capture(procs, id, child, 40000);
    steps.push({id, ...result});
    writeFileSync(join(output!, `${id}.log`), `pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    console.log(`${id}: ${JSON.stringify(result)}`); save(); return result;
  }
  function run(job: typeof jobs[number], debug: boolean) {
    const promise = execute(`lpac-${job.label}`, [debug ? 'debug-run' : 'run', job.profile, job.project,
      join(job.runtime, 'inspect.exe'), 'inspect', '0', job.marker], job.home,
      {PATH: `${job.runtime};${process.env.SystemRoot}\\System32`});
    tasks.push(promise); void promise.catch(() => {}); return promise;
  }
  function check(result: Captured) { expect(result.timedOut).toBe(false); expect(result.code, result.err).toBe(0); }
  function boundary(result: Captured) {
    expect(result.err).toContain('job=1 nonbreakaway=1 package/capability=1 lpac=1');
    expect(result.err).toMatch(/caller snapshot=after .* unchanged=1/);
    expect(result.err).toContain('cleanup job-active=0');
    expect(result.err).toContain('cleanup map-open=0xc0000034 absent=1');
    expect(result.out).not.toContain('host-debug-control=1');
  }
  try {
    for (const job of jobs) {
      for (const directory of [job.root, job.project, job.runtime, job.home]) mkdirSync(directory);
      copyFileSync(helper, join(job.runtime, 'inspect.exe'));
      writeFileSync(join(job.project, 'null-map-marker'), job.marker);
    }
    const before = await execute('ordinary-before', ['observe', state]); check(before);
    for (const job of jobs) check(await execute(`setup-${job.label}`, ['setup', job.profile, job.root, job.project, job.runtime, job.home]));
    writeFileSync(join(jobs[0]!.project, 'release'), 'synthetic');
    const red = await run(jobs[0]!, false); report.red = red;
    expect(red.timedOut).toBe(false); expect(red.code).toBe(1); boundary(red);
    expect(red.out).toContain(`${jobs[0]!.marker}.generation-0 appcontainer=1 in-job=1 routing=1`);
    expect(red.out).toContain(`${jobs[0]!.marker}.generation-1 appcontainer=1 in-job=1 routing=0`);
    for (let depth = 0; depth < 3; depth++) {
      expect(red.out).toContain(`${jobs[0]!.marker}.generation-${depth} ambient-denial=5`);
      expect(red.out).toContain(`${jobs[0]!.marker}.generation-${depth} host-debug-control=0 known=1`);
    }
    const pending = jobs.slice(1).map(job => run(job, true));
    try {
      await waitFor(() => jobs.slice(1).every(job => existsSync(join(job.project, 'ready'))), 5000);
      report.overlap = true;
      const during = await execute('ordinary-during', ['observe', state]); check(during);
      expect(during.out).toBe(before.out);
    } finally {
      for (const job of jobs.slice(1)) writeFileSync(join(job.project, 'release'), 'synthetic');
    }
    const results = await Promise.all(pending); report.debug = results;
    const after = await execute('ordinary-after', ['observe', state]); check(after); expect(after.out).toBe(before.out);
    expect(report.overlap).toBe(true);
    for (const [index, result] of results.entries()) {
      check(result); boundary(result);
      const marker = jobs[index + 1]!.marker;
      for (let depth = 0; depth < 3; depth++) {
        expect(result.out).toContain(`${marker}.generation-${depth} appcontainer=1 in-job=1 routing=1`);
        expect(result.out).toContain(`${marker}.generation-${depth} ambient-denial=5`);
        expect(result.out).toContain(`${marker}.generation-${depth} host-debug-control=0 known=1`);
      }
      expect(result.out).not.toContain(jobs[index === 0 ? 2 : 1]!.marker);
      expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(3);
      expect(result.err.match(/debug-exception .*consumed=1/g)).toHaveLength(3);
      expect(result.err).toContain('debug-drain cleanup=0 captured=3 remaining=0 error=0');
      expect(result.err).toContain('debug-drain cleanup=1 captured=3 remaining=0 error=0');
    }
    report.routingObserved = true;
  } catch (error) { failures.push(String(error)); }
  finally {
    await Promise.allSettled(tasks);
    // Stop only processes belonging to this fresh harness, including on a failed assertion.
    await procs.killAll();
    for (const job of jobs) {
      try { profileCleanup.push(await execute(`cleanup-${job.label}`, ['cleanup', job.profile])); }
      catch (error) { failures.push(`profile ${job.label}: ${error}`); }
    }
    try { await harness.stop(); } catch (error) { failures.push(`core cleanup: ${error}`); }
    for (const result of profileCleanup) {
      if (result.code !== 0 || result.timedOut) failures.push(`profile cleanup failed: pid=${result.pid} code=${result.code}`);
    }
    // Do not erase state whose native job/object cleanup has not been confirmed.
    const launched = steps.filter(step => step.id.startsWith('lpac-'));
    const nativeCleanup = launched.every(step => !step.timedOut && step.err.includes('cleanup job-active=0') &&
      step.err.includes('cleanup map-open=0xc0000034 absent=1'));
    if (nativeCleanup) {
      try { rmSync(state, {recursive: true, force: true}); } catch (error) { failures.push(`state cleanup: ${error}`); }
    }
    report.cleanup = {nativeConfirmed: nativeCleanup, profiles: profileCleanup, stateExists: existsSync(state)};
    if (existsSync(state)) failures.push('synthetic state retained: native cleanup not proved or removal failed');
    report.initialGatePassed = report.routingObserved === true && failures.length === 0;
    save(); console.log(`DIAGNOSTIC initialGatePassed=${report.initialGatePassed} productionAccepted=false`);
  }
  expect(failures, JSON.stringify(report)).toEqual([]);
}, 90000);
