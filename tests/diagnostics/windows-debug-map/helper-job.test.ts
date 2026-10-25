import {expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {thrown} from '../../../packages/core/test/settle.ts';
import {observeHelperJob, parseHold, populatedProof, releasedProof, observation, type HoldFrame, type RootProof, type JobAccounting} from './helper-job.ts';
import type {Membership} from './target-topology.ts';
import type {Captured} from './capture.ts';
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
  const rows: Parameters<typeof releasedProof>[3] = [...membershipRows(), ...refs(helper, true), ...refs(creator, false)];
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
