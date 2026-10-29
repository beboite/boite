import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../../../packages/core/src/journal.ts';
import {Bus} from '../../../packages/core/src/bus.ts';
import {ProcRegistry} from '../../../packages/core/src/procs.ts';
import {capture} from './capture.ts';
import {selectedEnvironment} from './environment.ts';
import {expected, path, twinFixture} from './retirement-fixture.ts';
import {validateAnchorOverlap, compareAnchorPair, corroborateAnchorRegistry, type AnchorReport} from './anchor-overlap.ts';
import type {LedgerRow, Membership, TopologyRequest} from './target-topology.ts';
import type {Captured} from './capture.ts';

const compiler = process.platform === 'win32' ? null : Bun.which('cc');
test.skipIf(!compiler)('anchor native access guard accepts the measured implied right and rejects broader masks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-anchor-access-'));
  const journal = new Journal(join(directory, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    // Compile the actual guard; the fixture supplies Win32 query results only.
    const source = readFileSync(join(import.meta.dir, 'anchor-overlap.h'), 'utf8');
    const start = source.indexOf('static DWORD ao_access('), end = source.indexOf('\nstatic DWORD ao_topology(', start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    writeFileSync(join(directory, 'anchor-access-function.h'), source.slice(start, end));
    const executable = join(directory, 'anchor-access-cases');
    const built = await capture(procs, 'compile-anchor-access', procs.spawnPiped('compile-anchor-access', compiler!,
      ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I', directory, join(import.meta.dir, 'anchor-access-cases.c'), '-o', executable],
      {cwd: directory, env: selectedEnvironment(), agentRoot: false}), 15000);
    expect(built.timedOut).toBe(false); expect(built.code, built.out + built.err).toBe(0);
    const result = await capture(procs, 'anchor-access-cases', procs.spawnPiped('anchor-access-cases', executable, [],
      {cwd: directory, env: selectedEnvironment(), agentRoot: false}), 5000);
    expect(result.timedOut).toBe(false); expect(result.code, result.out + result.err).toBe(0);
    expect(result.out).toBe('ANCHOR_ACCESS_CASES_PASS: 78 cases\n');
  } finally {await procs.killAll(); await procs.close(); journal.close(); rmSync(directory, {recursive: true, force: true});}
}, 30000);

