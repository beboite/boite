import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {expected, path, twinFixture as twin} from './retirement-fixture.ts';
import {validateDirectoryTwin} from './directory-twin.ts';
import {generate, sourcePath} from './generate.ts';
import type {Captured} from './capture.ts';


const validate = (captured: Captured) => validateDirectoryTwin(captured, {...expected, mode: 'live'});
test('twin separates attachment comparison, protocol validity and fatal cleanup outcomes', () => {
  for (const unusedAbsent of [true, false]) for (const attachedAbsent of [true, false]) {
    const r = validate(twin(unusedAbsent, attachedAbsent));
    expect(r.protocolValid).toBe(true); expect(r.unusedAbsencePassed).toBe(unusedAbsent);
    expect(r.reproducesBaseline).toBe(!attachedAbsent); expect(r.cleanupGatesPassed).toBe(unusedAbsent && attachedAbsent);
    expect(r.causeConfirmed).toBe(false); expect(r.productionAccepted).toBe(false);
  }
});
test('twin identities, nonce, exact sibling names, matched rights and original lifetime remain bound', () => {
  const f = twin();
  for (const [from, to] of [['helper=11', 'helper=12'], ['helper-created=100', 'helper-created=101'], ['root=22', 'root=23'],
    ['created=200', 'created=201'], [`nonce=${expected.nonce}`, `nonce=${'cd'.repeat(16)}`], [`path=${path}.unused`, `path=${path}.unused.extra`],
    ['granted=0x000f000f', 'granted=0x00000001'], ['attributes=0x00000000', 'attributes=0x00000010'], ['flags=0', 'flags=1'], ['absent=1 error=0', 'absent=1 error=6'],
    ['result=1', 'result=0'], ['deadline=16000', 'deadline=16001']]) {
    // Mutate the twin record for shared identity fields, rather than only the
    // base barrier. A correct barrier cannot mask an unrelated twin record.
    const start = f.err.indexOf('directory-twin '), before = f.err.slice(0, start), after = f.err.slice(start);
    expect(validate({...f, err: before + after.replace(from!, to!)}).protocolValid).toBe(false);
  }
});
test('assignment to unused, duplicate assignment, failed close and missing observation fail closed', () => {
  const f = twin();
  for (const [from, to] of [['phase=set role=attached', 'phase=set role=unused'], ['phase=same role=attached', 'phase=set role=attached'],
    ['phase=close-create role=unused', 'phase=missing role=unused'], ['status=0x00000000 closed=1', 'status=0x00000006 closed=0'],
    ['phase=checkpoint role=unused', 'phase=missing role=unused'], ['phase=verify-open role=unused', 'phase=missing role=unused']])
    expect(validate({...f, err: f.err.replace(from!, to!)}).protocolValid).toBe(false);
  expect(validate({...f, err: f.err + f.err.split('\r\n').find(l => l.startsWith('directory-twin phase=set '))+'\r\n'}).protocolValid).toBe(false);
  expect(validate({...f, code: 1}).protocolValid).toBe(false);
  expect(validate({...f, timedOut: true}).protocolValid).toBe(false);
});
test('actual open/same/close/set operations must occur inside their selected root barrier', () => {
  for (const [prefix, before] of [['directory-twin phase=set ', 'retirement-timing phase=exit '],
    ['directory-twin phase=close-create role=unused ', 'retirement-timing phase=resume '],
    ['cleanup close=twin-unused-open ', 'directory-twin phase=set '],
    ['directory-twin phase=open role=unused ', 'directory-twin phase=create role=unused '],
    ['directory-twin phase=same role=attached ', 'directory-twin phase=open role=attached ']]) {
    const f = twin(), lines = f.err.split('\r\n');
    const event = lines.splice(lines.findIndex(l => l.startsWith(prefix!)), 1)[0]!;
    const point = lines.findIndex(l => l.startsWith(before!));
    lines.splice(prefix!.includes('close-') || prefix!.includes('phase=set') ? point + 1 : point, 0, event);
    expect(validate({...f, err: lines.join('\r\n')}).protocolValid).toBe(false);
  }
});
test('generator selects one separate LIVE twin and exact unused suffix without changing old modes', () => {
  const code = generate(readFileSync(sourcePath, 'utf8'));
  expect(code).toContain('L"directory-twin-run"');
  expect(code).toContain('directory_twin_mode = !wcscmp(args[1], L"directory-twin-run")');
  expect(code).toContain('if (retire_owned_map && child.hProcess && retirement_timing_mode != 1)');
  const observer = readFileSync(new URL('./inspect.h', import.meta.url), 'utf8');
  expect(observer).toContain('wcscmp(tail, L".unused")');
});
