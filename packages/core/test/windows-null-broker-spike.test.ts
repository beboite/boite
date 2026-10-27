import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import {createBrokerFixture, credentialHandleAbsent, brokerSource, classifyBroker, combineVerdicts, observeBrokerExpiry, runLocalContracts, type BrokerExpiryReceipt, type BrokerVerdict} from './windows-null-broker-spike.ts';
import {ExecutionProtections} from '../src/execution-protection.ts';

const bind = 'NB_BIND pid=10 parent=1 generation=root package=S-1-15-2-1-2-3 lpac=1 capabilities=1 registry=1 job=1 dup=1';
const end = 'NB_END error=0 active=0 owned=0 suspended=0 pending=0 delegations=0';
const identity = 'NB_IMAGE pid=10 sha=160ef9b82e2895ef48fa031cb1cf683a8b123febf7cf7d5590cd3104864424b3 exports=1 startup=1';
const denial = 'NB_PRIMITIVE pid=10 status=0xc0000022 opened=0 hostClosed=1 remoteClosed=1';
const trace = ['NB_EVENT number=1 pid=10 tid=11 code=3','NB_PROCESS_IMAGE pid=10 sha='+'a'.repeat(64)+' role=target identity=1',
  'NB_HANDLE pid=10 tid=0 kind=process action=own','NB_HANDLE pid=10 tid=11 kind=thread action=own',
  'NB_EVENT number=2 pid=10 tid=11 code=6','NB_EVENT number=3 pid=10 tid=11 code=1',
  'NB_EVENT number=4 pid=10 tid=11 code=5','NB_EXIT pid=10 code=0x00000000',
  'NB_HANDLE pid=10 tid=11 kind=thread action=close','NB_HANDLE pid=10 tid=0 kind=process action=close'];
const negativeEnd = end.replace('delegations=0','delegations=1');
const primitiveDelegate = 'NB_DELEGATE pid=10 sequence=1 api=create requested=0xc0100000 options=0x00000060 disposition=1 status=0xc0000022 opened=0 hostClosed=1 remoteClosed=1 valid=1';
const input='NB_INPUT pid=10 api=create attributes=0x00000040 security=0 qos=0 extra=0 fileAttributes=0x00000000 share=3';
const negative = [bind, identity, ...trace.slice(0,6), input, primitiveDelegate, denial, ...trace.slice(6), negativeEnd].join('\n');
const pointerRows = ['readonly-handle', 'readonly-iosb', 'boundary'].flatMap(name => ['off', 'on'].map(transport =>
  `NB_POINTER pid=10 transport=${transport} name=${name} status=0xc0000005 unchanged=1 handles=0 opened=0`));