function anchor(mode: 'exclusive' | 'held', attachedAbsent = false): Captured {
  const f = twinFixture(true, attachedAbsent);
  const lines = f.err.split('\r\n');
  const take = (prefix: string) => lines.splice(lines.findIndex(l => l.startsWith(prefix)), 1)[0]!;
  const createClose = take('directory-twin phase=close-create role=attached ');
  const createNative = take('cleanup close=retire-named-map ');
  const unusedClose = take('directory-twin phase=close-create role=unused ');
  const unusedNative = take('cleanup close=twin-unused-map ');
  const twinSet = take('directory-twin phase=set '), actualSet = take('map-retire live pid=');
  const frame = (phase: string, closed = 0) => `anchor-overlap phase=${phase} mode=${mode} nonce=${expected.nonce} helper=11 helper-created=100 setter=44 setter-created=400 root=22 created=200 tid=33 thread-created=300 path=${path}.retired now=1020 started=1020 deadline=6020 status=0x00000000 closed=${closed} verified=1 process-access=0x00101200 map-access=0x00000003 flags=${phase.startsWith('duplicate-') ? 1 : 0} error=0`;
  const close = [createNative, createClose, frame('helper-close', 1)];
  const native = [unusedNative, unusedClose,
    frame('duplicate-process'), frame('duplicate-directory'), frame('start'),
    'anchor-confinement setter=44 inherited=2 member=1 private=0 image=1 token=1',
    frame('close-transfer-process', 1), frame('close-transfer-directory', 1),
    ...['creator','root'].map(phase=>`anchor-topology phase=${phase} setter=44 created=400 proved=1 error=0`), frame('request'), frame('child-ready'),
    ...(mode === 'exclusive' ? close : []), frame('go'), frame('child-set'), twinSet, actualSet,
    ...(mode === 'held' ? close : []), frame('release'), frame('child-close-directory', 1), frame('child-close-process', 1), frame('child-exit'),
    ...['thread', 'process', 'job'].map(k => frame('close-parent-'+k, 1)), 'anchor-topology phase=closed setter=44 created=400 proved=1 error=0', frame('registry-closed'),
    'anchor-cleanup setter=44 created=400 acquired=5 closed=5 files-acquired=10 files-closed=10 forced=0 exit=0 error=0'];
  lines.splice(lines.findIndex(l => l.startsWith('retirement-timing phase=assign ')), 0, ...native);
  const checkpoint=take('cleanup checkpoint-map-open=').replace('wall-ms=1100','wall-ms=4100')+' path='+path;
  lines.splice(lines.findIndex(l=>l.startsWith('directory-twin phase=checkpoint ')),0,'ownership-checkpoint helper=11 wall-ms=1100 targets=22 hold-ms=3000',checkpoint);
  for(let i=0;i<lines.length;i++) if(/^directory-twin phase=(checkpoint|final) /.test(lines[i]!)) lines[i]=lines[i]!.replace('now=1060','now=4100');
  const complete=lines.findIndex(l=>l.startsWith('retirement-timing phase=complete ')); lines[complete]=lines[complete]!.replace('now=1070','now=4100');
  return {...f, err: lines.join('\r\n')};
}
const validate = (mode: 'exclusive' | 'held', f = anchor(mode)) => validateAnchorOverlap(f, {...expected, mode: 'live'}, mode);
const confirmed = (mode: 'exclusive' | 'held', absent=false) => ({...validate(mode,anchor(mode,absent)),registryCorroborated:true,postHelperAbsencePassed:true});
test('matched anchor pair separates protocol, positive baseline and unchanged fatal cleanup', () => {
  for (const mode of ['exclusive', 'held'] as const) for (const absent of [false, true]) {
    const r = validate(mode, anchor(mode, absent));
    expect(r.error).toBeUndefined(); expect(r.protocolValid).toBe(true);
    expect(r.unusedAbsencePassed).toBe(true); expect(r.reproducesBaseline).toBe(!absent);
    expect(r.cleanupGatesPassed).toBe(absent); expect(r.causeConfirmed).toBe(false); expect(r.productionAccepted).toBe(false);
  }
  expect(compareAnchorPair(confirmed('exclusive',true),confirmed('held')).outcome).toBe('overlap-associated-difference');
  expect(compareAnchorPair(confirmed('exclusive'),confirmed('held')).outcome).toBe('both-retained');
  expect(compareAnchorPair(confirmed('exclusive',true),confirmed('held',true)).comparable).toBe(false);
  expect(compareAnchorPair(validate('exclusive'),confirmed('held')).comparable).toBe(false);
});

