import {expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {thrown} from '../../../packages/core/test/settle.ts';
import {observeHelperJob, parseHold, populatedProof, releasedProof, observation, type HoldFrame, type RootProof, type JobAccounting} from './helper-job.ts';
import type {Membership} from './target-topology.ts';
import type {Captured} from './capture.ts';
import {HelperReferenceSlot, type ReferenceAnchor} from './helper-reference.ts';
const helper = {pid: 11, created: '100'}, creator = {pid: 22, created: '200'}, root = {pid: 33, created: '300'};
const proof: RootProof = {request: {version: 1, phase: 'root', nonce: '01'.repeat(16), waiting: true, helper, creator, root},
  proof: ['launcher', 'harness'].flatMap(owner => [helper, creator, root].map(p => ({...p, owner, role: `${owner}-main`,
    threadId: `${owner}-trial`, threadJob: owner === 'harness' ? '50' : '40', globalJob: '41', jobKey: owner === 'harness' ? 4 : 3,
    nestingRefused: false, threadMember: 1, globalMember: 1})))};
const live = proof.proof.find(r => r.owner === 'harness' && r.pid === 22)!;
const account: JobAccounting = {...live, jobKey: 4, active: 1, wallMs: Date.now()};
const frame = (): HoldFrame => ({version: 1, phase: 'hold', nonce: proof.request.nonce, helper, creator, root,
  deadlineWallMs: Date.now() + 2500, closed: 7, ioAcquired: 6, ioClosed: 6});
const membershipRows = () => proof.proof.map(r => ({event: 'owned-membership', ...r}));
const refs = (p: typeof helper, closed: boolean) => ['launcher', 'harness'].flatMap(owner => [
  {event: 'acquired', owner, role: `${owner}-main`, pid: p.pid, incarnation: p.created, id: `${owner}/${p.pid}`},
  ...(closed ? [{event: 'close-result', owner, role: `${owner}-main`, id: `${owner}/${p.pid}`, success: true}] : []),
]);
const exits = () => ['launcher', 'harness'].flatMap(owner => [
  {event: 'close-result', owner, role: `${owner}-main`, id: `${owner}/22`, success: true},
  {event: 'owned-exit', owner, role: `${owner}-main`, pid: 22, created: '200', exitCode: 0},
]);
const captured = (path: string, absent = true): Captured => ({pid: 44, code: 0, err: '', timedOut: false,
  out: `map-after-helper-exit path=${path} open=${absent ? '0xc0000034' : '0x00000000'} absent=${+absent} closed=1 error=0\r\n`});

test('hold rejects stale identities, nonce, incomplete closure and expired or extended deadlines', () => {
  const valid = frame(), now = Date.now();
  expect(parseHold(JSON.stringify(valid), proof.request, now)).toEqual(valid);
  for (const change of [{nonce: '02'.repeat(16)}, {creator: {...creator, created: '201'}}, {helper: {...helper, created: '101'}},
    {root: {...root, pid: 34}}, {closed: 6}, {ioClosed: 5}, {ioAcquired: 0, ioClosed: 0},
    {deadlineWallMs: now}, {deadlineWallMs: now + 3001}, {phase: 'other'}])
    expect(() => parseHold(JSON.stringify({...valid, ...change}), proof.request, now)).toThrow();
});
test('populated proof requires the same owned job, both memberships and no earlier zero packet', () => {
  const f = frame(), rows = membershipRows();
  expect(populatedProof(f, proof, live, account, rows)).toBe(true);
  for (const change of [{jobKey: 5}, {threadJob: '51'}, {active: 0}, {active: NaN}, {owner: 'different'}])
    expect(populatedProof(f, proof, live, {...account, ...change}, rows)).toBe(false);
  for (const change of [{created: '201'}, {threadMember: 0}, {globalMember: 0}, {owner: 'different'}])
    expect(populatedProof(f, proof, {...live, ...change}, account, rows)).toBe(false);
  expect(populatedProof(f, proof, live, account, rows.slice(3))).toBe(false);
  expect(populatedProof(f, proof, live, account, [...rows,
    {event: 'job-packet', owner: 'harness', role: 'harness-main', key: 4, message: 4}])).toBe(false);
});
test('empty proof requires exit zero, both closure ledgers and the unchanged zero-active job', () => {
  const f = frame(), rows = [...refs(creator, false), ...exits()], empty = {...account, active: 0};
  expect(releasedProof(f, account, empty, rows)).toBe(true);
  expect(releasedProof(f, account, account, rows)).toBe(false);
  expect(releasedProof(f, account, {...empty, jobKey: 5}, rows)).toBe(false);
  expect(releasedProof(f, account, empty, rows.filter(r => r.role !== 'launcher-main'))).toBe(false);
  expect(releasedProof(f, account, empty, rows.map(r => r.event === 'owned-exit' ? {...r, exitCode: 125} : r))).toBe(false);
  expect(releasedProof(f, account, empty, [...rows, {event: 'incomplete', owner: 'harness', role: 'harness-main'}])).toBe(false);
});
test('exact-name evidence records either outcome but rejects contradictory or unfinished observations', () => {
  const path = String.raw`\BaseNamedObjects\boite.route.11.retired`;
  expect(observation(path, captured(path, false)).absent).toBe(false);
  expect(observation(path, captured(path)).absent).toBe(true);
  for (const change of [{timedOut: true}, {code: null}, {out: captured(path).out.replace('absent=1', 'absent=0')},
    {out: captured(path + '.extra').out}]) expect(() => observation(path, {...captured(path), ...change})).toThrow();
});
async function fixture(run: (options: Parameters<typeof observeHelperJob>[0], release: () => void) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'boite-helper-job-')), trace = join(directory, 'trace'); mkdirSync(trace);
  const prefix = join(directory, 'trial'), f = frame(), text = JSON.stringify(f);
  let alive = true;
  const rows: Parameters<typeof releasedProof>[3] = [...membershipRows(), ...refs(helper, true),
    ...refs({...creator, created: '199'}, true).map(r => ({...r, id: `${r.id}-stale`})),
    {event: 'owned-exit', owner: 'launcher', role: 'launcher-main', ...creator, created: '199', exitCode: 0},
    ...refs(creator, false),
    {event: 'transfer-send', owner: 'launcher', role: 'launcher-worker', transfer: {id: 'launcher/22'}},
    {event: 'transfer-received', owner: 'launcher', role: 'launcher-main', ...creator, incarnation: creator.created, id: 'launcher/22'},
  ];
  const writeRows = () => writeFileSync(join(trace, 'harness-main.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeRows(); writeFileSync(`${prefix}.hold.ready`, text);
  const options: Parameters<typeof observeHelperJob>[0] = {prefix, trace, roots: [proof], record: {},
    helper: {pid: 11, code: 125, timedOut: false, out: '',
      err: `private-map path=${String.raw`\BaseNamedObjects\boite.route.11`} create=0x00000000\r\nmap-retire named path=${String.raw`\BaseNamedObjects\boite.route.11.retired`} create=0x00000000\r\n`},
    live: () => alive ? live : null, job: () => ({...account, active: alive ? 1 : 0, wallMs: Date.now()}),
    observe: async path => captured(path, !alive || !path.endsWith('.retired'))};
  try {await run(options, () => {if (!alive) return; alive = false; rows.push(...exits()); writeRows(); writeFileSync(`${prefix}.hold.done`, text);});}
  finally {rmSync(directory, {recursive: true, force: true});}
}
test('real file protocol keeps populated name evidence separate, releases only after both observations, then proves closure', async () => {
  await fixture(async (options, release) => {
    options.helper.err = options.helper.err.replaceAll(String.raw`\BaseNamedObjects`, String.raw`\Sessions\2\BaseNamedObjects`);
    const timer = setInterval(() => {if (existsSync(`${options.prefix}.hold.release`)) release();}, 5);
    try {
      await observeHelperJob(options);
      expect(options.record.protocolValid).toBe(true);
      const populated = options.record.populated as {observation: {absent: boolean}}[];
      expect(populated.map(r => r.observation.absent)).toEqual([true, false]);
      expect(options.record.empty).toHaveLength(2);
      const ledger = options.record.closureRows as Parameters<typeof releasedProof>[3];
      expect(ledger.some(r => r.incarnation === '199' || r.created === '199' || r.id?.endsWith('-stale'))).toBe(false);
      expect(ledger.filter(r => r.event === 'acquired')).toHaveLength(2);
      expect(ledger.filter(r => r.event === 'close-result')).toHaveLength(2);
      expect(ledger.filter(r => r.event === 'owned-exit')).toHaveLength(2);
      expect(ledger.some(r => r.event === 'transfer-send')).toBe(true);
    } finally {clearInterval(timer);}
  });
});
test('early release and a missed populated-observation deadline cannot produce a valid protocol', async () => {
  await fixture(async options => {
    writeFileSync(`${options.prefix}.hold.release`, readFileSync(`${options.prefix}.hold.ready`));
    expect(await thrown(observeHelperJob(options))).toThrow('early release');
    expect(options.record.protocolValid).toBe(false);
  });
  await fixture(async options => {
    const f = frame(); f.deadlineWallMs = Date.now() + 20;
    writeFileSync(`${options.prefix}.hold.ready`, JSON.stringify(f));
    options.observe = async path => {await new Promise(resolve => setTimeout(resolve, 30)); return captured(path);};
    expect(await thrown(observeHelperJob(options))).toThrow('deadline');
    expect(existsSync(`${options.prefix}.hold.release`)).toBe(false);
  });
});

function referenceFixture(options: Parameters<typeof observeHelperJob>[0], delay = 0, failedClose = false) {
  const file = join(options.trace, 'harness-main.jsonl');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(r => !(r.event === 'close-result' && r.id === 'harness/11'));
  const save = () => writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  save(); let closes = 0, owned = true, exitCode = 259;
  const anchor: ReferenceAnchor = {nonce: proof.request.nonce, helper, owner: 'harness', id: 'harness/11', handle: 8,
    threadId: live.threadId, threadJob: live.threadJob, jobKey: 4, globalJob: live.globalJob, nestingRefused: false, deadline: Date.now() + 30000};
  const slot = new HelperReferenceSlot({owner: 'harness', role: 'harness-main',
    reference: () => owned ? {entry: {id: anchor.id, handle: 8, pid: 11, incarnation: '100', from: 'harness', stage: 'tracked'},
      identity: {pid: 11, incarnation: '100', exitCode}, complete: true} : undefined,
    event: e => {rows.push({...e, owner: 'harness', role: 'harness-main'}); save();},
    close: (_handle, id) => {
      closes++; owned = false;
      rows.push({event: 'close-result', owner: 'harness', role: 'harness-main', id, success: !failedClose, error: failedClose ? 6 : 0}); save();
      return {id, success: !failedClose, error: failedClose ? 6 : 0, wallMs: Date.now()};
    }});
  slot.arm(anchor, proof.proof.find(p => p.role === 'harness-main' && p.pid === helper.pid)!);
  const transfer = () => {exitCode = 125; expect(slot.retain(8, 11, '100', live.threadId, 125, anchor)).toBe(true);};
  const timer = delay ? setTimeout(transfer, delay) : undefined; if (!delay) transfer();
  options.reference = {arm: () => {throw new Error('already armed before root release');}, bound: d => slot.bound(d),
    pending: () => slot.pending(), sample: () => slot.sample(), close: () => slot.close(), cleanup: () => slot.cleanup()};
  return {slot, rows, save, closes: () => closes, stop: () => {if (timer) clearTimeout(timer); slot.cleanup();}};
}

test('real held protocol waits for late reportExit, observes twice held, closes once, then releases creator', async () => {
  await fixture(async (options, release) => {
    const ref = referenceFixture(options, 20), observed: string[] = [];
    const observer = options.observe;
    options.observe = async (path, phase, index, limit) => {
      observed.push(phase);
      if (phase.startsWith('held')) expect(ref.closes()).toBe(0);
      else expect(ref.closes()).toBe(1);
      if (phase !== 'empty') expect(existsSync(`${options.prefix}.hold.release`)).toBe(false);
      return observer(path, phase, index, limit);
    };
    const timer = setInterval(() => {if (existsSync(`${options.prefix}.hold.release`)) release();}, 5);
    try {
      await observeHelperJob(options);
      expect(options.record.protocolValid).toBe(true); expect(options.record.causeConfirmed).toBe(false);
      expect(options.record.productionAccepted).toBe(false);
      expect(observed).toEqual(['held-0', 'held-0', 'held-1', 'held-1', 'populated', 'populated', 'empty', 'empty']);
      expect(options.record.held).toHaveLength(4); expect(options.record.populated).toHaveLength(2);
      expect(options.record.referenceClose).toMatchObject({success: true, reason: 'observed'});
      expect(ref.closes()).toBe(1);
    } finally {clearInterval(timer); ref.stop();}
  });
});

test('held controller rejects missing other-registry closure, actual close failure, early close, changed job/live creator and deadline', async () => {
  for (const fault of ['missing-closure', 'failed-close', 'early-close', 'job', 'creator', 'deadline']) {
    await fixture(async options => {
      const ref = referenceFixture(options, 0, fault === 'failed-close');
      if (fault === 'missing-closure') {
        const at = ref.rows.findIndex(r => r.event === 'close-result' && r.id === 'launcher/11'); ref.rows.splice(at, 1); ref.save();
      }
      if (fault === 'missing-closure' || fault === 'deadline') {
        const f = frame(); f.deadlineWallMs = Date.now() + 35; writeFileSync(`${options.prefix}.hold.ready`, JSON.stringify(f));
      }
      const observer = options.observe; let observations = 0;
      options.observe = async (path, phase, index, limit) => {
        observations++;
        if (fault === 'early-close' && observations === 1) ref.slot.close();
        if (fault === 'job' && observations === 1) options.job = () => ({...account, jobKey: 99});
        if (fault === 'creator' && observations === 1) options.live = () => ({...live, created: '201'});
        if (fault === 'deadline') await new Promise(resolve => setTimeout(resolve, 45));
        return observer(path, phase, index, limit);
      };
      try {
        expect(await thrown(observeHelperJob(options))).toThrow();
        expect(options.record.protocolValid).toBe(false); expect(ref.closes()).toBe(1);
        expect(existsSync(`${options.prefix}.hold.release`)).toBe(false);
      } finally {ref.stop();}
    });
  }
});
