import {expect, test} from 'bun:test';
import type {Captured} from './capture.ts';
import {parseWorkerFrame, validateWorkerLifetime, type WorkerMode} from './worker-lifetime.ts';

const expected = {mode: 'exited' as WorkerMode, nonce: 'ab'.repeat(16), helper: {pid: 11, created: '100'}, marker: 'TASK_ROUTE_THREAD-EXITED_FIXTURE'};
const path = String.raw`\Sessions\2\BaseNamedObjects\boite.route.11`;
function fixture(mode: WorkerMode = 'exited', absentAfterReturn = true, absentAfterClose = true): Captured {
  const line = (phase: string, now: number) => {
    const start = phase === 'start', live = phase === 'ready' || phase === 'waiting', closed = phase.endsWith('-closed') || phase === 'complete';
    const absent = phase.endsWith('-held') ? absentAfterReturn : phase.endsWith('-closed') ? absentAfterClose : false;
    return `worker-lifetime phase=${phase} mode=${mode} nonce=${expected.nonce} pid=11 process-created=100 main-tid=44 tid=55 thread-created=200 body=${start ? -1 : 125} ready=${start ? 0 : 1000} now=${now} released=${start || live ? 0 : mode === 'waiting' ? 1150 : 1120} pre=${start || live ? 258 : 0} post=${start || live ? 258 : 0} code=${start || live ? 259 : 0} status=${absent ? '0xc0000034' : '0x00000000'} absent=${+absent} observer-closed=1 thread-closed=${+closed} callback-error=0 path=${start ? '-' : path}`;
  };
  const before = 'map=original NUL=original drive=original privileges-bytes=10 unchanged=1';
  const body = [`caller snapshot=before ${before}`, 'token-cleanup role=launch pid=22 success=1 error=0',
    'token-cleanup role=boundary pid=22 success=1 error=0', 'debug-create pid=22 job=1 nonbreakaway=1 package/capability=1 lpac=1 attribute=0x00000000',
    `private-map path=${path} create=0x00000000`, 'private-map pid=22 set=0x00000000', 'cleanup job-active=0',
    ...['root-thread', 'root-process', 'job', 'link', 'map'].map(x => `cleanup close=${x} closed=1 error=0`),
    ...['station-restore', 'desktop', 'station'].map(x => `window-cleanup action=${x} success=1 error=0`),
    ...[0, 1, 2].map(x => `stream-cleanup index=${x} success=1 error=0`),
    'cleanup map-open=0x00000000 absent=0',
    'cleanup map-eventual-open=0x00000000 absent=0 elapsed-ms=2000 attempts=101 limit-ms=2000',
    'cleanup checkpoint-map-open=0x00000000 absent=0 closed=1 error=0 wall-ms=10',
    `caller snapshot=after ${before}`, 'owned-observers enabled=1 object-queries=10 handle-snapshots=10'];
  const phases = mode === 'exited' ? ['ready', 'exited-held', 'exited-closed', 'complete'] : ['ready', 'waiting', 'released-held', 'released-closed', 'complete'];
  return {pid: 11, code: 125, timedOut: false,
    err: [line('start', 100), ...body, ...phases.map((p, i) => line(p, i === 0 ? 1001 : i === 1 ? 1131 : mode === 'waiting' ? 1160 + i : 1130 + i))].join('\r\n') + '\r\n',
    out: [0, 1, 2].flatMap(depth => {
      const label = `${expected.marker}.generation-${depth}`;
      return [`inspect-start=${label} pid=${22 + depth}`, `${label} appcontainer=1 in-job=1 routing=${depth === 0 ? 1 : 0}`,
        `${label} ambient-denial=5`, `${label} host-debug-control=0 known=1`, `${label} inspect-exit=1 child-exit=1 forced=0`];
    }).join('\r\n') + '\r\n'};
}
const validate = (result: Captured, mode: WorkerMode = 'exited') => validateWorkerLifetime(result, {...expected, mode});
function change(result: Captured, phase: string, from: string, to: string): Captured {
  return {...result, err: result.err.split('\n').map(line => line.startsWith(`worker-lifetime phase=${phase} `) ? line.replace(from, to) : line).join('\n')};
}

