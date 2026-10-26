import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OwnershipLedger, type TraceEvent} from './ownership-ledger.ts';
import {instrumentJobs, instrumentWorker, jobsPath, workerPath, prepareOwnership, ownershipTestArgs} from './ownership-generate.ts';
import {summarizeOwnership} from './ownership-summary.ts';
import {OwnershipTrace, ownershipWorkerOptions} from './ownership-trace.ts';

test('worker transfer, retained record, reuse and failed original closure preserve ownership generations', () => {
  const events: TraceEvent[] = [], worker = new OwnershipLedger('worker', e => events.push(e)), main = new OwnershipLedger('main', e => events.push(e));
  const first = {pid: 42, incarnation: '1000', exitCode: 259};
  worker.acquire(8, 42, first); const transfer = worker.transfer(8)!;
  let reads = 0; worker.snapshot(() => {reads++; return first;});
  expect(reads).toBe(0); expect(worker.outgoing.size).toBe(1);
  main.acquire(8, 42, first, transfer); main.stage(8, 'tracked');
  main.snapshot(() => {reads++; return {...first, exitCode: 0};});
  expect(reads).toBe(1); main.close(8, true, 0);
  main.acquire(8, 43, {pid: 43, incarnation: '2000', exitCode: 0});
  const second = main.owned.get(8)!.id; expect(second).not.toBe(transfer.id);
  main.close(8, false, 6); expect(main.owned.get(8)?.id).toBe(second);
  main.snapshot(() => {throw new Error('failed close values must not be queried again');});
  main.close(999, true, 0); expect(main.complete).toBe(false);
  expect(events.filter(e => e.event === 'close-result').map(e => [e.id, e.success])).toEqual([[transfer.id, true], [second, false]]);
});

test('missing or mismatched provenance stays incomplete rather than clearing a prior handle generation', () => {
  const events: TraceEvent[] = [], ledger = new OwnershipLedger('owner', e => events.push(e));
  ledger.acquire(8, 42, {pid: 42, incarnation: '1000', exitCode: 0});
  ledger.acquire(8, 42, {pid: 42, incarnation: '2000', exitCode: 0}, {id: 'foreign', pid: 42, incarnation: 'wrong', from: 'worker'});
  ledger.acquire(12, 44, {pid: null, incarnation: null, exitCode: null});
  expect(ledger.complete).toBe(false);
  expect(events.filter(e => e.event === 'incomplete')).toHaveLength(3);
});

test('source drift fails closed before instrumented modules are written', () => {
  expect(() => instrumentJobs(readFileSync(jobsPath, 'utf8') + '\n', '/tmp/worker.ts')).toThrow('source drift');
  expect(() => instrumentWorker(readFileSync(workerPath, 'utf8') + '\n')).toThrow('source drift');
});

test('generated copies retain a typed ownership transfer contract and resolve exact source imports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-ownership-types-'));
  try {
    const prepared = prepareOwnership(directory);
    const paths: Record<string, string[]> = {'@boite/contracts': [join(import.meta.dir, '../../../packages/contracts/src/index.ts')]};
    for (const file of [prepared.jobs, prepared.worker])
      for (const match of readFileSync(file, 'utf8').matchAll(/['"](file:[^'"]+)['"]/g))
        paths[match[1]!] = [fileURLToPath(match[1]!)];
    const config = join(directory, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({extends: join(import.meta.dir, 'tsconfig.json'),
      compilerOptions: {paths}, files: [prepared.jobs, prepared.worker], include: []}));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../../packages/core/node_modules/typescript/bin/tsc'), '-p', config],
      {stdout: 'pipe', stderr: 'pipe'});
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
  } finally {rmSync(directory, {recursive: true, force: true});}
}, 30000);