function registry(mode: 'exclusive'|'held') {
  const rows:(LedgerRow & {wallMs?:number; error?:number})[]=[], proof:Membership[]=[];
  for (const role of ['launcher-main','harness-main']) {
    rows.push({event:'acquired',owner:role,role,pid:44,incarnation:'400',id:role});
    rows.push({event:'close-result',owner:role,role,pid:44,incarnation:'400',id:role,success:true,error:0,wallMs:1050});
    for (const [pid,created] of [[11,'100'],[44,'400'],[22,'200']] as const)
      proof.push({owner:role,role,pid,created,threadId:'fixture',threadJob:'80',globalJob:'90',nestingRefused:false,threadMember:1,globalMember:1});
  }
  const proofs=['creator','root','closed'].map(phase=>({request:{version:1,phase,nonce:expected.nonce,waiting:mode==='held',helper:expected.helper,
    creator:{pid:44,created:'400'},root:phase==='creator'?null:expected.root} as TopologyRequest,proof,creatorReferencesClosed:phase==='closed'}));
  return {rows,proofs};
}
test('registry proof binds the exact setter incarnation and closes before the checkpoint',()=>{
  const valid=registry('exclusive');
  expect(corroborateAnchorRegistry(validate('exclusive'),valid.rows,valid.proofs)).toBe(true);
  for (const alter of [
    (r:ReturnType<typeof registry>)=>{r.rows[1]!.incarnation='399';},
    (r:ReturnType<typeof registry>)=>{r.rows[1]!.wallMs=1200;},
    (r:ReturnType<typeof registry>)=>{r.rows[1]!.success=false;},
    (r:ReturnType<typeof registry>)=>{r.rows[1]!.error=6;},
    (r:ReturnType<typeof registry>)=>{r.rows.push({...r.rows[1]!});},
    (r:ReturnType<typeof registry>)=>{r.rows.push({event:'incomplete',owner:'fixture',role:'harness-main'});},
    (r:ReturnType<typeof registry>)=>{r.proofs[2]!.creatorReferencesClosed=false;},
    (r:ReturnType<typeof registry>)=>{r.proofs[1]!.request.root={pid:22,created:'199'};},
    (r:ReturnType<typeof registry>)=>{r.proofs[0]!.proof[1]!.threadMember=0;},
  ]) {
    const fixture=registry('exclusive'); alter(fixture);
    const report=validate('exclusive'); expect(corroborateAnchorRegistry(report,fixture.rows,fixture.proofs)).toBe(false);
    expect(compareAnchorPair(report,{...confirmed('held')} as AnchorReport).comparable).toBe(false);
  }
});
test('anchor actual operations cannot be moved across GO, ASSIGNED, RELEASE or root exit', () => {
  for (const mode of ['exclusive','held'] as const) for (const [prefix, target] of [
    ['anchor-overlap phase=helper-close ', 'anchor-overlap phase=go '],
    ['anchor-overlap phase=child-set ', 'anchor-overlap phase=release '],
    ['cleanup close=retire-named-map ', 'retirement-timing phase=resume '],
    ['anchor-overlap phase=close-transfer-directory ', 'anchor-overlap phase=go '],
    ['anchor-overlap phase=child-close-directory ', 'anchor-overlap phase=release '],
    ['map-retire live pid=', 'retirement-timing phase=exit '],
    ['anchor-overlap phase=registry-closed ', 'retirement-timing phase=resume '],
  ]) {
    const f = anchor(mode), lines = f.err.split('\r\n');
    const moved = lines.splice(lines.findIndex(l => l.startsWith(prefix!)),1)[0]!;
    const point = lines.findIndex(l => l.startsWith(target!));
    lines.splice(prefix!.includes('child-close') || (prefix!.includes('helper-close') && mode === 'held') ? point : point+1,0,moved);
    expect(validate(mode,{...f,err:lines.join('\r\n')}).protocolValid).toBe(false);
  }
});
test('anchor nonce, captured identities, handle rights, image and closure evidence fail closed', () => {
  for (const [before,after] of [
    ['nonce='+expected.nonce,'nonce='+'cd'.repeat(16)], ['setter-created=400','setter-created=401'], ['setter=44','setter=22'],
    ['helper-created=100','helper-created=101'], ['root=22','root=23'], ['tid=33','tid=34'], ['thread-created=300','thread-created=301'],
    ['path='+path+'.retired','path='+path+'.unused'], ['process-access=0x00101200','process-access=0x001f1200'],
    ['map-access=0x00000003','map-access=0x000f000f'], ['verified=1','verified=0'], ['status=0x00000000','status=0xc0000022'],
    ['deadline=6020','deadline=6021'], ['now=1020','now=6020'], ['flags=1','flags=0'],
    ['wall-ms=1100','wall-ms=99999999999999999'], ['wall-ms=4100','wall-ms=4099'],
    ['closed=1','closed=0'], ['error=0','error=6'], ['private=0','private=1'], ['image=1','image=0'], ['inherited=2','inherited=3'],
  ]) {
    const f=anchor('exclusive'), offset=f.err.indexOf('anchor-overlap ');
    expect(validate('exclusive',{...f,err:f.err.slice(0,offset)+f.err.slice(offset).replace(before!,after!)}).protocolValid).toBe(false);
  }
  const f=anchor('exclusive');
  expect(validate('exclusive',{...f,code:1}).protocolValid).toBe(false);
  expect(validate('exclusive',{...f,timedOut:true}).protocolValid).toBe(false);
  expect(validate('exclusive',{...f,err:f.err.replace('phase=child-close-process','phase=missing')}).protocolValid).toBe(false);
  expect(validate('exclusive',{...f,err:f.err+f.err.split('\r\n').find(l=>l.startsWith('anchor-overlap phase=child-set '))+'\r\n'}).protocolValid).toBe(false);
});
