import type {Captured} from './capture.ts';
import type {RetirementMode} from './retirement-timing.ts';

export const expected = {nonce: 'ab'.repeat(16), helper: {pid: 11, created: '100'}, root: {pid: 22, created: '200'}, marker: 'TASK_ROUTE_TIMING_FIXTURE'};
export const path = String.raw`\Sessions\2\BaseNamedObjects\boite.route.11`;
export function fixture(mode: RetirementMode = 'live', absent = false): Captured {
  const phases = mode === 'live' ? ['start', 'ready', 'suspend', 'assign', 'resume', 'release', 'exit', 'complete']
    : ['start', 'ready', 'suspend', 'resume', 'release', 'exit', 'assign', 'complete'];
  const frame = (phase: string, i: number) => `retirement-timing phase=${phase} mode=${mode} nonce=${expected.nonce} helper=11 helper-created=100 root=22 created=200 tid=33 thread-owner=22 thread-created=300 result=1 started=1000 deadline=16000 now=${1000 + i * 10} previous=${phase === 'resume' ? 1 : 0} closed=${phase === 'start' ? 0 : 1} error=0`;
  const body = ['caller snapshot=before map=unchanged NUL=unchanged drive=unchanged privileges-bytes=10 unchanged=1',
    'token-cleanup role=launch pid=22 success=1 error=0',
    ...Array.from({length: 2}, () => ['token-cleanup role=boundary pid=22 success=1 error=0',
      'debug-create pid=22 job=1 nonbreakaway=1 package/capability=1 lpac=1 attribute=0x00000000']).flat(),
    `private-map path=${path} create=0x00000000`, 'private-map pid=22 set=0x00000000',
    'retirement-child-closed pid=22 depth=0 child=23 thread=1 process=1',
    'retirement-child-closed pid=23 depth=1 child=24 thread=1 process=1',
    ...phases.slice(0, phases.indexOf('assign')).map((phase, i) => frame(phase, i)),
    ...(mode === 'exited' ? ['cleanup job-active=0', 'map-retire ready pid=22 signaled=1 job-active=0 exit=1'] : []),
    `map-retire named path=${path}.retired create=0x00000000`,
    mode === 'live' ? 'map-retire live pid=22 set=0x00000000 named=1 inherited=0 links=0' : 'map-retire pid=22 set=0x00000000',
    'cleanup close=retire-named-map closed=1 error=0',
    ...phases.slice(phases.indexOf('assign'), -1).map((phase, i) => frame(phase, phases.indexOf('assign') + i)),
    ...(mode === 'live' ? ['cleanup job-active=0'] : []), ...['root-thread', 'root-process', 'job', 'link', 'map'].map(x => `cleanup close=${x} closed=1 error=0`),
    ...['station-restore', 'desktop', 'station'].map(x => `window-cleanup action=${x} success=1 error=0`),
    ...[0, 1, 2].map(x => `stream-cleanup index=${x} success=1 error=0`),
    'cleanup map-open=0xc0000034 absent=1',
    'cleanup map-eventual-open=0xc0000034 absent=1 elapsed-ms=0 attempts=1 limit-ms=2000',
    'cleanup checkpoint-map-open=0xc0000034 absent=1 closed=1 error=0 wall-ms=1100',
    ...['immediate', 'checkpoint', 'final'].flatMap(phase => [
      ...(phase === 'final' ? ['caller snapshot=after map=unchanged NUL=unchanged drive=unchanged privileges-bytes=10 unchanged=1'] : []),
      `cleanup retired-open phase=${phase} status=${absent ? '0xc0000034' : '0x00000000'} absent=${+absent} closed=1 error=0 path=${path}.retired`]),
    frame('complete', 7)];
  return {pid: 11, code: absent ? 1 : 125, timedOut: false, err: body.join('\r\n') + '\r\n',
    out: [0, 1, 2].flatMap(depth => {
      const label = `${expected.marker}.generation-${depth}`;
      return [`inspect-start=${label} pid=${22 + depth}`, `${label} appcontainer=1 in-job=1 routing=${depth === 0 ? 1 : 0}`,
        `${label} ambient-denial=5`, `${label} host-debug-control=0 known=1`, `${label} inspect-exit=1 child-exit=${depth === 2 ? 0 : 1} forced=0`];
    }).join('\r\n') + '\r\n'};
}

export function twinFixture(unusedAbsent = true, attachedAbsent = false): Captured {
  const base = fixture('live', attachedAbsent);
  const frame = (phase: string, role: string, status = '0x00000000', closed = 0) =>
    `directory-twin phase=${phase} role=${role} nonce=${expected.nonce} helper=11 helper-created=100 root=22 created=200 path=${path}.${role === 'attached' ? 'retired' : 'unused'} now=1020 status=${status} closed=${closed} verified=${+phase.startsWith('verify-')} granted=${phase.startsWith('verify-') ? '0x000f000f' : '0x00000000'} attributes=0x00000000 flags=0 absent=${+(status === '0xc0000034')} error=0`;
  const operations = [frame('create', 'attached'), frame('verify-create', 'attached'), frame('create', 'unused'), frame('verify-create', 'unused'),
    ...['attached', 'unused'].flatMap(role => [frame('open', role), frame('verify-open', role), frame('same', role)]),
    ...['attached', 'unused'].flatMap(role => [`cleanup close=twin-${role}-open closed=1 error=0`, frame('close-open', role, undefined, 1)]), frame('set', 'attached')];
  let err = base.err.replace(`map-retire named path=${path}.retired create=0x00000000`,
    `${operations[0]}\r\nmap-retire named path=${path}.retired create=0x00000000\r\n${operations.slice(1).join('\r\n')}`);
  err = err.replace('cleanup close=retire-named-map closed=1 error=0',
    `cleanup close=retire-named-map closed=1 error=0\r\n${frame('close-create', 'attached', undefined, 1)}\r\ncleanup close=twin-unused-map closed=1 error=0\r\n${frame('close-create', 'unused', undefined, 1)}`);
  for (const phase of ['immediate', 'checkpoint', 'final']) err = err.replace(`cleanup retired-open phase=${phase} `,
    `${frame(phase, 'unused', unusedAbsent ? '0xc0000034' : '0x00000000', 1).replace('now=1020', 'now=1060')}\r\ncleanup retired-open phase=${phase} `);
  return {...base, code: unusedAbsent && attachedAbsent ? 1 : 125, err};
}