describe('Null broker evidence admission', () => {
  test('a complete negative primitive is distinct from incomplete setup', () => {
    expect(classifyBroker(negative, 'primitive')).toEqual({kind: 'negative', experimentComplete: true, productionAccepted: false});
    for (const line of [bind, identity, input, primitiveDelegate, denial, negativeEnd]) expect(classifyBroker(negative.replace(line, ''), 'primitive').experimentComplete).toBe(false);
  });
  test('duplicate or inconsistent authority, startup and cleanup never complete', () => {
    for (const suffix of [bind, identity, denial, end, 'NB_UNKNOWN ok=1']) expect(classifyBroker(`${negative}\n${suffix}`, 'primitive').experimentComplete).toBe(false);
    for (const [a, b] of [['job=1','job=0'], ['dup=1','dup=0'], ['lpac=1','lpac=0'], ['capabilities=1','capabilities=2'], ['startup=1','startup=0'], ['active=0','active=1'], ['suspended=0','suspended=1'], ['opened=0','opened=1']]) {
      expect(classifyBroker(negative.replace(a!, b!), 'primitive').experimentComplete).toBe(false);
    }
  });
  test('kernel creation, image, exit and exact handle ownership must reconcile', () => {
    for (const line of trace) expect(classifyBroker(negative.replace(line,''),'primitive').experimentComplete).toBe(false);
    expect(classifyBroker(negative.replace('number=2','number=1'),'primitive').experimentComplete).toBe(false);
    expect(classifyBroker(negative.replace('action=close','action=own'),'primitive').experimentComplete).toBe(false);
    expect(classifyBroker(negative.replace(primitiveDelegate,'').replace('delegations=1','delegations=0'),'primitive').experimentComplete).toBe(false);
  });
  test('terminating siblings require a parked trap, continued exit and the actual replay', () => {
    const parked = [
      'NB_EVENT number=4 pid=10 tid=12 code=2', 'NB_HANDLE pid=10 tid=12 kind=thread action=own',
      'NB_EVENT number=5 pid=10 tid=11 code=1',
      'NB_SUSPEND pid=10 tid=12 owner=11 previous=4294967295 error=5 wait=258 exitKnown=1 exitCode=259 status=0xc000004b',
      'NB_SUSPEND pid=10 tid=11 owner=11 previous=0 error=0 wait=258 exitKnown=0 exitCode=0 status=0x00000000',
      'NB_PARK pid=10 tid=11 waiting=1', 'NB_EVENT number=6 pid=10 tid=12 code=4',
      'NB_HANDLE pid=10 tid=12 kind=thread action=close', 'NB_RETIRED pid=10 tid=12 continued=1',
      'NB_RESUME pid=10 tid=11 owner=11 previous=1', 'NB_EVENT number=7 pid=10 tid=11 code=1', 'NB_REPLAY pid=10 tid=11',
    ];
    const text = [bind,identity,...trace.slice(0,6),...parked,input,primitiveDelegate,denial,...trace.slice(6).map(r=>r.replace('number=4','number=8')),negativeEnd].join('\n');
    expect(classifyBroker(text,'primitive').kind).toBe('negative');
    for (const row of parked) expect(classifyBroker(text.replace(row,''),'primitive').experimentComplete).toBe(false);
    for (const [before,after] of [['0xc000004b','0xc0000022'],['NB_PARK pid=10 tid=11 waiting=1','NB_PARK pid=10 tid=11 waiting=0'],['continued=1','continued=0']]) {
      expect(classifyBroker(text.replace(before!,after!),'primitive').experimentComplete).toBe(false);
    }
    const exit=parked.slice(6,9).join('\n'), wake=parked[9]!;
    expect(classifyBroker(text.replace(exit,'').replace(wake,`${wake}\n${exit}`),'primitive').experimentComplete).toBe(false);
    expect(classifyBroker(text.replace(parked[11]!,'').replace(parked[10]!,`${parked[11]}\n${parked[10]}`),'primitive').experimentComplete).toBe(false);
    expect(classifyBroker(text.replace(parked[11]!,'').replace(primitiveDelegate,`${primitiveDelegate}\n${parked[11]}`),'primitive').experimentComplete).toBe(false);
    const owner = parked[4]!, close = parked[7]!, park = parked[5]!;
    const mutations = (capture: string) => [
      capture.replace(owner,owner.replace(' status=0x00000000','').replace('error=0','error=5')),
      capture.replace(owner,owner.replace('error=0','error=5')),
      capture.replace(owner,owner.replace(' status=0x00000000','')),
      capture.replace(owner,owner.replace(' error=0','')),
      capture.replace(park,'').replace(parked[8]!,`${park}\n${parked[8]}`),
      capture.replace(close,'').replace(/NB_EVENT number=\d+ pid=10 tid=12 code=4/,match=>`${close}\n${match}`),
      capture.replace(owner,`NB_EVENT number=0 pid=10 tid=11 code=1\n${owner}`).replace(/NB_EVENT number=\d+/g,((number=0)=>()=>`NB_EVENT number=${++number}`)()),
    ];
    let number = 0;
    const complete = positiveCapture().replace(/NB_SUSPEND pid=10 tid=12 owner=11[\s\S]*?NB_HANDLE pid=10 tid=12 kind=thread action=close/,parked.slice(2).join('\n'))
      .replace(/NB_EVENT number=\d+/g,()=>`NB_EVENT number=${++number}`);
    expect(classifyBroker(complete,'native',false,nativeImages).kind).toBe('positive');
    expect([
      ...mutations(text).map(capture=>classifyBroker(capture,'primitive').experimentComplete),
      ...mutations(complete).map(capture=>classifyBroker(capture,'native',false,nativeImages).experimentComplete),
    ]).toEqual(Array(14).fill(false));
  });
  test('timeouts, unsupported images and setup failures are never negative proof', () => {
    for (const kind of ['timeout', 'unsupported', 'setup'] as const) expect(classifyBroker(`${negative}\nNB_FAILURE kind=${kind} code=50`, 'primitive').kind).toBe(kind);
    expect(classifyBroker(negative, 'primitive', true).kind).toBe('timeout');
  });
  test('pointer controls require both transports, unchanged sentinels, no leak and valid output', () => {
    const pass = 'NB_PASSTHROUGH pid=10 tid=11 api=create reason=outputs opened=0';
    const paired = pointerRows.flatMap((row,i)=>i%2 ? [input,pass,row] : [row]);
    // The direct syscall rejects this IOSB boundary after its LPAC access check.
    const text = [bind, identity, ...trace.slice(0,6), ...paired, ...traffic(10,1), 'NB_POINTER pid=10 transport=on name=writable status=0x00000000 unchanged=0 handles=0 opened=1', ...trace.slice(6), end.replace('delegations=0','delegations=1')].join('\n')
      .replaceAll('name=boundary status=0xc0000005','name=boundary status=0xc0000022');
    expect(classifyBroker(text, 'pointers').kind).toBe('positive');
    for (const row of pointerRows) {
      const line = row.replace('name=boundary status=0xc0000005','name=boundary status=0xc0000022');
      expect(classifyBroker(text.replace(line, ''), 'pointers').experimentComplete).toBe(false);
    }
    for (const [a,b] of [['handles=0','handles=1'], ['unchanged=1','unchanged=0'], ['opened=0','opened=1']]) expect(classifyBroker(text.replace(a!,b!), 'pointers').experimentComplete).toBe(false);
    expect(classifyBroker(`${text}\n${pointerRows[0]}`, 'pointers').experimentComplete).toBe(false);
    expect(classifyBroker(text.replace('transport=on name=boundary status=0xc0000022','transport=on name=boundary status=0xc0000005'),'pointers').experimentComplete).toBe(false);
    for (const replacement of ['',pass.replace('pid=10','pid=99'),pass.replace('opened=0','opened=1'),pass.replace('tid=11','tid=0')]) {
      expect(classifyBroker(text.replace(pass,replacement),'pointers').experimentComplete).toBe(false);
    }
    expect(classifyBroker(`${text}\n${pass}`,'pointers').experimentComplete).toBe(false);
    const writable='NB_POINTER pid=10 transport=on name=writable';
    expect(classifyBroker(text.replace(pass,'').replace(writable,`${pass}\n${writable}`),'pointers').experimentComplete).toBe(false);
    const closed=trace.slice(6).join('\n'), first=pointerRows[0]!;
    expect(classifyBroker(text.replace(closed,'').replace(first,`${closed}\n${first}`),'pointers').experimentComplete).toBe(false);
    const threadClosed='NB_HANDLE pid=10 tid=11 kind=thread action=close';
    expect(classifyBroker(text.replace(threadClosed,'').replace(pass,`${threadClosed}\n${pass}`),'pointers').experimentComplete).toBe(false);
    const creation=trace[0]!, attempts=paired.join('\n').replaceAll('name=boundary status=0xc0000005','name=boundary status=0xc0000022');
    expect(classifyBroker(text.replace(attempts,'').replace(creation,`${attempts}\n${creation}`),'pointers').experimentComplete).toBe(false);
  });
  test('compiler disagreement and absent compilers do not complete the experiment', () => {
    const verdict = (kind: BrokerVerdict['kind']): BrokerVerdict => ({kind, experimentComplete: kind === 'positive' || kind === 'negative', productionAccepted: false});
    expect(combineVerdicts([verdict('negative'), verdict('positive')])).toBe(false);
    expect(combineVerdicts([verdict('negative')])).toBe(false);
    expect(combineVerdicts([verdict('negative'), verdict('negative')])).toBe(true);
    expect(combineVerdicts([verdict('positive'), verdict('incomplete')])).toBe(false);
  });
});

