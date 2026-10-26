import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {brokerSource, classifyBroker, combineVerdicts, runLocalContracts, type BrokerVerdict} from './windows-null-broker-spike.ts';

const bind = 'NB_BIND pid=10 parent=1 generation=root package=S-1-15-2-1-2-3 lpac=1 capabilities=1 registry=1 job=1 dup=1';
const end = 'NB_END error=0 active=0 owned=0 suspended=0 pending=0 delegations=0';
const identity = 'NB_IMAGE pid=10 sha=160ef9b82e2895ef48fa031cb1cf683a8b123febf7cf7d5590cd3104864424b3 exports=1 startup=1';
const denial = 'NB_PRIMITIVE pid=10 status=0xc0000022 opened=0 hostClosed=1 remoteClosed=1';
const trace = ['NB_EVENT number=1 pid=10 tid=11 code=3','NB_PROCESS_IMAGE pid=10 sha='+'a'.repeat(64),
  'NB_HANDLE pid=10 tid=0 kind=process action=own','NB_HANDLE pid=10 tid=11 kind=thread action=own',
  'NB_EVENT number=2 pid=10 tid=11 code=6','NB_EVENT number=3 pid=10 tid=11 code=1',
  'NB_EVENT number=4 pid=10 tid=11 code=5','NB_EXIT pid=10 code=0x00000000',
  'NB_HANDLE pid=10 tid=11 kind=thread action=close','NB_HANDLE pid=10 tid=0 kind=process action=close'];
const negativeEnd = end.replace('delegations=0','delegations=1');
const primitiveDelegate = 'NB_DELEGATE pid=10 sequence=1 api=create requested=0xc0100000 options=0x00000060 disposition=1 status=0xc0000022 opened=0 hostClosed=1 remoteClosed=1 valid=1';
const negative = [bind, identity, primitiveDelegate, denial, ...trace, negativeEnd].join('\n');
const pointerRows = ['readonly-handle', 'readonly-iosb', 'boundary'].flatMap(name => ['off', 'on'].map(transport =>
  `NB_POINTER pid=10 transport=${transport} name=${name} status=0xc0000005 unchanged=1 handles=0 opened=0`));

