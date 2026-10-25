import {test, expect} from 'bun:test';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir, release} from 'node:os';
import {join} from 'node:path';
import {capture, type Captured} from './capture.ts';
import {selectedEnvironment} from './environment.ts';
import {verifyOwnershipPlatform, ownedMembershipReader, ownedJobReader} from './ownership-generate.ts';
import {serveTopology} from './target-topology.ts';
import {observeHelperJob, type RootProof} from './helper-job.ts';

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
  const readMembership = await ownedMembershipReader();
  const readJob = await ownedJobReader();
  const helperJobControls: Record<string, unknown>[] = []; report.helperJobControls = helperJobControls;
  const controls = join(state, 'target-creator-control'); mkdirSync(controls);
  const topologyProofs: unknown[] = []; report.targetCreatorTopology = topologyProofs;
  const jobs = ['RED', 'A', 'B', 'DIRECT', 'SCOPE', 'QUIET', 'REOPEN', 'CREATOR', 'RETIRE', 'RETIRE-NAMED', 'TARGET-EXITED', 'TARGET-WAITING', 'TARGET-HELPER-EXITED'].map(label => {
    const root = join(state, label), project = join(root, 'project'), runtime = join(root, 'runtime'), home = join(root, 'home');
    const marker = `TASK_ROUTE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
    return {label, root, project, runtime, home, marker, profile: `boite.debug.route.${crypto.randomUUID().replaceAll('-', '')}`};
  });
  const tasks: Promise<Captured>[] = [];
  const profileCleanup: Captured[] = [];
  const cleanupConfirmed = new Map<string, boolean>();
  const creatorFaultCleanup: boolean[] = [];
  const targetCreatorFaultCleanup: boolean[] = [];
  const afterExit: Record<string, unknown>[] = []; report.mapAfterHelperExit = afterExit;
  async function execute(id: string, args: string[], home = state, extra: Record<string, string | undefined> = {}, milliseconds?: number) {
    const helperExited = args[0] === 'target-helper-exited-run';
    const targetCreator = helperExited || args[0] === 'target-exited-run' || args[0] === 'target-waiting-run';
    const prefix = join(controls, crypto.randomUUID()), topologyStart = topologyProofs.length;
    const child = procs.spawnPiped(id, helper!, args, {cwd: state, agentRoot: false,
      env: selectedEnvironment({HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TEMP: home, TMP: home, BOITE_DEBUG_MAP_OWNERSHIP: '1',
        ...(targetCreator ? {BOITE_TARGET_CREATOR_BARRIER: prefix} : {}), ...extra})});
    let stopped = false;
    const topology = targetCreator ? serveTopology(prefix, child.record.pid, process.env.BOITE_DEBUG_MAP_TRACE!,
      readMembership, () => stopped, topologyProofs, helperExited).catch(error => {failures.push(`${id} topology: ${error}`);}) : undefined;
    let result: Captured;
    try {result = await capture(procs, id, child, milliseconds ?? (targetCreator ? 45000 : 40000));}
    finally {stopped = true; await topology;}
    if (helperExited) {
      const record: Record<string, unknown> = {}; helperJobControls.push(record);
      try {
        if (!/helper-job-parked creator=\d+ pipe=0 process=0 thread=0 child-closed=7 io-acquired=(\d+) io-closed=\1 error=0/.test(result.err))
          throw new Error('helper-job missing successful pipe/anchor handoff');
        for (const object of ['root-thread', 'root-process', 'job', 'link', 'map', 'retire-named-map'])
          if (!result.err.includes(`cleanup close=${object} closed=1`)) throw new Error(`helper-job ${object} closure missing`);
        if (!result.err.includes('cleanup job-active=0')) throw new Error('helper-job private target job not empty');
        await observeHelperJob({prefix, helper: result, roots: topologyProofs.slice(topologyStart) as RootProof[], trace: process.env.BOITE_DEBUG_MAP_TRACE!,
          live: readMembership, job: readJob, record,
          observe: (path, phase, index, limit) => execute(`helper-job-${phase}-${index}`, ['observe-map', path], state, {}, limit)});
        for (const row of record.empty as {observation: {absent: boolean}}[])
          if (!row.observation.absent) failures.push('TARGET-HELPER-EXITED empty map absence');
      } catch (error) {
        record.protocolValid = false; record.error = String(error); failures.push(`TARGET-HELPER-EXITED protocol: ${error}`);
        // Failure cleanup uses only the already-captured registry owner. Forced
        // cleanup cannot establish any populated/empty success evidence.
        procs.killTree(id);
      }
    }
    steps.push({id, ...result});
    writeFileSync(join(output!, `${id}.log`), `pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    console.log(`${id}: ${JSON.stringify(result)}`); save(); return result;
  }
  function run(job: typeof jobs[number], debug: boolean, mode?: 'direct-run' | 'setter-run' | 'quiet-run' | 'reopen-run' | 'creator-run' | 'retire-run' | 'retire-named-run' | 'target-exited-run' | 'target-waiting-run' | 'target-helper-exited-run') {
    const promise = execute(`lpac-${job.label}`, [mode ?? (debug ? 'debug-run' : 'run'), job.profile, job.project,
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
      verify(`${label} launch token closed`, () => {
        const root = result.out.match(/^inspect-start=\S+\.generation-0 pid=(\d+)\r?$/m)?.[1];
        expect(Number(root)).toBeGreaterThan(0);
        expect(result.err).toContain(`token-cleanup role=launch pid=${root} success=1 error=0`);
        expect(result.err.match(/token-cleanup role=launch /g)).toHaveLength(1);
      }),
      verify(`${label} boundary tokens closed`, () => {
        const closures = [...result.err.matchAll(/token-cleanup role=boundary pid=(\d+) success=1 error=0/g)];
        expect(closures).toHaveLength(label === 'A' || label === 'B' ? 7 : 1);
        expect(result.err.match(/token-cleanup role=boundary /g)).toHaveLength(closures.length);
      }),
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
        expect(new Set(targets)).toEqual(new Set(['RED', 'DIRECT', 'SCOPE', 'QUIET', 'REOPEN', 'CREATOR', 'RETIRE', 'RETIRE-NAMED', 'TARGET-EXITED', 'TARGET-WAITING', 'TARGET-HELPER-EXITED'].includes(label) ? inspected.slice(0, 1) : inspected));
        expect(result.err.indexOf('ownership-checkpoint ')).toBeGreaterThan(result.err.indexOf('cleanup map-eventual-open='));
        expect(result.err).toMatch(/cleanup checkpoint-map-open=0x[\da-f]+ absent=[01] closed=1 error=0 wall-ms=\d+/);
      }),
    ];
    if (['RETIRE-NAMED', 'TARGET-EXITED', 'TARGET-WAITING', 'TARGET-HELPER-EXITED'].includes(label)) {
      for (const phase of ['immediate', 'checkpoint', 'final']) checks.push(
        verify(`${label} replacement absence ${phase}`, () => expect(result.err)
          .toContain(`cleanup retired-open phase=${phase} status=0xc0000034 absent=1 closed=1 error=0`)));
      checks.push(verify(`${label} replacement observation order`, () => {
        const immediate = result.err.indexOf('cleanup retired-open phase=immediate ');
        expect(immediate).toBeGreaterThan(result.err.indexOf('cleanup close=retire-named-map closed=1'));
        for (const owned of ['root-thread', 'root-process', 'job', 'link', 'map'])
          expect(immediate).toBeGreaterThan(result.err.indexOf(`cleanup close=${owned} closed=1`));
        expect(result.err.indexOf('cleanup retired-open phase=checkpoint '))
          .toBeGreaterThan(result.err.indexOf('cleanup checkpoint-map-open='));
        expect(result.err.indexOf('cleanup retired-open phase=final '))
          .toBeGreaterThan(result.err.indexOf('caller snapshot=after '));
      }));
    } else checks.push(verify(`${label} no named replacement`, () => {
      expect(result.err).not.toContain('map-retire named '); expect(result.err).not.toContain('cleanup retired-open ');
    }));
    for (const action of ['station-restore', 'desktop', 'station']) checks.push(
      verify(`${label} window cleanup ${action}`, () => expect(result.err)
        .toContain(`window-cleanup action=${action} success=1 error=0`)));
    for (let index = 0; index < 3; index++) checks.push(
      verify(`${label} stream cleanup ${index}`, () => expect(result.err)
        .toContain(`stream-cleanup index=${index} success=1 error=0`)));
    const observations = result.err.match(/^owned-observers enabled=([01]) object-queries=(\d+) handle-snapshots=(\d+)\r?$/m);
    checks.push(verify(`${label} ownership observation selection`, () => {
      expect(observations?.[1]).toBe(label === 'QUIET' ? '0' : '1');
      if (label === 'QUIET') {
        expect(observations?.[2]).toBe('0'); expect(observations?.[3]).toBe('0');
        expect(result.err).not.toMatch(/^cleanup object=|^map-owned |^map-lifetime /m);
      } else {
        expect(Number(observations?.[2])).toBeGreaterThan(0);
        expect(Number(observations?.[3])).toBeGreaterThan(0);
      }
    }));
    for (const object of label === 'QUIET' ? [] : ['root-thread', 'root-process', 'job', 'map-before-link-close', 'link', 'map']) checks.push(
      verify(`${label} ${object} counts`, () => expect(result.err).toMatch(new RegExp(
        `cleanup object=${object} handle=\\S+ query=0x00000000 attributes=0x[0-9a-f]+ granted=0x[0-9a-f]+ handles=\\d+ pointers=\\d+`))));
    for (const object of ['root-thread', 'root-process', 'job', 'link', 'map']) checks.push(
      verify(`${label} ${object} closure`, () => expect(result.err).toContain(`cleanup close=${object} closed=1 error=0`)));
    for (const phase of label === 'QUIET' ? [] : [
      ...(label === 'CREATOR' ? ['after-open subject=directory-link', 'after-creator-exit subject=directory-link']
        : ['after-create subject=directory', 'after-create subject=link']),
      'before-assign subject=process', 'after-assign subject=process', 'before-close subject=map',
    ]) checks.push(
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
    for (const match of result.err.matchAll(/^map-retire named path=(.+) create=0x00000000\r?$/gm))
      names.push({kind: 'retired', path: match[1]!.replace(/\r$/, '')});
    if (!verify(`${label} owned map name`, () => {
      expect(names).toHaveLength(['RED', 'RETIRE-NAMED', 'TARGET-EXITED', 'TARGET-WAITING', 'TARGET-HELPER-EXITED'].includes(label) ? 2 : 1);
      expect(new Set(names.map(name => name.kind)).size).toBe(names.length);
      for (const name of names) expect(name.path).toMatch(new RegExp(
        `^\\\\(?:Sessions\\\\\\d+\\\\)?BaseNamedObjects\\\\boite\\.route\\.${result.pid}${name.kind === 'swap' ? '\\.swap' : name.kind === 'retired' ? '\\.retired' : ''}$`));
    })) { cleanupConfirmed.set(`lpac-${label}`, false); return; }
    for (const name of names) {
      const observed = await execute(`map-after-exit-${label}${name.kind === 'map' ? '' : `-${name.kind}`}`, ['observe-map', name.path]);
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
    // The new owned suffix must not admit a near-match or a nested path.
    for (const [index, suffix] of ['.retired.extra', '.retired\\child'].entries()) {
      const invalid = await execute(`observer-reject-${index}`, ['observe-map',
        `\\BaseNamedObjects\\boite.route.${process.pid}${suffix}`]);
      completed(`observer rejected suffix ${index}`, invalid, 125);
      verify(`observer rejected suffix ${index} before opening`, () => {
        expect(invalid.out).toBe('');
        expect(invalid.err).toContain('execution.windows.observer-map.path: native call failed (123)');
        expect(invalid.err).not.toContain('cleanup close=map-post-exit-observer');
      });
    }
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
      const pending = jobs.slice(1, 3).map(job => run(job, true));
      try {
        await waitFor(() => jobs.slice(1, 3).every(job => existsSync(join(job.project, 'ready'))), 5000);
        report.overlap = true;
        const during = await execute('ordinary-during', ['observe', state]); observer('during', during, before);
      } catch (error) { failures.push(`independent overlap/observer: ${error}`); }
      finally {
        for (const job of jobs.slice(1, 3)) writeFileSync(join(job.project, 'release'), 'synthetic');
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
            expect(result.err).toContain(`token-cleanup role=boundary pid=${pid} success=1 error=0`);
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
            expect(result.err).toContain(`token-cleanup role=boundary pid=${pid} success=1 error=0`);
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
    // Matched root-only controls isolate assignment caller, optional queries and acquisition
    // from RED's A/B/A roundtrip. Helpers stay alive through the fatal gates.
    // These observations cannot make a failed original RED/A/B gate pass.
    if (report.redSafetyPassed === true) {
      for (const [index, mode] of (['direct-run', 'setter-run', 'quiet-run', 'reopen-run', 'creator-run', 'retire-run', 'retire-named-run', 'target-exited-run', 'target-waiting-run', 'target-helper-exited-run'] as const).entries()) {
        const job = jobs[index + 3]!;
        writeFileSync(join(job.project, 'release'), 'synthetic');
        const result = await run(job, false, mode);
        report[job.label.toLowerCase()] = result;
        completed(job.label, result, 1); boundary(job.label, result, job.marker);
        for (let depth = 0; depth < 3; depth++) verify(`${job.label} generation ${depth} routing`, () => expect(result.out)
          .toContain(`${job.marker}.generation-${depth} appcontainer=1 in-job=1 routing=${depth === 0 ? 1 : 0}`));
        verify(`${job.label} no roundtrip`, () => expect(result.err).not.toContain('map-swap '));
        if (mode === 'setter-run') {
          verify('SCOPE assignment and exit before target', () => {
            const setter = result.err.match(/setter-assignment target=(\d+) setter=(\d+) inherited=2 member=1 resumed=1 wait=0 exit=0x00000000 forced=0 error=0/);
            const target = result.out.match(/^inspect-start=\S+\.generation-0 pid=(\d+)\r?$/m)?.[1];
            expect(setter?.[1]).toBe(target);
            expect(Number(setter?.[2])).toBeGreaterThan(0);
            expect(setter?.[2]).not.toBe(target); expect(setter?.[2]).not.toBe(String(result.pid));
            expect(result.err).toMatch(/setter-transfer target=\d+ created=\d+ parent-closed=2 error=0 process-access=0x00101200 map-access=0x00000003/);
            expect(result.err).toContain('setter-cleanup handles=3 closed=3 error=0');
          });
        } else verify(`${job.label} in-helper assignment`, () => expect(result.err).not.toContain('setter-assignment '));
        verify(`${job.label} acquisition control`, () => {
          if (mode !== 'reopen-run') {expect(result.err).not.toContain('map-reopen '); return;}
          for (const [object, access] of [['directory', '000f000f'], ['link', '000f0001']])
            expect(result.err).toContain(`map-reopen object=${object} same=1 name=1 granted=0x${access} attributes=0x00000000 flags=0`);
          expect(result.err).toContain('map-reopen link-target=1');
          expect(result.err).toContain('cleanup close=creation-link closed=1 error=0');
          expect(result.err).toContain('cleanup close=creation-map closed=1 error=0');
          expect(result.err).toContain('map-reopen handoff=1 originals-closed=2');
          expect(result.err).toContain('map-reopen result=0');
          expect(result.err).not.toContain('cleanup close=unadopted-reopen-');
          expect(result.err).toMatch(/map-lifetime phase=after-reopen subject=before-handoff .*matches=2 error=0/);
          expect(result.err).toMatch(/map-lifetime phase=after-reopen subject=handoff .*matches=1 error=0/);
          const assigned = result.err.indexOf('private-map pid=');
          expect(assigned).toBeGreaterThan(result.err.indexOf('map-reopen result=0'));
          expect(result.err.indexOf('map-reopen handoff=1')).toBeGreaterThan(result.err.indexOf('cleanup close=creation-map closed=1'));
          expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(1);
          expect(result.err).not.toContain('map-swap ');
        });
        if (mode === 'creator-run') verify('CREATOR continuous handoff and clean exit before assignment', () => {
          const identity = result.err.match(/creator-identity pid=(\d+) created=(\d+) image=1 session=\d+ member=1 inherited=1 parent-transfer-closed=1 fault=none/);
          const pid = identity?.[1];
          expect(Number(pid)).toBeGreaterThan(0); expect(pid).not.toBe(String(result.pid));
          expect(result.out).not.toContain(`pid=${pid}\r\n`);
          expect(result.err).toContain(`creator-ready pid=${pid} anchors=2 nonce=1 security-bytes=`);
          for (const [object, access] of [['directory', '000f000f'], ['link', '000f0001']])
            expect(result.err).toContain(`creator-open object=${object} name=1 granted=0x${access} attributes=0x00000000 flags=0`);
          expect(result.err).toContain('creator-open link-target=1');
          expect(result.err).toContain(`creator-released pid=${pid} anchors=0 nonce=1`);
          expect(result.err).toMatch(new RegExp(`creator-exit pid=${pid} created=${identity?.[2]} wall-ms=\\d+ exit=0x00000000`));
          expect(result.err).toContain(`creator-cleanup pid=${pid} member=1 resumed=1 released=1 wait=0 exit=0x00000000 forced=0 handles=5 closed=5 io-retained=0 error=0`);
          const events = result.err.match(/creator-io-cleanup acquired=(\d+) closed=(\d+) retained=0/);
          expect(Number(events?.[1])).toBeGreaterThan(0); expect(events?.[2]).toBe(events?.[1]);
          expect(result.err).toContain('creator-caller unchanged=1 error=0');
          const opened = result.err.indexOf('creator-open link-target=1');
          const released = result.err.indexOf('creator-released ');
          const exited = result.err.indexOf('creator-exit ');
          const closed = result.err.indexOf('creator-cleanup ');
          const assigned = result.err.indexOf('private-map pid=');
          expect(opened).toBeGreaterThan(result.err.indexOf('creator-ready '));
          expect(released).toBeGreaterThan(opened); expect(exited).toBeGreaterThan(released);
          expect(closed).toBeGreaterThan(exited); expect(assigned).toBeGreaterThan(closed);
          expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(1);
          expect(result.err).not.toContain('creator-io ');
        });
        verify(`${job.label} retirement selection`, () => {
          if (!['retire-run', 'retire-named-run', 'target-exited-run', 'target-waiting-run', 'target-helper-exited-run'].includes(mode)) {expect(result.err).not.toContain('map-retire '); return;}
          const target = result.out.match(/^inspect-start=\S+\.generation-0 pid=(\d+)\r?$/m)?.[1];
          expect(Number(target)).toBeGreaterThan(0);
          expect(result.err).toContain(`map-retire ready pid=${target} signaled=1 job-active=0 exit=1`);
          expect(result.err).toContain('map-retire create=0x00000000');
          expect(result.err).toContain(mode !== 'retire-run'
            ? 'map-retire named=1 inherited=0 links=0' : 'map-retire unnamed=1 inherited=0 links=0');
          expect(result.err).toContain(`map-retire pid=${target} set=0x00000000`);
          expect(result.err).toContain(`map-retire preserved pid=${target} signaled=1 exit=1 unchanged=1`);
          expect(result.err).toContain(mode !== 'retire-run'
            ? 'cleanup close=retire-named-map closed=1 error=0' : 'cleanup close=retire-unnamed-map closed=1 error=0');
          expect(result.err).toContain('map-retire result=0');
          for (const phase of ['before-retire', 'after-retire']) expect(result.err)
            .toContain(`map-lifetime phase=${phase} subject=exited-root pid=${result.pid} query=0x00000000 matches=1 error=0`);
          expect(result.err.indexOf('map-retire ready ')).toBeGreaterThan(result.err.indexOf('cleanup job-active=0'));
          expect(result.err.indexOf('cleanup close=root-thread')).toBeGreaterThan(result.err.indexOf('map-retire result=0'));
        });
        if (mode === 'target-exited-run' || mode === 'target-waiting-run') verify(`${job.label} target creator protocol`, () => {
          const selected = mode === 'target-exited-run' ? 1 : 2;
          const identity = result.err.match(new RegExp(`target-creator-start pid=(\\d+) created=(\\d+) inherited=5 parent-copies-closed=5 image=1 token=1 private-job=0 extra-job=0 mode=${selected}`));
          const creator = identity?.[1], root = result.out.match(/^inspect-start=\S+\.generation-0 pid=(\d+)\r?$/m)?.[1];
          expect(Number(creator)).toBeGreaterThan(0); expect(creator).not.toBe(root); expect(creator).not.toBe(String(result.pid));
          const released = result.err.match(new RegExp(`target-creator-released pid=${creator} root=${root} created=\\d+ sources-closed=6 known-target-anchors=0 control-only=1 target-inherit=3 controller-flags=0 image=1 security=1 child-io-acquired=(\\d+) child-io-closed=(\\d+)`));
          expect(Number(released?.[1])).toBeGreaterThan(0); expect(released?.[2]).toBe(released?.[1]);
          for (const role of ['process', 'thread']) expect(result.err).toMatch(new RegExp(
            `target-creator-security role=${role} mapping=0x[0-9a-f]+ raw-equal=[01] exact=1 protected=1 fault=0 error=0`));
          const closed = result.err.match(new RegExp(`target-creator-exit pid=${creator} created=${identity?.[2]} mode=${selected} released=1 forced=0 exit=0 handles-closed=1 io-acquired=(\\d+) io-closed=(\\d+) retained=0 connect-acquired=(\\d+) connect-closed=(\\d+) error=0`));
          expect(Number(closed?.[1])).toBeGreaterThan(0); expect(closed?.[2]).toBe(closed?.[1]);
          expect(closed?.[3]).toBe('1'); expect(closed?.[4]).toBe(closed?.[3]);
          for (const phase of ['creator', 'root', 'closed']) expect(result.err).toContain(
            `target-creator-topology phase=${phase} helper=${result.pid} creator=${creator} root=${phase === 'creator' ? 0 : root} nonce=1 proved=1 error=0`);
          const assigned = result.err.indexOf('private-map pid='), resumed = result.err.indexOf('target-creator-root-resume ');
          expect(assigned).toBeGreaterThan(result.err.indexOf('target-creator-released '));
          expect(resumed).toBeGreaterThan(assigned);
          expect(result.err).toContain(`target-creator-root-resume root=${root} creator=${creator} mode=${selected} creator-live=${selected === 2 ? 1 : 0}`);
          const exited = result.err.indexOf('target-creator-exit '), registryClosed = result.err.indexOf('target-creator-topology phase=closed ');
          expect(registryClosed).toBeGreaterThan(exited);
          if (selected === 1) expect(assigned).toBeGreaterThan(registryClosed);
          else {
            expect(exited).toBeGreaterThan(result.err.indexOf('cleanup retired-open phase=final '));
            expect(result.err.indexOf('cleanup creator-exited-original ')).toBeGreaterThan(registryClosed);
            expect(result.err).toContain('cleanup creator-exited-original open=0xc0000034 absent=1 closed=1 error=0');
            expect(result.err).toContain('cleanup retired-open phase=creator-exited status=0xc0000034 absent=1 closed=1 error=0');
          }
          expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(1);
          expect(result.err).not.toContain('creator-ready '); expect(result.err).not.toContain('target-creator-io ');
        });
        if (mode === 'target-helper-exited-run') verify('TARGET-HELPER-EXITED handoff and protocol', () => {
          const frame = helperJobControls.at(-1)?.frame as {creator?: {pid: number}; root?: {pid: number}} | undefined;
          expect(helperJobControls.at(-1)?.protocolValid).toBe(true);
          const creator = frame?.creator?.pid, root = frame?.root?.pid;
          expect(Number(creator)).toBeGreaterThan(0); expect(Number(root)).toBeGreaterThan(0);
          expect(creator).not.toBe(root); expect(creator).not.toBe(result.pid);
          expect(result.err).toMatch(new RegExp(`target-creator-start pid=${creator} created=\\d+ inherited=5 parent-copies-closed=5 image=1 token=1 private-job=0 extra-job=0 mode=3`));
          const released = result.err.match(new RegExp(`target-creator-released pid=${creator} root=${root} created=\\d+ sources-closed=6 known-target-anchors=0 control-only=1 target-inherit=3 controller-flags=0 image=1 security=1 child-io-acquired=(\\d+) child-io-closed=(\\d+)`));
          expect(Number(released?.[1])).toBeGreaterThan(0); expect(released?.[2]).toBe(released?.[1]);
          for (const role of ['process', 'thread']) expect(result.err).toMatch(new RegExp(
            `target-creator-security role=${role} mapping=0x[0-9a-f]+ raw-equal=[01] exact=1 protected=1 fault=0 error=0`));
          for (const phase of ['creator', 'root']) expect(result.err).toContain(
            `target-creator-topology phase=${phase} helper=${result.pid} creator=${creator} root=${phase === 'creator' ? 0 : root} nonce=1 proved=1 error=0`);
          const assigned = result.err.indexOf('private-map pid='), resumed = result.err.indexOf('target-creator-root-resume ');
          expect(assigned).toBeGreaterThan(result.err.indexOf('target-creator-released '));
          expect(resumed).toBeGreaterThan(assigned);
          expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(1);
          expect(result.err).not.toContain('creator-ready '); expect(result.err).not.toContain('target-creator-io ');
          expect(result.err).toContain(`target-creator-root-resume root=${frame?.root?.pid} creator=${frame?.creator?.pid} mode=3 creator-live=1`);
          const parked = result.err.match(/helper-job-parked creator=\d+ pipe=0 process=0 thread=0 child-closed=7 io-acquired=(\d+) io-closed=(\d+) error=0/);
          expect(Number(parked?.[1])).toBeGreaterThan(0); expect(parked?.[1]).toBe(parked?.[2]);
          expect(result.err.indexOf('helper-job-parked ')).toBeGreaterThan(result.err.indexOf('cleanup retired-open phase=final '));
        });
        cleanup(job.label, result);
        if (mode !== 'target-helper-exited-run') await observeAfterExit(job.label, result);
        const afterScope = await execute(`ordinary-after-${job.label.toLowerCase()}`, ['observe', state]);
        observer(`after ${job.label}`, afterScope, before);
        save();
      }
      // Each failure must leave the target suspended, reap only the captured
      // creator/job and remove the unassigned exact object name. These probes
      // cannot substitute for any successful CREATOR or original routing gate.
      const job = jobs[7]!;
      for (const fault of ['nonce', 'descriptor', 'frame', 'exit', 'stall']) {
        const result = await execute(`creator-fault-${fault}`, ['creator-run', job.profile, job.project,
          join(job.runtime, 'inspect.exe'), 'inspect', '0', job.marker], job.home,
        {PATH: `${job.runtime};${process.env.SystemRoot}\\System32`, BOITE_DIAGNOSTIC_CREATOR_FAULT: fault});
        const checks = [completed(`CREATOR ${fault} rejects`, result, 125), verify(`CREATOR ${fault} no target execution`, () => {
          expect(result.out).not.toContain('inspect-start=');
          expect(result.err).not.toContain('private-map pid=');
          expect(result.err).toContain('cleanup job-active=0');
          expect(result.err).toMatch(/creator-cleanup pid=\d+ member=1 resumed=1 released=0 .*handles=5 closed=5 io-retained=0 error=[1-9]\d*/);
          const events = result.err.match(/creator-io-cleanup acquired=(\d+) closed=(\d+) retained=0/);
          expect(Number(events?.[1])).toBeGreaterThan(0); expect(events?.[2]).toBe(events?.[1]);
          expect(result.err).toContain('creator-failure-map open=0xc0000034 absent=1 closed=1 error=0');
          expect(result.err).toMatch(/caller snapshot=after .* unchanged=1/);
          if (fault === 'stall') expect(result.err).toContain('creator-io cancelled=1 cancel-error=0 drained=1');
        })];
        const name = result.err.match(/^creator-attempt path=(.+)\r?$/m)?.[1]?.replace(/\r$/, '');
        checks.push(verify(`CREATOR ${fault} exact name`, () => expect(name).toMatch(new RegExp(
          `^\\\\(?:Sessions\\\\\\d+\\\\)?BaseNamedObjects\\\\boite\\.route\\.${result.pid}$`))));
        if (name && !result.timedOut && result.code !== null) {
          const observed = await execute(`map-after-fault-${fault}`, ['observe-map', name]);
          checks.push(completed(`CREATOR ${fault} observer`, observed), verify(`CREATOR ${fault} map absent`, () =>
            expect(observed.out).toBe(`map-after-helper-exit path=${name} open=0xc0000034 absent=1 closed=1 error=0\r\n`)));
        } else checks.push(false);
        creatorFaultCleanup.push(checks.every(Boolean)); save();
      }
      const targetJob = jobs[10]!;
      for (const fault of ['nonce', 'descriptor', 'frame', 'exit', 'stall', 'process-acl', 'thread-acl']) {
        const result = await execute(`target-creator-fault-${fault}`, ['target-exited-run', targetJob.profile, targetJob.project,
          join(targetJob.runtime, 'inspect.exe'), 'inspect', '0', targetJob.marker], targetJob.home,
        {PATH: `${targetJob.runtime};${process.env.SystemRoot}\\System32`, BOITE_DIAGNOSTIC_TARGET_CREATOR_FAULT: fault});
        const checks = [completed(`target CREATOR ${fault} rejects`, result, 125), verify(`target CREATOR ${fault} suspended and reaped`, () => {
          expect(result.out).not.toContain('inspect-start=');
          expect(result.err).not.toContain('private-map pid='); expect(result.err).not.toContain('private-map path=');
          expect(result.err).not.toContain('target-creator-root-resume ');
          expect(result.err).toContain('cleanup job-active=0');
          expect(result.err).toMatch(/target-creator-topology phase=creator .*nonce=1 proved=1 error=0/);
          const cleanup = result.err.match(/target-creator-exit pid=\d+ created=\d+ mode=1 released=0 forced=[01] exit=\d+ handles-closed=1 io-acquired=(\d+) io-closed=(\d+) retained=0 connect-acquired=(\d+) connect-closed=(\d+) error=[1-9]\d*/);
          expect(Number(cleanup?.[1])).toBeGreaterThan(0); expect(cleanup?.[2]).toBe(cleanup?.[1]);
          expect(cleanup?.[3]).toBe('1'); expect(cleanup?.[4]).toBe(cleanup?.[3]);
          expect(result.err).toMatch(/^target-creator-failure-map path=.+ open=0xc0000034 absent=1 closed=1 error=0\r?$/m);
          expect(result.err).toMatch(/caller snapshot=after .* unchanged=1/);
          if (fault === 'stall') expect(result.err).toContain('target-creator-io cancelled=1 cancel-error=0 drained=1');
          if (fault.endsWith('-acl')) expect(result.err).toMatch(new RegExp(
            `target-creator-security role=${fault.slice(0, -4)} mapping=0x[0-9a-f]+ raw-equal=[01] exact=0 protected=1 fault=1 error=1336`));
        })];
        const name = result.err.match(/^target-creator-failure-map path=(.+) open=0xc0000034 /m)?.[1];
        checks.push(verify(`target CREATOR ${fault} exact absent name`, () => expect(name).toMatch(new RegExp(
          `^\\\\(?:Sessions\\\\\\d+\\\\)?BaseNamedObjects\\\\boite\\.route\\.${result.pid}$`))));
        if (name && !result.timedOut && result.code !== null) {
          const observed = await execute(`map-after-target-fault-${fault}`, ['observe-map', name]);
          checks.push(completed(`target CREATOR ${fault} observer`, observed), verify(`target CREATOR ${fault} absent after helper`, () =>
            expect(observed.out).toBe(`map-after-helper-exit path=${name} open=0xc0000034 absent=1 closed=1 error=0\r\n`)));
        } else checks.push(false);
        targetCreatorFaultCleanup.push(checks.every(Boolean)); save();
      }
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
      launched.every(step => cleanupConfirmed.get(step.id) === true) &&
      creatorFaultCleanup.length === 5 && creatorFaultCleanup.every(Boolean) &&
      targetCreatorFaultCleanup.length === 7 && targetCreatorFaultCleanup.every(Boolean);
    if (nativeCleanup) {
      try { rmSync(state, {recursive: true, force: true}); } catch (error) { failures.push(`state cleanup: ${error}`); }
    }
    report.cleanup = {nativeConfirmed: nativeCleanup, profiles: profileCleanup, creatorFaultCleanup, targetCreatorFaultCleanup, stateExists: existsSync(state)};
    if (existsSync(state)) failures.push('synthetic state retained: native cleanup not proved or removal failed');
    report.initialGatePassed = report.redPassed === true && report.routingObserved === true && failures.length === 0;
    save(); console.log(`DIAGNOSTIC initialGatePassed=${report.initialGatePassed} productionAccepted=false`);
  }
  expect(failures, JSON.stringify(report)).toEqual([]);
}, 150000);