test('shared native scheduler and output-span contracts: queued trap B cannot suspend A', async () => {
  const result = await runLocalContracts();
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('NB_LOCAL queued-replay=1 balanced=1 progress=2 pointer-contracts=1');
  expect(result.out).toContain('qos-snapshot=1');
  expect(result.out).toContain('create-abi=1');
  expect(result.out).toContain('credential-snapshot=1');
  expect(result.out).toContain('breakaway-dispatch=1');
  expect(result.out).toContain('terminating-replay=1');
});

test('source generation pins the production reference and rejects a second replacement', () => {
  const original = readFileSync(new URL('../src/platform/windows/protected-tool.c', import.meta.url), 'utf8');
  const generated = brokerSource(original);
  expect(generated).toContain('DEBUG_PROCESS');
  expect(generated).toContain('TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &child_token');
  expect(() => brokerSource(original.replace('CREATE_NEW_CONSOLE', '0'))).toThrow('provenance');
});

const nativeSha = 'b'.repeat(64), bunSha = 'a'.repeat(64);
const credential='436', nativeImages={root:nativeSha,native:nativeSha,credential};
const expectedImages = {root: bunSha, native: nativeSha,credential};
const snapshotRow=(pid:number)=>`NB_CREDENTIAL pid=${pid} candidate=${credential} status=0x00000000 bytes=96 entries=2 absent=1 control=1 controlHandle=20`;
function traffic(pid: number, count: number, start = 0): string[] {
  return Array.from({length: count}, (_, i) => {
    const sequence = start + i + 1;
    return [input.replace('pid=10',`pid=${pid}`), `NB_MEASUREMENT pid=${pid} sequence=${sequence} same=0x00000000 different=0xc00001ac previous=${Number(i > 0)} ok=1`,
      `NB_DELEGATE pid=${pid} sequence=${sequence} api=create requested=0xc0100000 options=0x00000060 disposition=1 status=0x00000000 information=1 opened=1 hostClosed=1 remoteClosed=1 valid=1 granted=0x0012019f mode=0x00000020 type=2 device=21`].join('\n');
  });
}
function fullNative(pid: number): string[] {
  const rows: string[] = [];
  for (let api=0; api<3; api++) for (let access=0; access<3; access++) {
    const grant = access===1 ? api===0 ? '0x00120196' : '0x00120116' : access===0 ? '0x00120089' : '0x0012019f';
    rows.push(`NB_OPEN pid=${pid} api=${api} access=${access} async=0 disposition=1 status=0x00000000 statusKnown=1 win32Error=0 type=2 device=21 granted=${grant} mode=0x00000020 eof=${access===1?0:2} written=${access===0?0:8192} ok=1`);
  }
  for (let async=0; async<2; async++) rows.push(`NB_MODE pid=${pid} async=${async} status=0x00000000 mode=${async?'0x00000000':'0x00000020'} granted=0x0012019f ok=1`);
  rows.push(`NB_OBJECT pid=${pid} same=0x00000000 different=0xc00001ac ok=1`);
  const errors: Record<string, number> = {ambient:5,excluded:5,hostfile:5,credential:0,hostprocess:5,direct:0xc0000022,acl:0xc00000bb,'forged-path':0xc0000022,breakaway:5,network:10013};
  for (const [name,error] of Object.entries(errors)) rows.push(`NB_DENY pid=${pid} name=${name} denied=1 error=${error}${name==='credential'?' proof=snapshot':''}`);
  rows.push(snapshotRow(pid));
  for (const name of ['redirection','two-threads','control-handles']) rows.push(`NB_CHECK pid=${pid} name=${name} ok=1`);
  return rows;
}
function positiveCapture(bun=false): string {
  const pids=bun?[10,20,30,40]:[10,20], rows: string[]=[];
  let number=0;
  const event=(pid:number,code:number,tid=pid+1)=>rows.push(`NB_EVENT number=${++number} pid=${pid} tid=${tid} code=${code}`);
  for (const pid of pids) {
    event(pid,3);
    rows.push(bind.replace('pid=10 parent=1 generation=root',`pid=${pid} parent=${pid===10?1:10} generation=${pid===10?'root':'child'}`),
      identity.replace('pid=10',`pid=${pid}`),`NB_PROCESS_IMAGE pid=${pid} sha=${bun&&pid!==40?bunSha:nativeSha} role=target identity=1`,
      `NB_HANDLE pid=${pid} tid=0 kind=process action=own`,`NB_HANDLE pid=${pid} tid=${pid+1} kind=thread action=own`);
    event(pid,6); event(pid,1);
  }
  event(10,2,12); rows.push('NB_HANDLE pid=10 tid=12 kind=thread action=own');
  rows.push('NB_SUSPEND pid=10 tid=12 owner=11 previous=0','NB_DEFER pid=10 tid=12 owner=11','NB_RESUME pid=10 tid=12 owner=11 previous=1');
  event(10,4,12);rows.push('NB_HANDLE pid=10 tid=12 kind=thread action=close');
  if (bun) rows.push(...traffic(10,1),...traffic(40,28,1),...fullNative(40),snapshotRow(10),'NB_BUN pid=10 ignore=1 pipe=1 argv=1 denials=1 network=1');
  else rows.push(...traffic(10,28),...traffic(20,28,28),...fullNative(10),...fullNative(20),'NB_CHECK pid=10 name=ordinary-child ok=1');
  for (const pid of [...pids].reverse()) {
    event(pid,5);rows.push(`NB_EXIT pid=${pid} code=0x00000000`,`NB_HANDLE pid=${pid} tid=${pid+1} kind=thread action=close`,`NB_HANDLE pid=${pid} tid=0 kind=process action=close`);
  }
  rows.push(end.replace('delegations=0',`delegations=${bun?29:56}`));return rows.join('\n');
}