test('matched worker evidence preserves fatal body result and distinguishes return, handle-close and retention outcomes', () => {
  for (const mode of ['exited', 'waiting'] as const) {
    for (const [heldAbsent, closedAbsent, outcome] of [[true, true, 'absent-after-thread-return'], [false, true, 'absent-after-known-thread-close'],
      [false, false, 'retained-after-thread-close']] as const) {
      const report = validate(fixture(mode, heldAbsent, closedAbsent), mode);
      expect(report.error).toBeUndefined(); expect(report.protocolValid).toBe(true); expect(report.bodyResult).toBe(125);
      expect(report.reproducible).toBe(true); expect(report.outcome).toBe(outcome); expect(report.productionAccepted).toBe(false);
    }
  }
});
test('an absent owned name cannot reappear after closing the known thread handle', () => {
  expect(validate(fixture('exited', true, false)).protocolValid).toBe(false);
});
test('captured helper, nonce and thread incarnation changes cannot validate the trial', () => {
  for (const [phase, from, to] of [['start', 'pid=11', 'pid=12'], ['start', 'process-created=100', 'process-created=101'],
    ['ready', 'tid=55', 'tid=56'], ['ready', 'thread-created=200', 'thread-created=201'],
    ['ready', `nonce=${expected.nonce}`, `nonce=${'ac'.repeat(16)}`], ['ready', 'main-tid=44', 'main-tid=55']] as const)
    expect(validate(change(fixture(), phase, from, to)).protocolValid).toBe(false);
  expect(validateWorkerLifetime(fixture(), {...expected, nonce: 'ad'.repeat(16)}).protocolValid).toBe(false);
});
test('early exit, rewritten body result, missing or out-of-order join and incomplete close fail closed', () => {
  for (const [phase, from, to] of [['ready', 'pre=258', 'pre=0'], ['ready', 'code=259', 'code=0'],
    ['complete', 'body=125', 'body=0'], ['exited-held', 'code=0', 'code=125'], ['exited-closed', 'thread-closed=1', 'thread-closed=0'],
    ['exited-held', 'observer-closed=1', 'observer-closed=0'], ['ready', 'callback-error=0', 'callback-error=996'],
    ['exited-held', 'phase=exited-held', 'phase=exited-closed']] as const)
    expect(validate(change(fixture(), phase, from, to)).protocolValid).toBe(false);
  expect(validate({...fixture(), code: 0}).protocolValid).toBe(false);
  expect(validate({...fixture(), err: fixture().err.replace(/^worker-lifetime phase=complete .*\r?\n/m, '')}).protocolValid).toBe(false);
});
test('missing retained live baseline remains protocol evidence but is causally inconclusive', () => {
  const result = change(fixture(), 'ready', 'status=0x00000000 absent=0', 'status=0xc0000034 absent=1');
  const report = validate(result);
  expect(report.protocolValid).toBe(true); expect(report.reproducible).toBe(false); expect(report.comparisonConclusive).toBe(false);
  const waiting = change(fixture('waiting'), 'waiting', 'status=0x00000000 absent=0', 'status=0xc0000034 absent=1');
  expect(validate(waiting, 'waiting').comparisonConclusive).toBe(false);
});
test('owned names and non-map marker, security and cleanup prerequisites are mandatory', () => {
  for (const [from, to] of [['debug-create pid=22 job=1', 'debug-create pid=22 job=0'],
    ['private-map pid=22 set=0x00000000', 'private-map pid=23 set=0x00000000'],
    ['window-cleanup action=desktop success=1', 'window-cleanup action=desktop success=0'],
    ['token-cleanup role=launch pid=22', 'token-cleanup role=launch pid=23'], ['caller snapshot=after map=original', 'caller snapshot=after map=changed'],
    ['cleanup close=map closed=1', 'cleanup close=map closed=0'], ['cleanup map-eventual-open=', 'missing-eventual=']] as const)
    expect(validate({...fixture(), err: fixture().err.replace(from, to)}).protocolValid).toBe(false);
  expect(validate(change(fixture(), 'ready', `path=${path}`, `path=${path}.extra`)).protocolValid).toBe(false);
  expect(validate({...fixture(), out: fixture().out.replace('routing=1', 'routing=0')}).protocolValid).toBe(false);
});
test('late release, expired barriers, incomplete helper capture and malformed status are invalid', () => {
  for (const [phase, from, to] of [['exited-held', 'released=1120', 'released=4000'], ['complete', 'now=1133', 'now=6000'],
    ['ready', 'released=0', 'released=1000'], ['ready', 'status=0x00000000 absent=0', 'status=0xc0000034 absent=0']] as const)
    expect(validate(change(fixture(), phase, from, to)).protocolValid).toBe(false);
  expect(validate(change(fixture('waiting'), 'waiting', 'now=1131', 'now=1050'), 'waiting').protocolValid).toBe(false);
  expect(validate({...fixture('waiting'), err: fixture('waiting').err.replaceAll('released=1150', 'released=1120')}, 'waiting').protocolValid).toBe(false);
  expect(validate({...fixture(), timedOut: true}).protocolValid).toBe(false);
  expect(validate({...fixture(), code: null}).protocolValid).toBe(false);
  expect(() => parseWorkerFrame('worker-lifetime malformed')).toThrow();
});
