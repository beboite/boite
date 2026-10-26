import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseTopology, proveTopology, creatorReferencesClosed, serveTopology, type TopologyRequest, type Membership} from './target-topology.ts';

const helper = {pid: 11, created: '100'}, creator = {pid: 22, created: '200'}, root = {pid: 33, created: '300'};
const request: TopologyRequest = {version: 1, phase: 'root', nonce: '01'.repeat(16), waiting: false, helper, creator, root};
const rows = (): Membership[] => ['launcher', 'harness'].flatMap(owner => [helper, creator, root].map(p => ({...p,
  owner, role: `${owner}-main`, threadId: `${owner}/thread`, threadJob: owner === 'launcher' ? '40' : '50',
  globalJob: owner === 'launcher' ? '41' : '51', nestingRefused: false, threadMember: 1, globalMember: 1})));
test('topology requires both actual owners, all exact incarnations and the same known job chain', () => {
  expect(proveTopology(request, rows())).toHaveLength(6);
  const mutations: ((r: Membership) => void)[] = [
    r => {r.created = '999';}, r => {r.owner = 'unrelated-owner';}, r => {r.role = 'worker';},
    r => {r.threadMember = 0;}, r => {r.globalMember = null;}, r => {r.threadJob = '99';},
    r => {r.nestingRefused = true;}, r => {r.threadJob = '0';}, r => {r.globalJob = '0';},
  ];
  for (const mutate of mutations) {
    const evidence = rows(); mutate(evidence[5]!); expect(proveTopology(request, evidence)).toBeNull();
  }
  expect(proveTopology(request, rows().slice(0, 3))).toBeNull();
  // An explicit nesting refusal permits a common actual global membership of
  // zero, but a changed membership between processes still invalidates it.
  const refused = rows().map(r => ({...r, nestingRefused: true, globalMember: 0}));
  expect(proveTopology(request, refused)).toHaveLength(6);
  refused[5]!.globalMember = 1; expect(proveTopology(request, refused)).toBeNull();
});
test('barrier requests bind phase, nonce, helper and distinct process incarnations', () => {
  expect(parseTopology(JSON.stringify(request), 11, 'root')).toEqual(request);
  for (const change of [{nonce: 'xx'.repeat(16)}, {version: 2}, {phase: 'creator'}, {root: null},
    {root: creator}, {helper: {...helper, created: ''}}, {waiting: 1}])
    expect(() => parseTopology(JSON.stringify({...request, ...change}), 11, 'root')).toThrow();
  expect(() => parseTopology(JSON.stringify(request), 99, 'root')).toThrow();
});
test('creator closure requires both main owners and reconciles transferred references', () => {
  const evidence = ['launcher', 'harness'].flatMap(owner => [
    {event: 'acquired', owner, role: `${owner}-main`, pid: 22, incarnation: '200', id: owner},
    {event: 'close-result', owner, role: `${owner}-main`, id: owner, success: true},
  ]);
  expect(creatorReferencesClosed(creator, evidence)).toBe(true);
  expect(creatorReferencesClosed({...creator, created: '201'}, evidence)).toBe(false);
  expect(creatorReferencesClosed(creator, evidence.slice(0, 2))).toBe(false);
  expect(creatorReferencesClosed(creator, [...evidence, {event: 'incomplete', owner: 'harness', role: 'harness-main'}])).toBe(false);
  const transferred = [...evidence,
    {event: 'acquired', owner: 'worker', role: 'launcher-worker', pid: 22, incarnation: '200', id: 'transfer'},
    {event: 'transfer-send', owner: 'worker', role: 'launcher-worker', transfer: {id: 'transfer'}},
    {event: 'close-result', owner: 'launcher', role: 'launcher-main', id: 'transfer', success: true},
  ];
  expect(creatorReferencesClosed(creator, transferred)).toBe(false);
  transferred.push({event: 'transfer-received', owner: 'launcher', role: 'launcher-main', pid: 22, incarnation: '200', id: 'transfer'});
  expect(creatorReferencesClosed(creator, transferred)).toBe(true);
  transferred.push({event: 'close-result', owner: 'launcher', role: 'launcher-main', id: 'transfer', success: false});
  expect(creatorReferencesClosed(creator, transferred)).toBe(false);
});
test('real barriers require live memberships and both creator closure ledgers before echoing a frame', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-target-topology-')), trace = join(directory, 'trace'); mkdirSync(trace);
  const prefix = join(directory, 'trial'), proofs: unknown[] = [];
  let stopped = false, available = false, creatorGone = false, armed = 0;
  const gate = {...request, phase: 'creator' as const, root: null};
  const events = rows().filter(r => r.role === 'launcher-main').map(r => ({event: 'owned-membership', ...r}));
  writeFileSync(join(trace, 'launcher-main.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(`${prefix}.creator.request`, JSON.stringify(gate));
  const service = serveTopology(prefix, 11, trace, pid => available && !(creatorGone && pid === 22) ? rows().find(r => r.role === 'harness-main' && r.pid === pid)! : null,
    () => stopped, proofs, false, (r, proof) => {
      expect(r.phase).toBe('root'); expect(proof).toHaveLength(6);
      expect(() => readFileSync(`${prefix}.root.release`)).toThrow(); armed++;
    });
  async function awaitProofs(count: number) {
    const deadline = Date.now() + 1000;
    while (proofs.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(proofs).toHaveLength(count);
  }
  try {
    await new Promise(resolve => setTimeout(resolve, 25)); expect(proofs).toEqual([]);
    expect(() => readFileSync(`${prefix}.creator.release`)).toThrow();
    available = true;
    await awaitProofs(1);
    expect(readFileSync(`${prefix}.creator.release`, 'utf8')).toBe(JSON.stringify(gate));
    writeFileSync(`${prefix}.root.request`, JSON.stringify(request)); await awaitProofs(2);
    expect(armed).toBe(1);
    const closed = {...request, phase: 'closed'};
    writeFileSync(`${prefix}.closed.request`, JSON.stringify(closed)); creatorGone = true;
    const references = ['launcher', 'harness'].flatMap(owner => [
      {event: 'acquired', owner, role: `${owner}-main`, pid: 22, incarnation: '200', id: owner},
      {event: 'close-result', owner, role: `${owner}-main`, id: owner, success: true},
    ]);
    writeFileSync(join(trace, 'harness-main.jsonl'), references.slice(0, 2).map(r => JSON.stringify(r)).join('\n') + '\n');
    await new Promise(resolve => setTimeout(resolve, 25)); expect(proofs).toHaveLength(2);
    expect(() => readFileSync(`${prefix}.closed.release`)).toThrow();
    writeFileSync(join(trace, 'harness-main.jsonl'), references.map(r => JSON.stringify(r)).join('\n') + '\n');
    await awaitProofs(3);
    expect(readFileSync(`${prefix}.closed.release`, 'utf8')).toBe(JSON.stringify(closed));
  } finally {stopped = true; await service; rmSync(directory, {recursive: true, force: true});}
});