test('complete native capture preserves the observed Win32 WRITE attributes',()=>{
  const capture=positiveCapture();
  expect(classifyBroker(capture,'native',false,nativeImages).kind).toBe('positive');
  expect(classifyBroker(capture.replace('statusKnown=1','statusKnown=0'),'native',false,nativeImages).experimentComplete).toBe(false);
  expect(classifyBroker(capture.replace('api=0 access=1 async=0 disposition=1 status=0x00000000 statusKnown=1 win32Error=0 type=2 device=21 granted=0x00120196','api=0 access=1 async=0 disposition=1 status=0x00000000 statusKnown=1 win32Error=0 type=2 device=21 granted=0x00120116'),'native',false,nativeImages).experimentComplete).toBe(false);
});

test('a credential denial needs a complete snapshot tied to the captured parent handle',()=>{
  const capture=positiveCapture().split('\n').filter(line=>!line.startsWith('NB_CREDENTIAL')).join('\n');
  expect(classifyBroker(capture,'native',false,nativeImages).experimentComplete).toBe(false);
  const complete=positiveCapture(), proof=snapshotRow(10);
  expect(classifyBroker(complete,'native',false,nativeImages).kind).toBe('positive');
  for(const [a,b] of [['candidate=436','candidate=0'],['candidate=436','candidate=440'],['status=0x00000000','status=0xc0000004'],
    ['bytes=96','bytes=95'],['entries=2','entries=0'],['absent=1','absent=0'],['control=1','control=0'],['controlHandle=20','controlHandle=436']]) {
    expect(classifyBroker(complete.replace(proof,proof.replace(a!,b!)),'native',false,nativeImages).experimentComplete).toBe(false);
  }
  expect(classifyBroker(complete,'native',false,{...nativeImages,credential:undefined}).experimentComplete).toBe(false);
  expect(classifyBroker(complete.replace(proof,`${proof}\n${proof}`),'native',false,nativeImages).experimentComplete).toBe(false);
  const late=complete.replace(proof,'').replace('NB_EXIT pid=10 code=0x00000000',`NB_EXIT pid=10 code=0x00000000\n${proof}`);
  expect(classifyBroker(late,'native',false,nativeImages).experimentComplete).toBe(false);
  const high='1152921504606847412';
  expect(classifyBroker(complete.replaceAll('candidate=436','candidate='+high),'native',false,{...nativeImages,credential:high}).kind).toBe('positive');
});

