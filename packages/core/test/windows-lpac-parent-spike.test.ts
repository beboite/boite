import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {aggregateSpike, spikeSource, spikeVerdict} from './windows-lpac-parent-spike.ts';
import type {Captured} from '../../../tests/diagnostics/windows-debug-map/capture.ts';

/** Full protocol transcripts, not Windows evidence. Native runs stay opt-in. */
function transcript(mode: 0 | 1): Captured {
  const lines: string[] = [`SPIKE_GUARD mode=${mode} process=6 thread=6 null=6`];
  for (let level = 0; level < 3; level++) {
    if (level) lines.push(`SPIKE_CREATE mode=${mode} level=${level} error=0 suspended=1 override=0`);
    lines.push(`SPIKE_TOKEN mode=${mode} level=${level} app=1 package=1 lpac=1 caps=1 registry=1 integrity=4096 policy=${mode} job=1 ppid=1 error=0`);
  }
  for (let level = 0; level < 3; level++) {
    const code = level < 2 && mode ? 367 : 0;
    const status = code ? '0xc000049d' : '0x00000000';
    lines.push(`SPIKE_REPLY mode=${mode} level=${level} magic=1 argv=1 env=1 cwd=1 stdio=1 included=1 omitted=1 policy=1 host-create=5 host-write=5 direct=${code} alternate=${code} native=${code} native-status=${status} native-alternate=${code} native-alternate-status=${status} cleanup=0`);
  }
  lines.push(`SPIKE_CLEANUP mode=${mode} active=0 error=0`);
  return {pid: 42, code: 0, out: '', err: lines.join('\n') + '\n', timedOut: false};
}
const mutate = (capture: Captured, before: string, after: string): Captured => ({...capture, err: capture.err.replace(before, after)});

function rejected(control: Captured, restricted: Captured) {
  const verdict = spikeVerdict(control, restricted);
  expect(verdict.complete).toBe(false);
  expect(verdict.kernelGatePassed).toBe(false);
}