test('telemetry preserves last error across reads, failed original closures and final snapshots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-ownership-errors-'));
  let lastError = 123, reads = 0;
  const trace = new OwnershipTrace('synthetic', {save: () => lastError, restore: value => {lastError = value;},
    read(handle) {expect(handle).toBe(8); reads++; lastError = 999; return {pid: 42, incarnation: '1000', exitCode: 0};}});
  try {
    trace.start(directory); trace.acquired(8, 42); expect(lastError).toBe(123);
    const reference = trace.reference(8)!;
    expect(reference.identity).toMatchObject({pid: 42, incarnation: '1000'}); expect(lastError).toBe(123);
    lastError = 6; trace.closed(8, false, 6); expect(lastError).toBe(6);
    expect(trace.closeResult(reference.entry.id)).toMatchObject({success: false, error: 6});
    expect(trace.reference(8)).toBeUndefined();
    trace.stop(); expect(reads).toBe(2); expect(lastError).toBe(6);
    const events = readdirSync(directory).flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    expect(events.find(e => e.event === 'close-result')).toMatchObject({success: false, error: 6});
    expect(events.at(-1)).toMatchObject({event: 'owner-stop', complete: false});
  } finally {trace.stop(); rmSync(directory, {recursive: true, force: true});}
});

test('cross-owner accounting distinguishes pending transfer and failed close from complete handle reuse', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-ownership-accounting-'));
  try {
    const file = join(directory, 'synthetic.jsonl');
    const rows: Record<string, unknown>[] = [
      {event: 'owner-start', owner: 'launcher', role: 'launcher-main'},
      {event: 'owner-start', owner: 'harness', role: 'harness-main'},
      ...['launcher-main', 'harness-main'].map(role => ({event: 'interception-verified', role})),
      {event: 'acquired', id: 'worker/1', handle: 8},
      {event: 'transfer-send', transfer: {id: 'worker/1'}},
      {event: 'owner-stop', owner: 'launcher', complete: true, retained: []},
      {event: 'owner-stop', owner: 'harness', complete: true, retained: []},
    ];
    const save = () => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    save(); expect(summarizeOwnership(directory).failures.some(f => f.includes('pending worker-to-main'))).toBe(true);
    rows.push({event: 'transfer-received', id: 'worker/1', handle: 8}, {event: 'close-result', id: 'worker/1', success: true},
      {event: 'acquired', id: 'main/2', handle: 8}, {event: 'close-result', id: 'main/2', success: false, error: 6});
    save(); expect(summarizeOwnership(directory).complete).toBe(false);
    rows[rows.length - 1] = {event: 'close-result', id: 'main/2', success: true};
    save(); expect(summarizeOwnership(directory)).toMatchObject({complete: true, acquired: 2, closed: 2, transferred: 1, received: 1});
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('Bun preloads the exact generated Windows jobs module in two independent opted-in owners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-ownership-preload-'));
  try {
    const prepared = prepareOwnership(join(directory, 'generated'));
    // Wrong command ordering must fail locally, never launch the repository suite.
    writeFileSync(join(directory, 'package.json'), JSON.stringify({scripts: {test: 'exit 71'}}));
    const probeSource = `const canonical = await import(${JSON.stringify(jobsPath)});\n` +
      `if (canonical.ownershipTraceInstalled !== true) throw new Error('interception absent');\n` +
      `const {platform} = await import(${JSON.stringify(join(import.meta.dir, '../../../packages/core/src/platform/windows/index.ts'))});\n` +
      `if (platform.attach !== canonical.assignToThreadJob) throw new Error('ProcessPlatform bypassed interception');\n` +
      `const {verifyOwnershipPlatform} = await import(${JSON.stringify(join(import.meta.dir, 'ownership-generate.ts'))});\n` +
      `await verifyOwnershipPlatform();\n` +
      `const {ownershipTrace} = await import(${JSON.stringify(join(import.meta.dir, 'ownership-trace.ts'))});\n` +
      `ownershipTrace.stop(); console.log('INTERCEPTION_OK ' + process.env.BOITE_DEBUG_MAP_OWNER);\n`;
    for (const role of ['launcher', 'harness']) {
      const probe = join(directory, `${role}.test.ts`);
      writeFileSync(probe, role === 'launcher'
        ? `const {installOwnership} = await import(${JSON.stringify(join(import.meta.dir, 'ownership-generate.ts'))});\n` +
          `await installOwnership(${JSON.stringify(prepared.jobs)});\n` + probeSource
        : `import {test} from 'bun:test';\n` + probeSource + `test('interception verified before test imports', () => {});\n`);
      const args = role === 'launcher' ? [process.execPath, probe] : [process.execPath, ...ownershipTestArgs(prepared.preload, probe)];
      const proc = Bun.spawn(args, {
        cwd: directory,
        env: {...process.env, BOITE_TEST_DEBUG_MAP: '1', BOITE_DEBUG_MAP_OWNERSHIP: '1',
          BOITE_DEBUG_MAP_TRACE: join(directory, 'trace'), BOITE_DEBUG_MAP_OWNER: role}, stdout: 'pipe', stderr: 'pipe'});
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(code, err).toBe(0); expect(out).toContain(`INTERCEPTION_OK ${role}`);
    }
    const summary = summarizeOwnership(join(directory, 'trace'));
    expect(summary.failures).toEqual([]); expect(summary.owners).toHaveLength(2);
    const noOptIn = Bun.spawn([process.execPath, '--preload', prepared.preload, '-e', 'console.log("NO_FIXTURE")'],
      {env: {...process.env, BOITE_TEST_DEBUG_MAP: '0', BOITE_DEBUG_MAP_OWNERSHIP: '1', BOITE_DEBUG_MAP_TRACE: join(directory, 'absent')}, stdout: 'pipe', stderr: 'pipe'});
    expect(await noOptIn.exited).toBe(0);
    expect(readdirSync(directory)).not.toContain('absent');
    const noFixture = Bun.spawn([process.execPath, join(import.meta.dir, 'run.ts'), join(directory, 'disabled')],
      {env: {...process.env, BOITE_TEST_DEBUG_MAP: '0', BOITE_DEBUG_MAP_OWNERSHIP: '1'}, stdout: 'pipe', stderr: 'pipe'});
    const [code, , error] = await Promise.all([noFixture.exited, new Response(noFixture.stdout).text(), new Response(noFixture.stderr).text()]);
    expect(code, error).toBe(0);
    expect(readdirSync(join(directory, 'disabled'))).toEqual(['diagnostic.json']);
    expect(JSON.parse(readFileSync(join(directory, 'disabled', 'diagnostic.json'), 'utf8')).enabled).toBe(false);
  } finally {rmSync(directory, {recursive: true, force: true});}
});