test('credential snapshots reject a present handle, truncation and an absent positive control',()=>{
  const bytes=Buffer.alloc(96), candidate=0x10000000000001b4n, control=20n;
  bytes.writeBigUInt64LE(2n);bytes.writeBigUInt64LE(control,16);bytes.writeBigUInt64LE(24n,56);
  expect(credentialHandleAbsent(bytes,96,candidate,control)).toBe(true);
  expect(credentialHandleAbsent(bytes,95,candidate,control)).toBe(false);
  expect(credentialHandleAbsent(bytes,96,candidate,28n)).toBe(false);
  expect(credentialHandleAbsent(bytes,96,control,control)).toBe(false);
  expect(credentialHandleAbsent(bytes,96,0n,control)).toBe(false);
  bytes.writeBigUInt64LE(candidate,56);
  expect(credentialHandleAbsent(bytes,96,candidate,control)).toBe(false);
  bytes.writeBigUInt64LE(0xffffffffffffffffn);
  expect(credentialHandleAbsent(bytes,96,candidate,control)).toBe(false);
  bytes.writeBigUInt64LE(0n);
  expect(credentialHandleAbsent(bytes,96,candidate,control)).toBe(false);
});

test('native admission reconciles every delegation, measurement and suspension',()=>{
  const capture=positiveCapture();
  const uniform=capture;
  const without=(prefix:string)=>uniform.split('\n').filter(line=>!line.startsWith(prefix)).join('\n');
  for (const prefix of ['NB_DELEGATE','NB_MEASUREMENT','NB_RESUME']) expect(classifyBroker(without(prefix),'native',false,nativeImages).experimentComplete).toBe(false);
  for (const [a,b] of [['previous=1 ok=1','previous=1 ok=0'],['hostClosed=1','hostClosed=0'],['owner=11 previous=1','owner=12 previous=1'],['sequence=2 ','sequence=1 ']]) expect(classifyBroker(uniform.replace(a!,b!),'native',false,nativeImages).experimentComplete).toBe(false);
  const suspension='NB_SUSPEND pid=10 tid=12 owner=11 previous=0';
  expect(classifyBroker(capture.replace(suspension,suspension+' status=0x00000000'),'native',false,nativeImages).kind).toBe('positive');
  expect(classifyBroker(capture.replace(suspension,suspension+' status=0xc000004b'),'native',false,nativeImages).experimentComplete).toBe(false);
  const qos='NB_QOS pid=10 length=12 level=2 tracking=0 effective=1 copied=1';
  const withInput=input.replace('qos=0','qos=1');
  const withQos=capture.replace(input,`${withInput}\n${qos}`);
  expect(classifyBroker(withQos,'native',false,nativeImages).kind).toBe('positive');
  for(const [a,b] of [['length=12','length=11'],['level=2','level=4'],['tracking=0','tracking=2'],['effective=1','effective=2'],['copied=1','copied=0'],['NB_QOS pid=10','NB_QOS pid=99']]) {
    expect(classifyBroker(withQos.replace(a!,b!),'native',false,nativeImages).experimentComplete).toBe(false);
  }
  expect(classifyBroker(withQos.replace(withInput,''),'native',false,nativeImages).experimentComplete).toBe(false);
  expect(classifyBroker(withQos.replace(qos,''),'native',false,nativeImages).experimentComplete).toBe(false);
  expect(classifyBroker(withQos.replace(qos,`${qos}\n${qos}`),'native',false,nativeImages).experimentComplete).toBe(false);
  expect(classifyBroker(withQos.replace(`${withInput}\n${qos}`,''),'native',false,nativeImages).experimentComplete).toBe(false);
  expect(classifyBroker(withQos.replace(withInput,withInput.replace('pid=10','pid=20')),'native',false,nativeImages).experimentComplete).toBe(false);
});