describe('LPAC parent spike evidence', () => {
  test('requires both complete positive controls and complete restricted contracts', () => {
    expect(spikeVerdict(transcript(0), transcript(1))).toEqual({complete: true, kernelGatePassed: true,
      reason: 'kernel composition and scoped fixture contracts passed; production not admitted'});
  });

  test('records a bounded broker refusal as a negative result, never as admission', () => {
    const restricted = transcript(1);
    restricted.code = 125;
    restricted.err = restricted.err.split('\n').filter(line => line.startsWith('SPIKE_TOKEN mode=1 level=0 ') || line.startsWith('SPIKE_GUARD ')).join('\n') +
      '\nSPIKE_CREATE mode=1 level=1 error=367 suspended=1 override=0\nSPIKE_CLEANUP mode=1 active=0 error=0\n';
    expect(spikeVerdict(transcript(0), restricted)).toEqual({complete: true, kernelGatePassed: false,
      reason: 'restricted parent broker creation refused; see raw Win32 error'});
    rejected(transcript(0), mutate(restricted, 'lpac=1', 'lpac=0'));
    rejected(transcript(0), mutate(restricted, 'override=0', 'override=1'));
  });

  test('opposite complete SDK and MinGW verdicts remain incomplete with both raw outcomes', () => {
    const control = transcript(0), restricted = transcript(1);
    const refused: Captured = {...restricted, code: 125, err:
      'SPIKE_GUARD mode=1 process=6 thread=6 null=6\n' +
      'SPIKE_TOKEN mode=1 level=0 app=1 package=1 lpac=1 caps=1 registry=1 integrity=4096 policy=1 job=1 ppid=1 error=0\n' +
      'SPIKE_CREATE mode=1 level=1 error=367 suspended=1 override=0\nSPIKE_CLEANUP mode=1 active=0 error=0\n'};
    const positive = spikeVerdict(control, restricted), negative = spikeVerdict(control, refused);
    expect(positive.complete).toBe(true);
    expect(negative.complete).toBe(true);
    for (const [sdk, mingw] of [[positive, negative], [negative, positive]] as const) {
      const results = [{name: 'sdk', verdict: sdk, raw: restricted}, {name: 'mingw', verdict: mingw, raw: refused}];
      const before = structuredClone(results);
      const summary = aggregateSpike(results, false, false);
      expect(summary.experimentComplete).toBe(false);
      expect(summary.kernelGatePassed).toBe(false);
      expect(summary.aggregationReason).toBe(`compiler disagreement: sdk kernelGatePassed=${sdk.kernelGatePassed}; mingw kernelGatePassed=${mingw.kernelGatePassed}`);
      expect(results).toEqual(before);
    }
    expect(aggregateSpike([{name: 'sdk', verdict: positive}, {name: 'mingw', verdict: positive}], false, false).experimentComplete).toBe(true);
    const bothRefused = aggregateSpike([{name: 'sdk', verdict: negative}, {name: 'mingw', verdict: negative}], false, false);
    expect(bothRefused.experimentComplete).toBe(true);
    expect(bothRefused.kernelGatePassed).toBe(false);
  });

  test('alternate-parent controls must succeed independently for Win32 and NT', () => {
    for (const before of ['alternate=0', 'native-alternate=0']) {
      for (const error of ['5', '6', '367']) rejected(mutate(transcript(0), before, before.replace('=0', `=${error}`)), transcript(1));
    }
  });

  test('a host token, wrong package, lost LPAC, capability, job or parent cannot pass', () => {
    for (const [before, after] of [['app=1', 'app=0'], ['package=1', 'package=0'], ['lpac=1', 'lpac=0'],
      ['caps=1', 'caps=2'], ['registry=1', 'registry=0'], ['integrity=4096', 'integrity=8192'],
      ['policy=1', 'policy=0'], ['job=1', 'job=0'], ['ppid=1', 'ppid=0']]) {
      rejected(transcript(0), mutate(transcript(1), before!, after!));
    }
  });

  test('an inherited policy or broker flag override cannot be silently omitted', () => {
    rejected(transcript(0), mutate(transcript(1), 'override=0', 'override=1'));
    rejected(transcript(0), mutate(transcript(1), 'suspended=1', 'suspended=0'));
    rejected(transcript(0), mutate(transcript(1), 'SPIKE_CREATE mode=1 level=1', 'SPIKE_CREATE mode=1 level=2'));
  });

  test('client argv, env, cwd, pipe transport and handle inclusion remain required', () => {
    for (const key of ['magic', 'argv', 'env', 'cwd', 'stdio', 'included', 'omitted']) {
      rejected(transcript(0), mutate(transcript(1), `${key}=1`, `${key}=0`));
    }
  });

  test('host PROCESS_CREATE_PROCESS and VM_WRITE are separate denied authorities', () => {
    for (const key of ['host-create', 'host-write']) rejected(transcript(0), mutate(transcript(1), `${key}=5`, `${key}=0`));
  });

  test('NUL or wrong-handle failure is not a child-policy proof on any route', () => {
    for (const route of ['direct', 'alternate', 'native', 'native-alternate']) {
      for (const error of ['5', '6']) rejected(transcript(0), mutate(transcript(1), `${route}=367`, `${route}=${error}`));
    }
  });

  test('successful direct or alternate-parent creation invalidates the kernel gate', () => {
    for (const route of ['direct', 'alternate', 'native', 'native-alternate']) rejected(transcript(0), mutate(transcript(1), `${route}=367`, `${route}=0`));
  });

  test('raw NTSTATUS and its success or failure must accompany both native routes', () => {
    for (const key of ['native-status', 'native-alternate-status']) {
      rejected(transcript(0), mutate(transcript(1), `${key}=0xc000049d`, `${key}=na`));
      rejected(transcript(0), mutate(transcript(1), `${key}=0xc000049d`, `${key}=0x00000000`));
      rejected(mutate(transcript(0), `${key}=0x00000000`, `${key}=0xc0000022`), transcript(1));
    }
  });

  test('partial, duplicate, timed out or unclosed captures cannot pass', () => {
    rejected(transcript(0), {...transcript(1), timedOut: true});
    rejected(transcript(0), {...transcript(1), code: 125});
    rejected(transcript(0), mutate(transcript(1), 'SPIKE_REPLY mode=1 level=1', 'SPIKE_REPLY mode=1 level=0'));
    rejected(transcript(0), mutate(transcript(1), 'SPIKE_TOKEN mode=1 level=0', 'IGNORED_TOKEN mode=1 level=0'));
    rejected(transcript(0), mutate(transcript(1), 'process=6 thread=6 null=6', 'process=0 thread=6 null=6'));
    for (const [before, after] of [['SPIKE_CLEANUP', 'MISSING_CLEANUP'], ['active=0', 'active=1'], ['cleanup=0', 'cleanup=6']]) {
      rejected(transcript(0), mutate(transcript(1), before!, after!));
    }
  });

  test('source derives an isolated launch while preserving every original production function', () => {
    const original = readFileSync(new URL('../src/platform/windows/protected-tool.c', import.meta.url), 'utf8');
    const generated = spikeSource(original);
    const launch = original.slice(original.indexOf('static int launch('), original.indexOf('\nstatic int probe('));
    const probe = original.slice(original.indexOf('static int probe('), original.indexOf('\n/* Read-only diagnostic'));
    expect(generated).toContain(launch);
    expect(generated).toContain(probe);
    expect(generated).toContain('PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &sp_restricted');
    expect(generated).toContain('GetProcAddress(ntdll, "NtCreateUserProcess")');
    expect(generated).not.toContain('PROCESS_CREATION_CHILD_PROCESS_OVERRIDE');
    expect(() => spikeSource(original + '\n')).toThrow('review spike provenance');
  });
});