describe('Null broker evidence admission', () => {
  test('a complete negative primitive is distinct from incomplete setup', () => {
    expect(classifyBroker(negative, 'primitive')).toEqual({kind: 'negative', experimentComplete: true, productionAccepted: false});
    for (const line of [bind, identity, primitiveDelegate, denial, negativeEnd]) expect(classifyBroker(negative.replace(line, ''), 'primitive').experimentComplete).toBe(false);
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
  test('timeouts, unsupported images and setup failures are never negative proof', () => {
    for (const kind of ['timeout', 'unsupported', 'setup'] as const) expect(classifyBroker(`${negative}\nNB_FAILURE kind=${kind} code=50`, 'primitive').kind).toBe(kind);
    expect(classifyBroker(negative, 'primitive', true).kind).toBe('timeout');
  });
  test('pointer controls require both transports, unchanged sentinels, no leak and valid output', () => {
    const failed = Array.from({length:3}, (_,i)=>`NB_DELEGATE pid=10 sequence=${i+1} api=create requested=0xc0100000 options=0x00000060 disposition=1 status=0xc0000005 opened=0 hostClosed=1 remoteClosed=1 valid=0`);
    const text = [bind, identity, ...trace, ...pointerRows, ...failed, ...traffic(10,1,3), 'NB_POINTER pid=10 transport=on name=writable status=0x00000000 unchanged=0 handles=0 opened=1', end.replace('delegations=0','delegations=4')].join('\n');
    expect(classifyBroker(text, 'pointers').kind).toBe('positive');
    for (const line of pointerRows) expect(classifyBroker(text.replace(line, ''), 'pointers').experimentComplete).toBe(false);
    for (const [a,b] of [['handles=0','handles=1'], ['unchanged=1','unchanged=0'], ['opened=0','opened=1']]) expect(classifyBroker(text.replace(a!,b!), 'pointers').experimentComplete).toBe(false);
    expect(classifyBroker(`${text}\n${pointerRows[0]}`, 'pointers').experimentComplete).toBe(false);
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
});

test('source generation pins the production reference and rejects a second replacement', () => {
  const original = readFileSync(new URL('../src/platform/windows/protected-tool.c', import.meta.url), 'utf8');
  const generated = brokerSource(original);
  expect(generated).toContain('DEBUG_PROCESS');
  expect(generated).toContain('TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &child_token');
  expect(() => brokerSource(original.replace('CREATE_NEW_CONSOLE', '0'))).toThrow('provenance');
});

const nativeSha = 'b'.repeat(64), bunSha = 'a'.repeat(64);
const expectedImages = {root: bunSha, native: nativeSha};
function traffic(pid: number, count: number, start = 0): string[] {
  return Array.from({length: count}, (_, i) => {
    const sequence = start + i + 1;
    return [`NB_MEASUREMENT pid=${pid} sequence=${sequence} same=0x00000000 different=0xc00001ac previous=${Number(i > 0)} ok=1`,
      `NB_DELEGATE pid=${pid} sequence=${sequence} api=create requested=0xc0100000 options=0x00000060 disposition=1 status=0x00000000 information=1 opened=1 hostClosed=1 remoteClosed=1 valid=1 granted=0x0012019f mode=0x00000020 type=2 device=21`].join('\n');
  });
}
function fullNative(pid: number): string[] {
  const rows: string[] = [];
  for (let api=0; api<3; api++) for (let access=0; access<3; access++) {
    const grant = access===1 ? api===0 ? '0x00120196' : '0x00120116' : access===0 ? '0x00120089' : '0x0012019f';
    rows.push(`NB_OPEN pid=${pid} api=${api} access=${access} async=0 disposition=1 status=0x00000000 type=2 device=21 granted=${grant} mode=0x00000020 eof=${access===1?0:2} written=${access===0?0:8192} ok=1`);
  }
  for (let async=0; async<2; async++) rows.push(`NB_MODE pid=${pid} async=${async} status=0x00000000 mode=${async?'0x00000000':'0x00000020'} granted=0x0012019f ok=1`);
  rows.push(`NB_OBJECT pid=${pid} same=0x00000000 different=0xc00001ac ok=1`);
  const errors: Record<string, number> = {ambient:5,excluded:5,hostfile:5,credential:6,hostprocess:5,direct:0xc0000022,acl:0xc00000bb,'forged-path':0xc0000022,breakaway:5,network:10013};
  for (const [name,error] of Object.entries(errors)) rows.push(`NB_DENY pid=${pid} name=${name} denied=1 error=${error}`);
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
      identity.replace('pid=10',`pid=${pid}`),`NB_PROCESS_IMAGE pid=${pid} sha=${bun&&pid!==40?bunSha:nativeSha}`,
      `NB_HANDLE pid=${pid} tid=0 kind=process action=own`,`NB_HANDLE pid=${pid} tid=${pid+1} kind=thread action=own`);
    event(pid,6); event(pid,1);
  }
  event(10,2,12); rows.push('NB_HANDLE pid=10 tid=12 kind=thread action=own');
  rows.push('NB_SUSPEND pid=10 tid=12 owner=11 previous=0','NB_DEFER pid=10 tid=12 owner=11','NB_RESUME pid=10 tid=12 owner=11 previous=1');
  event(10,4,12);rows.push('NB_HANDLE pid=10 tid=12 kind=thread action=close');
  if (bun) rows.push(...traffic(10,1),...traffic(40,28,1),...fullNative(40),'NB_BUN pid=10 ignore=1 pipe=1 argv=1 denials=1 network=1');
  else rows.push(...traffic(10,28),...traffic(20,28,28),...fullNative(10),...fullNative(20),'NB_CHECK pid=10 name=ordinary-child ok=1');
  for (const pid of [...pids].reverse()) {
    event(pid,5);rows.push(`NB_EXIT pid=${pid} code=0x00000000`,`NB_HANDLE pid=${pid} tid=${pid+1} kind=thread action=close`,`NB_HANDLE pid=${pid} tid=0 kind=process action=close`);
  }
  rows.push(end.replace('delegations=0',`delegations=${bun?29:56}`));return rows.join('\n');
}

test('complete native capture preserves the observed Win32 WRITE attributes',()=>{
  const capture=positiveCapture();
  expect(classifyBroker(capture,'native').kind).toBe('positive');
  expect(classifyBroker(capture.replace('api=0 access=1 async=0 disposition=1 status=0x00000000 type=2 device=21 granted=0x00120196','api=0 access=1 async=0 disposition=1 status=0x00000000 type=2 device=21 granted=0x00120116'),'native').experimentComplete).toBe(false);
});

test('native admission reconciles every delegation, measurement and suspension',()=>{
  const capture=positiveCapture();
  const uniform=capture;
  const without=(prefix:string)=>uniform.split('\n').filter(line=>!line.startsWith(prefix)).join('\n');
  for (const prefix of ['NB_DELEGATE','NB_MEASUREMENT','NB_RESUME']) expect(classifyBroker(without(prefix),'native').experimentComplete).toBe(false);
  for (const [a,b] of [['previous=1 ok=1','previous=1 ok=0'],['hostClosed=1','hostClosed=0'],['owner=11 previous=1','owner=12 previous=1'],['sequence=2 ','sequence=1 ']]) expect(classifyBroker(uniform.replace(a!,b!),'native').experimentComplete).toBe(false);
});

test('Bun evidence binds its exact runtime, ordinary children and complete native child proof',()=>{
  const capture=positiveCapture(true);
  expect(classifyBroker(capture,'bun',false,expectedImages).kind).toBe('positive');
  for (const prefix of ['NB_OPEN','NB_DENY','NB_CHECK','NB_DELEGATE','NB_MEASUREMENT']) {
    const partial=capture.split('\n').filter(line=>!line.startsWith(prefix)).join('\n');
    expect(classifyBroker(partial,'bun',false,expectedImages).experimentComplete).toBe(false);
  }
  for (const [a,b] of [['NB_BUN pid=10','NB_BUN pid=20'],['sha='+nativeSha,'sha='+bunSha],['parent=10 generation=child','parent=20 generation=child']]) expect(classifyBroker(capture.replace(a!,b!),'bun',false,expectedImages).experimentComplete).toBe(false);
});