test('Bun evidence binds its exact runtime, ordinary children and complete native child proof',()=>{
  const capture=positiveCapture(true);
  expect(classifyBroker(capture,'bun',false,expectedImages).kind).toBe('positive');
  for (const prefix of ['NB_OPEN','NB_DENY','NB_CREDENTIAL','NB_CHECK','NB_DELEGATE','NB_MEASUREMENT']) {
    const partial=capture.split('\n').filter(line=>!line.startsWith(prefix)).join('\n');
    expect(classifyBroker(partial,'bun',false,expectedImages).experimentComplete).toBe(false);
  }
  for (const [a,b] of [['NB_BUN pid=10','NB_BUN pid=20'],['sha='+nativeSha,'sha='+bunSha],['parent=10 generation=child','parent=20 generation=child']]) expect(classifyBroker(capture.replace(a!,b!),'bun',false,expectedImages).experimentComplete).toBe(false);
});


test('setup ACL propagation cannot reach synthetic host controls or the process journal', () => {
  const scratch = mkdtempSync(join(tmpdir(),'boite-null-layout-'));
  try {
    const journal = join(scratch,'journal.db'); writeFileSync(journal,'synthetic control state');
    const fixture = createBrokerFixture(scratch);
    const inside = (path: string) => {const part=relative(fixture.boundary,path);return !isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep);};
    for (const path of [fixture.host,fixture.excluded,journal]) expect(inside(path)).toBe(false);
    for (const path of [fixture.project,fixture.runtime,fixture.home,fixture.ambient]) expect(inside(path)).toBe(true);
    expect(readFileSync(join(fixture.host,'ordinary.txt'),'utf8')).toBe('SYNTHETIC_HOST');
    expect(readFileSync(fixture.excluded,'utf8')).toBe('SYNTHETIC_EXCLUDED');
    expect(readFileSync(journal,'utf8')).toBe('synthetic control state');
    expect(readdirSync(fixture.boundary).sort()).toEqual(['home','runtime','view']);
  } finally {rmSync(scratch,{recursive:true,force:true});}
});