test('a registry worker logs each compiler in the trace directory selected after launcher startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-ownership-worker-'));
  const saved = Object.fromEntries(['BOITE_DEBUG_MAP_TRACE', 'BOITE_DEBUG_MAP_OWNER'].map(key => [key, process.env[key]]));
  const probe = join(directory, 'probe.ts');
  writeFileSync(probe, `import {ownershipTrace} from ${JSON.stringify(join(import.meta.dir, 'ownership-trace.ts'))};\n` +
    `ownershipTrace.stop(); postMessage('WORKER_TRACE_STOPPED');\n`);
  try {
    // A worker may have started before run.ts selects its compiler directory.
    const prime = new Worker(probe);
    let primedDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        prime.onmessage = () => resolve(); prime.onerror = error => reject(new Error(String(error)));
        primedDeadline = setTimeout(() => reject(new Error('initial worker deadline')), 5000);
      });
    } finally {clearTimeout(primedDeadline); prime.terminate();}
    for (const compiler of ['sdk', 'mingw']) {
      const trace = join(directory, compiler);
      process.env.BOITE_DEBUG_MAP_TRACE = trace; process.env.BOITE_DEBUG_MAP_OWNER = 'launcher';
      // Server's launcher worker had no trace environment; keep that native failure condition.
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && !['BOITE_DEBUG_MAP_TRACE', 'BOITE_DEBUG_MAP_OWNER'].includes(key)) environment[key] = value;
      const worker = new Worker(probe, {...ownershipWorkerOptions(), env: environment});
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          worker.onmessage = event => event.data === 'WORKER_TRACE_STOPPED' ? resolve() : reject(new Error('unexpected worker message'));
          worker.onerror = error => reject(new Error(String(error)));
          deadline = setTimeout(() => reject(new Error('worker trace deadline')), 5000);
        });
        const rows = readdirSync(trace).flatMap(name => readFileSync(join(trace, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
        expect(rows[0]).toMatchObject({event: 'owner-start', role: 'launcher-worker', ownerPid: process.pid});
        expect(rows.at(-1)).toMatchObject({event: 'owner-stop', complete: true});
        expect(rows[0].ownerThread).toBeGreaterThan(0);
      } finally {clearTimeout(deadline); worker.terminate();}
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, {recursive: true, force: true});
  }
});
