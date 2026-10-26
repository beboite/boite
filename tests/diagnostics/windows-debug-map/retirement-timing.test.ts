import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {generate, sourcePath} from './generate.ts';
import type {Captured} from './capture.ts';
import {parseRetirementFrame, validateRetirementTiming, type RetirementMode} from './retirement-timing.ts';
import {runControlBatches} from './control-schedule.ts';

import {expected, path, fixture} from './retirement-fixture.ts';

const validate = (result: Captured, mode: RetirementMode = 'live') => validateRetirementTiming(result, {...expected, mode});
const replace = (from: string, to: string, mode: RetirementMode = 'live') => {
  const f = fixture(mode); return {...f, err: f.err.replace(from, to)};
};
test('before/after-exit ordering preserves original failures and reports presence independently', () => {
  for (const mode of ['live', 'exited'] as const) for (const absent of [false, true]) {
    const evidence = validate(fixture(mode, absent), mode);
    expect(evidence.error).toBeUndefined(); expect(evidence.protocolValid).toBe(true);
    expect(evidence.cleanupGatesPassed).toBe(absent); expect(evidence.reproducesBaseline).toBe(!absent);
    expect(evidence.causeConfirmed).toBe(false); expect(evidence.productionAccepted).toBe(false);
  }
});
test('nonce, helper/root/thread incarnation, owner and suspend counts cannot change during handoff', () => {
  for (const [from, to] of [['helper=11', 'helper=12'], ['helper-created=100', 'helper-created=101'],
    ['root=22', 'root=23'], ['created=200', 'created=201'], ['tid=33', 'tid=34'], ['thread-owner=22', 'thread-owner=23'], ['thread-created=300', 'thread-created=301'],
    [`nonce=${expected.nonce}`, `nonce=${'ac'.repeat(16)}`], ['previous=1', 'previous=2'], ['phase=suspend', 'phase=resume']])
    expect(validate(replace(from!, to!)).protocolValid).toBe(false);
});
test('missing/duplicate assignment, closed anchor and complete protocol are mandatory', () => {
  for (const [from, to] of [['phase=assign', 'phase=missing'], ['phase=complete', 'phase=missing'],
    ['closed=1', 'closed=0'], ['cleanup close=retire-named-map closed=1', 'cleanup close=retire-named-map closed=0'],
    ['map-retire live pid=22 set=0x00000000', 'map-retire live pid=22 set=0xc0000022'],
    ['map-retire named path=', 'map-retire wrong path=']]) expect(validate(replace(from!, to!)).protocolValid).toBe(false);
  const f = fixture();
  expect(validate({...f, err: f.err + 'map-retire pid=22 set=0x00000000\r\n'}).protocolValid).toBe(false);
  expect(validate({...f, err: f.err + 'map-retire ready pid=22 signaled=1 job-active=0 exit=1\r\n'}).protocolValid).toBe(false);
  const e = fixture('exited');
  expect(validate({...e, err: e.err.replace('phase=exit', 'phase=assign')}, 'exited').protocolValid).toBe(false);
});
test('late root, restarted deadline, forced exits and rewritten original result remain invalid', () => {
  for (const [from, to] of [['now=1010', 'now=16000'], ['deadline=16000', 'deadline=17000'],
    ['result=1', 'result=0'], ['error=0', 'error=1460'], ['thread=1 process=1', 'thread=0 process=1'], ['depth=0 child=23', 'depth=0 child=24']])
    expect(validate(replace(from!, to!)).protocolValid).toBe(false);
  const f = fixture();
  expect(validate({...f, out: f.out.replace('forced=0', 'forced=1')}).protocolValid).toBe(false);
  expect(validate({...f, out: f.out.replace('inspect-exit=1', 'inspect-exit=125')}).protocolValid).toBe(false);
  expect(validate({...f, timedOut: true}).protocolValid).toBe(false);
  expect(validate({...f, code: null}).protocolValid).toBe(false);
});
test('boundary, caller, names and every original cleanup gate remain independently fatal', () => {
  for (const [from, to] of [['job=1 nonbreakaway=1', 'job=0 nonbreakaway=1'], ['role=boundary pid=22 success=1', 'role=boundary pid=22 success=0'],
    ['caller snapshot=after map=unchanged', 'caller snapshot=after map=changed'], ['action=desktop success=1', 'action=desktop success=0'],
    ['cleanup close=root-process closed=1', 'cleanup close=root-process closed=0'], ['cleanup map-open=0xc0000034 absent=1', 'cleanup map-open=0xc0000022 absent=0'],
    ['phase=final status=', 'phase=missing status='], [`${path}.retired create=`, `${path}.retired.extra create=`]])
    expect(validate(replace(from!, to!)).protocolValid).toBe(false);
  const retainedOriginal = validate(replace('cleanup map-open=0xc0000034 absent=1', 'cleanup map-open=0x00000000 absent=0'));
  expect(retainedOriginal.protocolValid).toBe(true); expect(retainedOriginal.cleanupGatesPassed).toBe(false);
  expect(retainedOriginal.reproducesBaseline).toBe(false); expect(retainedOriginal.outcome).toBe('original-map-retained');
  expect(validate({...fixture(), code: 1}).protocolValid).toBe(false);
  expect(() => parseRetirementFrame('retirement-timing invalid')).toThrow();
});
test('native creation/set/close and joined-child evidence cannot cross the lifetime barrier', () => {
  for (const mode of ['live', 'exited'] as const) {
    const f = fixture(mode), lines = f.err.split('\r\n');
    const set = lines.findIndex(l => /^map-retire (?:live )?pid=/.test(l));
    const line = lines.splice(set, 1)[0]!;
    const exit = lines.findIndex(l => l.startsWith('retirement-timing phase=exit '));
    lines.splice(mode === 'live' ? exit + 1 : exit, 0, line);
    expect(validate({...f, err: lines.join('\r\n')}, mode).protocolValid).toBe(false);
  }
  const f = fixture(), lines = f.err.split('\r\n');
  const child = lines.splice(lines.findIndex(l => l.startsWith('retirement-child-closed pid=22 ')), 1)[0]!;
  lines.splice(lines.findIndex(l => l.startsWith('retirement-timing phase=ready ')) + 1, 0, child);
  expect(validate({...f, err: lines.join('\r\n')}).protocolValid).toBe(false);
});
test('generation preserves old selectors, exited-only retirement, and exactly one selected replacement', () => {
  const code = generate(readFileSync(sourcePath, 'utf8'));
  for (const selector of ['run', 'debug-run', 'direct-run', 'setter-run', 'quiet-run', 'reopen-run', 'creator-run',
    'retire-run', 'retire-named-run', 'target-exited-run', 'target-waiting-run', 'target-helper-exited-run',
    'thread-exited-run', 'thread-waiting-run', 'retire-live-run', 'retire-exited-run']) expect(code).toContain(`L"${selector}"`);
  expect(code).toContain('if (retire_owned_map && child.hProcess && retirement_timing_mode != 1)');
  expect(code.match(/DWORD retired = map_retire\(/g)).toHaveLength(1);
  expect(code).toContain('retirement_timing_mode ? retirement_remaining() : 15000');
  const initialResume = code.indexOf('if (ResumeThread(child.hThread)');
  expect(code.indexOf('error = retirement_start(&child')).toBeLessThan(initialResume);
  expect(code.indexOf('error = retirement_final(&child')).toBeGreaterThan(initialResume);
});

test('serial failure cleanup joins delayed timing/twin observers before killAll and collects their rejection', async () => {
  // Execute the native fixture's actual finally prefix without starting a core
  // or Windows process. Capture completion and observer completion differ.
  const source = readFileSync(new URL('./routing.test.ts', import.meta.url), 'utf8');
  const start = source.lastIndexOf('  finally {') + '  finally {'.length;
  const end = source.indexOf('    for (const job of jobs)', start);
  const cleanup = new Function('runControlBatches', 'timingTasks', 'pairedTasks', 'tasks', 'failures', 'procs',
    `return (async () => {${source.slice(start, end)}})();`) as
    (schedule:typeof runControlBatches, pair:Promise<void>[], batches:(()=>Promise<void>)[], captures:Promise<unknown>[], failures:string[], procs:{killAll():Promise<void>})=>Promise<void>;
  const events: string[] = [], failures: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const continuation = (async () => {await barrier; events.push('observer-finished'); throw new Error('late observer failure');})();
  const finished = cleanup(runControlBatches,[continuation],[async()=>{events.push('paired-finished');throw Error('paired failure');}], [Promise.resolve()], failures, {async killAll() {events.push('killAll');}});
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  } finally {release();}
  await finished;
  expect(events.filter(e=>e!=='paired-finished')).toEqual(['observer-finished', 'killAll']);
  expect(events).toEqual(['observer-finished','paired-finished','killAll']);
  expect(failures).toHaveLength(2); expect(failures[0]).toContain('late observer failure');
  expect(failures[1]).toContain('paired control capture: Error: paired failure');
});