test('an authenticated console is traced but cannot stand in for a workload child',()=>{
  const consoleSha='c'.repeat(64), expected={root:nativeSha,native:nativeSha,console:consoleSha,credential};
  const capture=positiveCapture();
  const lines=capture.split('\n');
  // Creation while the root is live, then console exit only after root exit/drain.
  const insert=lines.findIndex(line=>line.includes('pid=10 tid=11 code=6'));
  lines.splice(insert,0,'NB_EVENT pid=50 tid=51 code=3',
    bind.replace('pid=10 parent=1 generation=root','pid=50 parent=10 generation=child'),
    identity.replace('pid=10','pid=50'),`NB_PROCESS_IMAGE pid=50 sha=${consoleSha} role=console identity=1`,
    'NB_HANDLE pid=50 tid=0 kind=process action=own','NB_HANDLE pid=50 tid=51 kind=thread action=own',
    'NB_EVENT pid=50 tid=51 code=6','NB_EVENT pid=50 tid=51 code=1');
  lines.splice(-1,0,'NB_DRAIN pid=10 code=125 ok=1','NB_EVENT pid=50 tid=51 code=5','NB_EXIT pid=50 code=0x0000007d',
    'NB_HANDLE pid=50 tid=51 kind=thread action=close','NB_HANDLE pid=50 tid=0 kind=process action=close');
  let event=0;const actual=lines.map(line=>line.startsWith('NB_EVENT')?line.replace(/^NB_EVENT(?: number=\d+)? /,`NB_EVENT number=${++event} `):line).join('\n');
  expect(classifyBroker(actual,'native',false,expected).kind).toBe('positive');
  for(const [a,b] of [[consoleSha,'d'.repeat(64)],['role=console identity=1','role=console identity=0'],['pid=50 parent=10','pid=50 parent=50'],['pid=50 code=0x0000007d','pid=50 code=0x00000001']]) {
    expect(classifyBroker(actual.replace(a!,b!),'native',false,expected).experimentComplete).toBe(false);
  }
  expect(classifyBroker(actual,'native').experimentComplete).toBe(false);
  expect(classifyBroker(actual.replace('NB_DRAIN pid=10 code=125 ok=1',''),'native',false,expected).experimentComplete).toBe(false);
  expect(classifyBroker(actual.replace(`sha=${nativeSha} role=target`,`sha=${consoleSha} role=console`),'native',false,expected).experimentComplete).toBe(false);
});

test('expiry observation awaits automatic session cleanup and rejects an already dead scope',async()=>{
  const root=mkdtempSync(join(tmpdir(),'boite-expiry-observer-'));
  for(const premature of [false,true]) {
    const receipt:BrokerExpiryReceipt={stopRequestedAt:null,liveAtStop:false,closedAt:null};
    let live=0;
    const stopping=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
    const leases=new ExecutionProtections({async open(){return {launch(){throw new Error('unused');},flush(){},close(){receipt.closedAt=Date.now();}};}},
      async()=>({code:0,stdout:'',stderr:''}),async()=>{
        receipt.stopRequestedAt=Date.now();receipt.liveAtStop=live>0;live=0;stopping.resolve();await release.promise;
      },()=>live);
    try {
      const expiresAt=Date.now()+100,readyAt=Date.now();
      await leases.install('expiry',{scope:{kind:'job',id:'expiry',associationId:'synthetic',grantRevision:1},checkout:root,credentialPaths:[],expiresAt},()=>{});
      live=premature?0:1;
      await stopping.promise; // Real automatic expiry has stopped the scope, close is still pending.
      let settled=false;
      const observed=observeBrokerExpiry(()=>live,receipt,readyAt,expiresAt,Date.now()+1000).then(value=>{settled=true;return value;});
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      expect(await observed).toBe(!premature);
      expect(receipt.stopRequestedAt!>=expiresAt).toBe(true);
    } finally {release.resolve();await leases.close();}
  }
  rmSync(root,{recursive:true,force:true});
});

