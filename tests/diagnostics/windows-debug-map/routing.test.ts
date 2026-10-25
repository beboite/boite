import {test, expect} from 'bun:test';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir, release} from 'node:os';
import {join} from 'node:path';
import {capture, type Captured} from './capture.ts';
import {selectedEnvironment} from './environment.ts';
import {verifyOwnershipPlatform} from './ownership-generate.ts';

const native = process.platform === 'win32' && process.env.BOITE_TEST_DEBUG_MAP === '1';

test.skipIf(!native)('initial diagnostic: red root map, then concurrent LPAC debugger marker routing', async () => {
  const helper = process.env.BOITE_DEBUG_MAP_HELPER, output = process.env.BOITE_DEBUG_MAP_OUTPUT;
  if (!helper || !output) throw new Error('diagnostic requires BOITE_DEBUG_MAP_HELPER and BOITE_DEBUG_MAP_OUTPUT');
  if (process.env.BOITE_DEBUG_MAP_OWNERSHIP !== '1') throw new Error('diagnostic requires both registry ownership traces');
  await verifyOwnershipPlatform();
  const {ownershipTrace} = await import('./ownership-trace.ts');
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
  const cleanupConfirmed = new Map<string, boolean>();
  const afterExit: Record<string, unknown>[] = []; report.mapAfterHelperExit = afterExit;
  async function execute(id: string, args: string[], home = state, extra: Record<string, string | undefined> = {}) {
    const child = procs.spawnPiped(id, helper!, args, {cwd: state, agentRoot: false,
      env: selectedEnvironment({HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TEMP: home, TMP: home, BOITE_DEBUG_MAP_OWNERSHIP: '1', ...extra})});
    const result = await capture(procs, id, child, 40000);
    steps.push({id, ...result});
    writeFileSync(join(output!, `${id}.log`), `pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    console.log(`${id}: ${JSON.stringify(result)}`); save(); return result;
  }
  function run(job: typeof jobs[number], debug: boolean) {
    const promise = execute(`lpac-${job.label}`, [debug ? 'debug-run' : 'run', job.profile, job.project,
      join(job.runtime, 'inspect.exe'), 'inspect', '0', job.marker, ...(debug ? ['forward-check'] : [])], job.home,
      {PATH: `${job.runtime};${process.env.SystemRoot}\\System32`});
    tasks.push(promise); void promise.catch(() => {}); return promise;
  }
  // Every failed assertion stays in the initial gate even if observation continues.
  function verify(label: string, assertion: () => void): boolean {
    try { assertion(); return true; }
    catch (error) { failures.push(`${label}: ${error}`); return false; }
  }
  function completed(label: string, result: Captured, expected = 0): boolean {
    return [verify(`${label} deadline`, () => expect(result.timedOut).toBe(false)),
      verify(`${label} exit`, () => expect(result.code, result.err).toBe(expected))].every(Boolean);
  }
  function observer(label: string, result: Captured, before?: Captured): boolean {
    return [completed(label, result),
      verify(`${label} output`, () => expect(result.out).toMatch(/^observer NUL=.+ drive=.+ map=.+\r?\n$/)),
      verify(`${label} ambient unchanged`, () => {if (before) expect(result.out).toBe(before.out);})].every(Boolean);
  }
  function boundary(label: string, result: Captured, marker: string): boolean {
    const checks = [
      verify(`${label} finished`, () => {expect(result.timedOut).toBe(false); expect(result.code).not.toBeNull();}),
      verify(`${label} lowbox`, () => expect(result.err).toContain('job=1 nonbreakaway=1 package/capability=1 lpac=1')),
      verify(`${label} caller before`, () => expect(result.err).toMatch(/caller snapshot=before .* unchanged=1/)),
      verify(`${label} caller after`, () => expect(result.err).toMatch(/caller snapshot=after .* unchanged=1/)),
      verify(`${label} caller equality`, () => expect(result.err.match(/^caller snapshot=after (.+)\r?$/m)?.[1])
        .toBe(result.err.match(/^caller snapshot=before (.+)\r?$/m)?.[1])),
      verify(`${label} owned processes gone`, () => expect(result.err).toContain('cleanup job-active=0')),
      verify(`${label} no debugger control`, () => expect(result.out).not.toContain('host-debug-control=1')),
    ];
    for (let depth = 0; depth < 3; depth++) {
      const generation = `${marker}.generation-${depth}`;
      checks.push(
        verify(`${label} generation ${depth} boundary`, () => expect(result.out).toContain(`${generation} appcontainer=1 in-job=1 routing=`)),
        verify(`${label} generation ${depth} ambient`, () => expect(result.out).toContain(`${generation} ambient-denial=5`)),
        verify(`${label} generation ${depth} debugger`, () => expect(result.out).toContain(`${generation} host-debug-control=0 known=1`)),
        verify(`${label} generation ${depth} normal exit`, () => expect(result.out)
          .toMatch(new RegExp(`${marker}\\.generation-${depth} inspect-exit=[01] child-exit=[01] forced=0\\r?\\n`))),
      );
      if (depth < 2) checks.push(verify(`${label} generation ${depth} child`, () => expect(result.out)
        .toMatch(new RegExp(`${marker}\\.generation-${depth} child-created=1 pid=\\d+ error=0\\r?\\n`))));
    }
    for (const object of ['root-thread', 'root-process', 'job']) checks.push(
      verify(`${label} ${object} closed`, () => expect(result.err).toContain(`cleanup close=${object} closed=1 error=0`)));
    return checks.every(Boolean);
  }
  function cleanup(label: string, result: Captured) {
    const checks = [
      verify(`${label} immediate map absence`, () => expect(result.err).toContain('cleanup map-open=0xc0000034 absent=1')),
      verify(`${label} eventual map absence`, () => expect(result.err)
        .toMatch(/cleanup map-eventual-open=0xc0000034 absent=1 elapsed-ms=\d+ attempts=\d+ limit-ms=2000/)),
      verify(`${label} retention checkpoint`, () => {
        const checkpoint = result.err.match(/^ownership-checkpoint helper=(\d+) wall-ms=(\d+) targets=([\d,]+) hold-ms=3000\r?$/m);
        expect(checkpoint?.[1]).toBe(String(result.pid));
        expect(Number(checkpoint?.[2])).toBeGreaterThan(0);
        const targets = checkpoint?.[3]?.split(',') ?? [];
        const inspected = [...result.out.matchAll(/^inspect-start=\S+ pid=(\d+)\r?$/gm)].map(match => match[1]!);
        expect(new Set(targets)).toEqual(new Set(label === 'RED' ? inspected.slice(0, 1) : inspected));
        expect(result.err.indexOf('ownership-checkpoint ')).toBeGreaterThan(result.err.indexOf('cleanup map-eventual-open='));
        expect(result.err).toMatch(/cleanup checkpoint-map-open=0x[\da-f]+ absent=[01] closed=1 error=0 wall-ms=\d+/);
      }),
    ];
    for (const object of ['root-thread', 'root-process', 'job', 'map-before-link-close', 'link', 'map']) checks.push(
      verify(`${label} ${object} counts`, () => expect(result.err).toMatch(new RegExp(
        `cleanup object=${object} handle=\\S+ query=0x00000000 attributes=0x[0-9a-f]+ granted=0x[0-9a-f]+ handles=\\d+ pointers=\\d+`))));
    for (const object of ['root-thread', 'root-process', 'job', 'link', 'map']) checks.push(
      verify(`${label} ${object} closure`, () => expect(result.err).toContain(`cleanup close=${object} closed=1 error=0`)));
    for (const phase of ['after-create subject=directory', 'after-create subject=link', 'before-assign subject=process', 'after-assign subject=process', 'before-close subject=map']) checks.push(
      verify(`${label} map lifetime ${phase}`, () => expect(result.err).toMatch(new RegExp(
        `map-lifetime phase=${phase} pid=${result.pid} query=0x00000000 matches=[1-9]\\d* error=0\\r?\\n`))));
    if (label === 'RED') {
      for (const step of ['A-to-B', 'B-to-A']) checks.push(verify(`RED suspended map ${step}`, () => expect(result.err)
        .toMatch(new RegExp(`map-swap pid=\\d+ step=${step} set=0x00000000\\r?\\n`))));
      checks.push(verify('RED swap handle closed', () => expect(result.err).toContain('cleanup close=swap-map closed=1 error=0')));
      for (const phase of ['after-restore', 'final']) checks.push(verify(`RED swap absence ${phase}`, () => expect(result.err)
        .toContain(`cleanup swap-open phase=${phase} status=0xc0000034 absent=1 closed=1 error=0`)));
      for (const object of ['swap-before-assign', 'primary-after-swap-away', 'swap-after-assign', 'primary-after-swap-back', 'swap-after-restore']) checks.push(
        verify(`RED swap counts ${object}`, () => expect(result.err).toMatch(new RegExp(
          `cleanup object=${object} handle=\\S+ query=0x00000000 .*handles=\\d+ pointers=\\d+`))));
    }
    cleanupConfirmed.set(`lpac-${label}`, !result.timedOut && result.code !== null &&
      result.err.includes('cleanup job-active=0') && checks.every(Boolean));
  }
  async function observeAfterExit(label: string, result: Captured) {
    // capture has awaited the exact spawned helper's exit and pipe EOF. Never
    // infer disappearance from a timeout or rewrite its immediate absence gate.
    if (result.timedOut || result.code === null) {
      cleanupConfirmed.set(`lpac-${label}`, false);
      failures.push(`${label} post-exit map observation requires completed helper`); return;
    }
    const names = [...result.err.matchAll(/^private-(map|swap) path=(.+) create=0x00000000\r?$/gm)]
      .map(match => ({kind: match[1]!, path: match[2]!.replace(/\r$/, '')}));
    if (!verify(`${label} owned map name`, () => {
      expect(names).toHaveLength(label === 'RED' ? 2 : 1);
      expect(new Set(names.map(name => name.kind)).size).toBe(names.length);
      for (const name of names) expect(name.path).toMatch(new RegExp(
        `^\\\\(?:Sessions\\\\\\d+\\\\)?BaseNamedObjects\\\\boite\\.route\\.${result.pid}${name.kind === 'swap' ? '\\.swap' : ''}$`));
    })) { cleanupConfirmed.set(`lpac-${label}`, false); return; }
    for (const name of names) {
      const observed = await execute(`map-after-exit-${label}${name.kind === 'swap' ? '-swap' : ''}`, ['observe-map', name.path]);
      afterExit.push({label, kind: name.kind, helperPid: result.pid, path: name.path, ...observed}); save();
      // Extra observation, never a replacement for either immediate gate.
      const confirmed = [completed(`${label} ${name.kind} post-exit observer`, observed),
        verify(`${label} ${name.kind} post-exit map absence`, () => expect(observed.out)
          .toBe(`map-after-helper-exit path=${name.path} open=0xc0000034 absent=1 closed=1 error=0\r\n`))].every(Boolean);
      if (!confirmed) cleanupConfirmed.set(`lpac-${label}`, false);
    }
  }
  try {
    for (const job of jobs) {
      for (const directory of [job.root, job.project, job.runtime, job.home]) mkdirSync(directory);
      copyFileSync(helper, join(job.runtime, 'inspect.exe'));
      writeFileSync(join(job.project, 'null-map-marker'), job.marker);
    }
    const before = await execute('ordinary-before', ['observe', state]);
    if (!observer('before', before)) throw new Error('ordinary baseline unavailable; no protected task launched');
    for (const job of jobs) {
      const setup = await execute(`setup-${job.label}`, ['setup', job.profile, job.root, job.project, job.runtime, job.home]);
      const valid = [completed(`setup ${job.label}`, setup),
        verify(`setup ${job.label} output`, () => expect(setup.out).toBe('protected-native-prepared'))].every(Boolean);
      if (!valid) throw new Error(`setup ${job.label} failed; no protected task launched`);
    }
    writeFileSync(join(jobs[0]!.project, 'release'), 'synthetic');
    const redStart = failures.length;
    const red = await run(jobs[0]!, false); report.red = red;
    completed('RED', red, 1);
    const redSafe = boundary('RED', red, jobs[0]!.marker);
    cleanup('RED', red);
    await observeAfterExit('RED', red);
    for (let depth = 0; depth < 3; depth++) verify(`RED generation ${depth} routing`, () => expect(red.out)
      .toContain(`${jobs[0]!.marker}.generation-${depth} appcontainer=1 in-job=1 routing=${depth === 0 ? 1 : 0}`));
    const between = await execute('ordinary-after-red', ['observe', state]);
    const ambientSafe = observer('after RED', between, before);
    report.redPassed = failures.length === redStart;
    report.redSafetyPassed = redSafe && ambientSafe;
    save();
    // RED exit/routing/map-absence failures remain fatal to acceptance. A/B may
    // still observe its independent mechanism after the boundary, caller/ambient
    // state and absence of owned processes have separately been established.
    if (report.redSafetyPassed !== true) {
      report.debugSkipped = 'RED process/caller/ambient safety prerequisites not established';
      failures.push(String(report.debugSkipped));
    } else {
      const debugStart = failures.length;
      report.debugStarted = true; save();
      const pending = jobs.slice(1).map(job => run(job, true));
      try {
        await waitFor(() => jobs.slice(1).every(job => existsSync(join(job.project, 'ready'))), 5000);
        report.overlap = true;
        const during = await execute('ordinary-during', ['observe', state]); observer('during', during, before);
      } catch (error) { failures.push(`independent overlap/observer: ${error}`); }
      finally {
        for (const job of jobs.slice(1)) writeFileSync(join(job.project, 'release'), 'synthetic');
      }
      const results = await Promise.allSettled(pending); report.debug = results;
      const after = await execute('ordinary-after', ['observe', state]); observer('after', after, before);
      verify('independent overlap', () => expect(report.overlap).toBe(true));
      for (const [index, settled] of results.entries()) {
        const job = jobs[index + 1]!;
        if (settled.status === 'rejected') {failures.push(`${job.label} capture: ${settled.reason}`); continue;}
        const result = settled.value, marker = job.marker;
        completed(job.label, result); boundary(job.label, result, marker); cleanup(job.label, result);
        await observeAfterExit(job.label, result);
        // Every generation must correspond to a verified exact target image,
        // not a count padded by an auxiliary created before inspector output.
        const targets = [...result.out.matchAll(new RegExp(`^inspect-start=${marker}\\.generation-[012] pid=(\\d+)\\r?$`, 'gm'))].map(match => match[1]!);
        verify(`${job.label} target identities`, () => {
          expect(new Set(targets).size).toBe(3);
          expect(result.err.match(/debug-image .*role=target identity=1 .*error=0/g)).toHaveLength(3);
          for (const pid of targets) {
            expect(result.err).toMatch(new RegExp(`debug-image pid=${pid} tid=\\d+ handle-tid=\\d+ thread-owner=${pid} root=[01] role=target identity=1 .*error=0`));
            expect(result.err).toMatch(new RegExp(`debug-event-boundary pid=${pid} tid=\\d+ verified=1 error=0`));
          }
          for (let depth = 1; depth < 3; depth++) {
            expect(result.err).toMatch(new RegExp(`debug-parent pid=${targets[depth]} query=0x00000000 bytes=48 known=1 reported-pid=${targets[depth]} parent=${targets[depth - 1]}(?:\\r?\\n|$)`));
          }
        });
        const auxiliary = [...result.err.matchAll(/debug-image pid=(\d+) tid=\d+ handle-tid=\d+ thread-owner=\d+ root=0 role=auxiliary identity=1 .*error=0/g)];
        verify(`${job.label} one exact console auxiliary per target`, () => {
          expect(auxiliary).toHaveLength(3);
          expect(new Set(auxiliary.map(match => match[1]!)).size).toBe(3);
          expect(result.err).not.toContain('role=unknown');
          expect(result.err).toContain('debug-file label=trusted-conhost');
          const parents: string[] = [];
          for (const match of auxiliary) {
            const pid = match[1]!;
            expect(targets).not.toContain(pid);
            expect(result.err).toMatch(new RegExp(`debug-event-boundary pid=${pid} tid=\\d+ verified=1 error=0`));
            const parent = result.err.match(new RegExp(`debug-parent pid=${pid} query=0x00000000 bytes=48 known=1 reported-pid=${pid} parent=(\\d+)(?:\\r?\\n|$)`));
            expect(parent).not.toBeNull();
            parents.push(parent![1]!);
          }
          expect(new Set(parents)).toEqual(new Set(targets));
          expect(result.err).toContain('target-count=3 auxiliary-count=3 error=0');
        });
        verify(`${job.label} pinned native startup rule`, () => expect(result.err)
          .toContain('debug-startup-rule pinned=1 site-rva=0x0011ee1d symbol=LdrpDoDebuggerBreak+0x35 code-bytes=62'));
        for (let depth = 0; depth < 3; depth++) {
          verify(`${job.label} generation ${depth} routing`, () => expect(result.out)
            .toContain(`${marker}.generation-${depth} appcontainer=1 in-job=1 routing=1`));
          verify(`${job.label} generation ${depth} exit`, () => expect(result.out)
            .toContain(`${marker}.generation-${depth} inspect-exit=0 child-exit=0 forced=0`));
          verify(`${job.label} generation ${depth} application exception`, () => expect(result.out)
            .toContain(`${marker}.generation-${depth} application-exception-forwarded=1 handler-removed=1`));
        }
        verify(`${job.label} distinct marker`, () => expect(result.out).not.toContain(jobs[index === 0 ? 2 : 1]!.marker));
        for (const pid of [...targets, ...auxiliary.map(match => match[1]!)]) {
          verify(`${job.label} process ${pid} loader breakpoint`, () => expect(result.err).toMatch(new RegExp(
            `debug-exception pid=${pid} code=0x80000003 first=1 .*consumed=1 .*native-identity=1 in-native=1 native-rva=0x11ee1d continuation=0x00010002`)));
          if (targets.includes(pid)) verify(`${job.label} process ${pid} application exception forwarded`, () => expect(result.err).toMatch(new RegExp(
            `debug-exception pid=${pid} code=0xe0424f49 first=1 .*consumed=0 .*continuation=0x80010001 parameters=2 payload=0x626f6974 owner=${pid}(?:\\r?\\n|$)`)));
        }
        // Three target generations, each with its own file-identified, confined
        // console helper. Unknown images and a second helper per target fail.
        verify(`${job.label} mapped processes`, () => expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(6));
        verify(`${job.label} loader breakpoints`, () => expect(result.err.match(/debug-exception .*consumed=1/g)).toHaveLength(6));
        verify(`${job.label} process exit events`, () => expect(result.err.match(/debug-exit pid=\d+ status=0 active=\d+/g)).toHaveLength(6));
        verify(`${job.label} normal drain`, () => expect(result.err).toContain('debug-drain cleanup=0 captured=6 remaining=0 error=0'));
        verify(`${job.label} cleanup drain`, () => expect(result.err).toContain('debug-drain cleanup=1 captured=6 remaining=0 error=0'));
      }
      report.routingObserved = failures.length === debugStart;
    }
  } catch (error) { failures.push(String(error)); }
  finally {
    const settled = await Promise.allSettled(tasks);
    for (const result of settled) if (result.status === 'rejected') failures.push(`task capture: ${result.reason}`);
    // Stop only processes belonging to this fresh harness, including on a failed assertion.
    try { await procs.killAll(); } catch (error) { failures.push(`process cleanup: ${error}`); }
    for (const job of jobs) {
      try {
        const result = await execute(`cleanup-${job.label}`, ['cleanup', job.profile]); profileCleanup.push(result);
        completed(`profile ${job.label}`, result);
        for (const operation of ['delete', 'recreate', 'final-delete']) verify(`profile ${job.label} ${operation}`, () => expect(result.out)
          .toContain(`profile ${operation}=0x00000000`));
      } catch (error) { failures.push(`profile ${job.label}: ${error}`); }
    }
    try { await harness.stop(); } catch (error) { failures.push(`core cleanup: ${error}`); }
    ownershipTrace.stop();
    // Do not erase state whose native job/object cleanup has not been confirmed.
    const launched = steps.filter(step => step.id.startsWith('lpac-'));
    const nativeCleanup = launched.length > 0 && launched.length === tasks.length &&
      launched.every(step => cleanupConfirmed.get(step.id) === true);
    if (nativeCleanup) {
      try { rmSync(state, {recursive: true, force: true}); } catch (error) { failures.push(`state cleanup: ${error}`); }
    }
    report.cleanup = {nativeConfirmed: nativeCleanup, profiles: profileCleanup, stateExists: existsSync(state)};
    if (existsSync(state)) failures.push('synthetic state retained: native cleanup not proved or removal failed');
    report.initialGatePassed = report.redPassed === true && report.routingObserved === true && failures.length === 0;
    save(); console.log(`DIAGNOSTIC initialGatePassed=${report.initialGatePassed} productionAccepted=false`);
  }
  expect(failures, JSON.stringify(report)).toEqual([]);
}, 90000);