test('a successful breakaway call must prove the child stayed in the captured private job',()=>{
  const original=positiveCapture(true).split('\n');
  const where=original.findIndex(line=>line==='NB_DENY pid=40 name=breakaway denied=1 error=5');
  original.splice(where,1,
    'NB_EVENT pid=50 tid=51 code=3',bind.replace('pid=10 parent=1 generation=root','pid=50 parent=40 generation=child'),
    identity.replace('pid=10','pid=50'),`NB_PROCESS_IMAGE pid=50 sha=${nativeSha} role=target identity=1`,
    'NB_HANDLE pid=50 tid=0 kind=process action=own','NB_HANDLE pid=50 tid=51 kind=thread action=own',
    'NB_EVENT pid=50 tid=51 code=6','NB_EVENT pid=50 tid=51 code=1','NB_CHECK pid=50 name=breakaway-child ok=1',
    'NB_EVENT pid=50 tid=51 code=5','NB_EXIT pid=50 code=0x00000000',
    'NB_HANDLE pid=50 tid=51 kind=thread action=close','NB_HANDLE pid=50 tid=0 kind=process action=close',
    'NB_BREAKAWAY pid=40 created=1 child=50 error=0 exit=0 waited=1 closed=1');
  let event=0;const capture=original.map(line=>line.startsWith('NB_EVENT')?line.replace(/^NB_EVENT(?: number=\d+)? /,`NB_EVENT number=${++event} `):line).join('\n');
  expect(classifyBroker(capture,'bun',false,expectedImages).kind).toBe('positive');
  for(const [a,b] of [['pid=50 parent=40','pid=50 parent=10'],['child=50','child=99'],['pid=50 code=0x00000000','pid=50 code=0x0000007d'],
    ['waited=1','waited=0'],['closed=1','closed=0'],['pid=50 name=breakaway-child ok=1','pid=50 name=breakaway-child ok=0']]) {
    expect(classifyBroker(capture.replace(a!,b!),'bun',false,expectedImages).experimentComplete).toBe(false);
  }
  const receipt='NB_BREAKAWAY pid=40 created=1 child=50 error=0 exit=0 waited=1 closed=1';
  expect(classifyBroker(capture.replace(receipt,''),'bun',false,expectedImages).experimentComplete).toBe(false);
  expect(classifyBroker(capture.replace(receipt,receipt+'\n'+receipt),'bun',false,expectedImages).experimentComplete).toBe(false);
  const check='NB_CHECK pid=50 name=breakaway-child ok=1';
  const early=capture.replace(check,'').replace('NB_EVENT number=1 ',check+'\nNB_EVENT number=1 ');
  expect(classifyBroker(early,'bun',false,expectedImages).experimentComplete).toBe(false);
  expect(classifyBroker(capture.replace(receipt,'').replace('NB_EXIT pid=40 code=0x00000000','NB_EXIT pid=40 code=0x00000000\n'+receipt),'bun',false,expectedImages).experimentComplete).toBe(false);
  expect(classifyBroker(capture.replace(check,'').replace('NB_EXIT pid=50 code=0x00000000',check+'\nNB_EXIT pid=50 code=0x00000000'),'bun',false,expectedImages).experimentComplete).toBe(false);
  expect(classifyBroker(capture.replace(receipt,'').replace('NB_EXIT pid=40 code=0x00000000',receipt+'\nNB_EXIT pid=40 code=0x00000000'),'bun',false,expectedImages).experimentComplete).toBe(false);
  const binding=bind.replace('pid=10 parent=1 generation=root','pid=50 parent=40 generation=child');
  for(const [a,b] of [['job=1','job=0'],['lpac=1','lpac=0'],['capabilities=1','capabilities=2']]) {
    expect(classifyBroker(capture.replace(binding,binding.replace(a!,b!)),'bun',false,expectedImages).experimentComplete).toBe(false);
  }
  expect(classifyBroker(capture.replace(`pid=50 sha=${nativeSha} role=target`,`pid=50 sha=${bunSha} role=target`),'bun',false,expectedImages).experimentComplete).toBe(false);
});

test('expiry evidence rejects cleanup after its deadline and non-causal stop receipts',async()=>{
  const now=Date.now(),receipt:BrokerExpiryReceipt={stopRequestedAt:now-40,liveAtStop:true,closedAt:now};
  expect(await observeBrokerExpiry(()=>0,receipt,now-100,now-50,now-10)).toBe(false);
  for(const invalid of [{...receipt,stopRequestedAt:null},{...receipt,stopRequestedAt:now-60},{...receipt,liveAtStop:false}]) {
    expect(await observeBrokerExpiry(()=>0,invalid,now-100,now-50,now+1000)).toBe(false);
  }
  expect(await observeBrokerExpiry(()=>0,{...receipt,closedAt:null},now-100,now-50,now-10)).toBe(false);
  expect(await observeBrokerExpiry(()=>0,receipt,null,now-50,now+1000)).toBe(false);
});
