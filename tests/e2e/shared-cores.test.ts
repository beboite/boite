import { expect, test } from 'bun:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedCores } from './lib/shared-projects.ts';
import { waitFor } from '../../packages/core/test/harness.ts';
import { thrown } from '../../packages/core/test/settle.ts';
import { receiveProject } from '../../packages/core/src/contacts/project-relay.ts';
import { connect } from '../../packages/core/src/client.ts';

test.each(['unsubscribe','disconnect'] as const)('a member lease closes after its consent revision changes on %s',async action=>{
  const f=await sharedCores(),{a,b,member:m}=f;
  try {
    const offered=await a.client.call('sharedProjects.offer',{coreId:b.coreId,projectId:a.ref.projectId,remote:m.ref,requestId:'lease-member'});
    const scope={threadId:a.threadId,sharedProjectId:offered.shared.id};
    const subscriptions=m.h.core.sharedProjects.subscriptions as unknown as {leases:Map<string,unknown>;timer:unknown};
    await m.client.call('sharedProjects.decide',{sharedProjectId:scope.sharedProjectId,accept:true,requestId:'accept-lease'});
    await a.client.call('sharedProjects.subscribe',{...scope,enabled:true});
    expect(subscriptions.leases.size).toBe(1);
    await m.client.call('sharedProjects.configure',{sharedProjectId:scope.sharedProjectId,board:true});
    await waitFor(()=>a.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision===m.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision);
    if(action==='disconnect') a.client.close();
    else await a.client.call('sharedProjects.subscribe',{...scope,enabled:false});
    await m.client.call('threads.update',{threadId:m.threadId,title:'After member unsubscribe'});
    await waitFor(()=>subscriptions.leases.size===0&&subscriptions.timer===null);
    expect(subscriptions.leases.size).toBe(0);
    expect(subscriptions.timer).toBeNull();
  } finally {await f.close();}
},30000);

test('two owners associate a group member, exchange human letters, share a board and consume an attested Git result', async () => {
  const f = await sharedCores(), {a, b, member: m} = f;
  try {
    const offer = a.h.core.contacts.find(b.coreId)!.offers.find(p => p.sharedProject?.coreId === m.coreId);
    expect(offer?.sharedProject).toEqual(m.ref);
    const offered = await a.client.call('sharedProjects.offer', {coreId: b.coreId, projectId: a.ref.projectId, remote: m.ref, requestId: 'offer-member'});
    const scope = {threadId: a.threadId, sharedProjectId: offered.shared.id};
    await m.client.call('sharedProjects.decide', {sharedProjectId: scope.sharedProjectId, accept: true, requestId: 'accept-member'});
    expect((await a.client.call('sharedProjects.get', scope)).shared.state).toBe('active');
    expect(await b.client.call('sharedProjects.list', {threadId: b.threadId})).toEqual([]);
    const directory = await a.client.call('sharedProjects.threads', scope);
    expect(directory.unavailable).toEqual([]);
    const remote = directory.threads.find(t => t.ref.project.coreId === m.coreId)!;
    expect(remote.ref.threadId).toBe(a.threadId);
    expect(remote.ref.address).toEqual({coreId: b.coreId, threadId: `${m.threadId}~${m.coreId.slice(0, 16)}`});
    expect(await thrown(a.client.call('sharedProjects.read', {...scope, target: remote.ref}))).toThrow('readThreads');
    await b.client.call('contacts.grant', {coreId: a.coreId, projectId: m.ref.projectId, machine: m.coreId, readThreads: true});
    await waitFor(() => a.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision === m.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision && m.h.core.contacts.members.relayedOf(a.coreId)[0]?.grants[0]?.readThreads === true);
    expect((await a.client.call('sharedProjects.read', {...scope, target: remote.ref})).contact.sharedThread).toEqual(remote.ref);
    const human = await a.client.call('contacts.sendHuman', {threadId: a.threadId, to: remote.ref.address, text: 'Check the shared patch', requestId: 'human-member'});
    await waitFor(() => m.h.core.coordination.get(m.threadId).messages.some(l => l.id === human.id));
    expect(m.h.core.coordination.get(m.threadId).messages.find(l => l.id === human.id)?.origin).toBe('contact-human');
    for (const s of [a, m]) await s.client.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, board: true});
    const add = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: 'add', cardId: 'card', text: 'Shared patch'}});
    expect((await m.client.call('sharedBoard.get', scope)).kind).toBe('snapshot');
    const worker = await m.client.call('threads.create', {projectId: m.ref.projectId, providerId: 'echo', accountId: m.accountId, title: 'Board worker'});
    const workerRef = (await m.client.call('sharedProjects.threads', scope)).threads.find(t => t.ref.project.coreId === m.coreId && t.ref.threadId === worker.id)!.ref;
    const claim = await m.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'claim', cardId: 'card', expectedRevision: add.revision, worker: workerRef}});
    expect(claim.outcome).toBe('applied');
    const release = await m.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'release', cardId: 'card', claimId: claim.card!.assignment!.claimId}});
    expect(['queued', 'applied']).toContain(release.outcome);
    await waitFor(() => a.h.core.sharedBoard.journal.snapshot(scope.sharedProjectId).cards[0]?.assignment === null);
    await m.client.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, computeThreadId: m.threadId, compute: {enabled: true, profiles: ['conversation'], permissionMode: 'default', maxConcurrent: 5}});
    const guard = m.h.core.sharedCompute.guardStart;
    m.h.core.sharedCompute.guardStart = async (ctx, ref, job) => {
      await guard(ctx, ref, job);
      const cwd = m.h.core.threads.require(ref.threadId).cwd;
      writeFileSync(join(cwd, 'shared-result.txt'), 'verified on the worker\n');
      await f.git(m.h, cwd, 'add', 'shared-result.txt');
      await f.git(m.h, cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'shared result');
    };
    const job = await a.client.call('sharedCompute.start', {...scope, host: m.ref, profileId: 'conversation', baseCommit: f.baseCommit, task: 'Return the patch', requestId: 'compute-member'});
    await waitFor(() => m.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === 'done', 10000);
    const completed = await a.client.call('sharedCompute.get', {...scope, jobId: job.id});
    expect(completed.worker!.project).toEqual(m.ref);
    expect(completed.result?.dirty).toBe(false);
    expect(m.h.core.threads.require(completed.worker!.threadId).accountId).toBe(m.accountId);
    // Normal owner Git workflow: a fixture-controlled remote path, an explicit ref,
    // expected object/ancestry verification, then the owner's integration branch.
    // No peer URL, text, task or shell fragment is executed.
    const result = completed.result!;
    await f.git(a.h, a.path, 'fetch', m.path, `refs/heads/${result.branch}`);
    expect(await f.git(a.h, a.path, 'rev-parse', 'FETCH_HEAD')).toBe(result.commit);
    await f.git(a.h, a.path, 'merge-base', '--is-ancestor', result.baseCommit, result.commit);
    await f.git(a.h, a.path, 'checkout', '-b', 'integration-result');
    await f.git(a.h, a.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'cherry-pick', result.commit);
    expect(readFileSync(join(a.path, 'shared-result.txt'), 'utf8')).toBe('verified on the worker\n');
    await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'remove', requestId: 'remove', cardId: 'card'}});
    const page = await m.client.call('sharedBoard.get', scope);
    expect(page.kind === 'snapshot' && page.tombstones.some(t => t.id === 'card')).toBe(true);
    await b.client.call('contacts.revoke', {coreId: a.coreId, projectId: m.ref.projectId, machine: m.coreId});
    await waitFor(() => m.h.core.sharedProjects.require(scope.sharedProjectId).state === 'revoked');
    expect(await thrown(a.client.call('sharedProjects.read', {...scope, target: remote.ref}))).toThrow();
  } finally { await f.close(); }
}, 60000);

test('a removed and rejoined member cannot reuse its saved contact mirror from an earlier admission', async () => {
  const f = await sharedCores(), {a, b, member: m} = f;
  try {
    expect(m.h.core.contacts.isContact(a.coreId)).toBe(true);
    const stored = m.h.core.journal.getSetting('contacts:relayed');
    b.h.core.contacts.members.mark = () => {};
    await b.client.call('group.remove', {coreId:m.coreId});
    await waitFor(() => m.h.core.group.view('owner') === null);
    await m.client.call('group.join', {invite:(await b.client.call('group.invite', {})).invite});
    // Even a crash-restored old setting cannot carry authority into a new epoch.
    m.h.core.journal.setSetting('contacts:relayed', stored);
    m.h.core.contacts.reset();
    expect(m.h.core.contacts.isContact(a.coreId)).toBe(false);
    await f.restart(m);
    expect(m.h.core.contacts.isContact(a.coreId)).toBe(false);
  } finally { await f.close(); }
}, 60000);

test('a member initiates the association, survives restart and cancels only its captured reverse compute job', async () => {
  const f = await sharedCores(), {a, b, member: m} = f;
  const clients: {close():void}[] = [];
  try {
    await waitFor(() => m.h.core.contacts.members.relayedOf(a.coreId)[0]?.capabilities?.sharedProjects === 1);
    const offered = await m.client.call('sharedProjects.offer', {coreId: a.coreId, projectId: m.ref.projectId, remote: a.ref, requestId: 'reverse-offer'});
    expect(offered.shared.authority).toEqual(m.ref);
    await a.client.call('sharedProjects.decide', {sharedProjectId: offered.shared.id, accept: true, requestId: 'reverse-accept'});
    const scope = {threadId: m.threadId, sharedProjectId: offered.shared.id};
    const agent = await connect(m.h.url, m.h.core.agents.tokenFor(m.threadId)); clients.push(agent);
    expect((await agent.call('sharedProjects.threads', scope)).threads.some(t => t.ref.project.coreId === a.coreId)).toBe(true);
    expect(await thrown(agent.call('sharedProjects.configure', {sharedProjectId: offered.shared.id, board: true}))).toThrow('agent');
    expect(await thrown(agent.call('sharedProjects.threads', {...scope,threadId:'another-source'}))).toThrow(m.threadId);
    const {grant} = await m.client.call('pairing.grant', {});
    const phone = await connect(m.h.url, '', {grant,client:{name:'Fixture phone',version:'test'}}); clients.push(phone);
    expect((await phone.call('sharedProjects.get', scope)).shared.state).toBe('active');
    expect(await thrown(phone.call('sharedProjects.configure', {sharedProjectId:offered.shared.id,board:true}))).toThrow();
    const letter = await phone.call('contacts.sendHuman', {threadId:m.threadId,to:{coreId:a.coreId,threadId:a.threadId},text:'Member owner requests a check',requestId:'reverse-human'});
    await waitFor(() => a.h.core.coordination.get(a.threadId).messages.some(l => l.id === letter.id));
    expect(a.h.core.coordination.get(a.threadId).messages.find(l => l.id === letter.id)?.from.sharedThread?.project).toEqual(m.ref);
    const peer = a.h.core.contacts.peers().find(p => p.coreId === b.coreId)!;
    expect(await thrown(a.h.core.coordination.request(peer,'contact.project',{method:'threads',route:{source:a.ref,target:{...m.ref,projectId:'ungranted'}},requestId:'forged-route',sharedProjectId:offered.shared.id,grantRevision:1,source:{kind:'human',project:a.ref},params:{}}))).toThrow('not granted');
    await a.client.call('sharedProjects.configure', {sharedProjectId:offered.shared.id,computeThreadId:a.threadId,compute:{enabled:true,profiles:['conversation'],permissionMode:'default',maxConcurrent:5}});
    const local = await a.client.call('threads.create', {projectId:a.ref.projectId,providerId:'echo',accountId:a.accountId,title:'Unrelated owner work'});
    const turn = await a.client.call('turns.start', {threadId:local.id,prompt:'[sleep:90000]'});
    const job = await m.client.call('sharedCompute.start', {...scope,host:a.ref,profileId:'conversation',baseCommit:f.baseCommit,task:'[sleep:90000]',requestId:'reverse-job'});
    expect(job.source.project).toEqual(m.ref);
    expect(job.source.address).toEqual({coreId:b.coreId,threadId:`${m.threadId}~${m.coreId.slice(0,16)}`});
    for (const client of clients.splice(0)) client.close();
    await f.restart(m);
    expect((await m.client.call('sharedProjects.get',scope)).shared.authority).toEqual(m.ref);
    const stopped = await m.client.call('sharedCompute.cancel', {...scope,jobId:job.id,requestId:'reverse-stop'});
    if (stopped.status !== 'cancelled') {
      const workerId = a.h.core.sharedCompute.journal.get(job.id, 'host')?.job.worker?.threadId;
      console.error('REVERSE_COMPUTE_ADMISSION', JSON.stringify({job: stopped, host: a.h.core.sharedCompute.journal.get(job.id, 'host')?.job,
        processes: workerId ? a.h.core.journal.listProcesses(workerId, 100) : [],
        logs: workerId ? await a.h.core.logs.query({threadId: workerId, limit: 100}) : []}));
    }
    expect(stopped.status).toBe('cancelled');
    expect(a.h.core.sharedCompute.journal.get(job.id,'host')!.job.result).toBeNull();
    expect(a.h.core.journal.getTurn(turn.id)?.status).toBe('running');
    await a.client.call('turns.stop', {threadId:local.id});
  } finally { for (const client of clients) client.close(); await f.close(); }
}, 60000);

test('a member policy revocation fences its exact project without a direct contact or owner forwarding', async () => {
  const f = await sharedCores(), {a, b, member: m} = f;
  try {
    const offered = await a.client.call('sharedProjects.offer', {coreId: b.coreId, projectId: a.ref.projectId, remote: m.ref, requestId: 'review-offer'});
    await m.client.call('sharedProjects.decide', {sharedProjectId: offered.shared.id, accept: true, requestId: 'review-accept'});
    expect(m.h.core.contacts.has(a.coreId)).toBe(false);
    expect(m.h.core.contacts.mayReach(a.coreId, m.threadId)).toBe(true);
    expect(() => m.h.core.sharedProjects.journal.transaction(() => m.h.core.sharedProjects.revokeForPolicy(offered.shared.id))).not.toThrow();
    expect(m.h.core.sharedProjects.require(offered.shared.id).state).toBe('revoked');
    expect(m.h.core.contacts.mayReach(a.coreId, m.threadId)).toBe(false);
    expect(m.h.core.contacts.mayRead(a.coreId, m.threadId)).toBe(false);
    expect(b.h.core.contacts.find(a.coreId)!.grants.some(g => g.machine === m.coreId)).toBe(true);
    const renewed = await m.client.call('sharedProjects.offer', {coreId:a.coreId,projectId:m.ref.projectId,remote:a.ref,requestId:'explicit-member-renewal'});
    expect(renewed.shared.state).toBe('pending');
    expect(renewed.shared.id).not.toBe(offered.shared.id);
    await a.client.call('sharedProjects.decide', {sharedProjectId:renewed.shared.id,accept:true,requestId:'renewal-accept'});
    expect(m.h.core.contacts.mayReach(a.coreId,m.threadId)).toBe(true);
  } finally { await f.close(); }
}, 60000);

test('a member transcript held at the gateway cannot outlive a changed read grant', async () => {
  const f = await sharedCores(), {a, b, member: m} = f;
  let resume = () => {};
  try {
    const offer = await a.client.call('sharedProjects.offer', {coreId: b.coreId, projectId: a.ref.projectId, remote: m.ref, requestId: 'race-offer'});
    const scope = {threadId: a.threadId, sharedProjectId: offer.shared.id};
    await m.client.call('sharedProjects.decide', {sharedProjectId: offer.shared.id, accept: true, requestId: 'race-accept'});
    await b.client.call('contacts.grant', {coreId: a.coreId, projectId: m.ref.projectId, machine: m.coreId, readThreads: true});
    await waitFor(() => a.h.core.sharedProjects.require(offer.shared.id).access[1].revision === m.h.core.sharedProjects.require(offer.shared.id).access[1].revision && m.h.core.contacts.members.relayedOf(a.coreId)[0]?.grants[0]?.readThreads === true);
    const target = (await a.client.call('sharedProjects.threads', scope)).threads.find(t => t.ref.project.coreId === m.coreId)!.ref;
    const original = b.h.core.contacts.members.requestProject.bind(b.h.core.contacts.members);
    let held = false;
    b.h.core.contacts.members.requestProject = async (...args) => {
      const answer = await original(...args);
      if ((args[2] as {method?: string}).method === 'read') {
        held = true;
        await new Promise<void>(resolve => { resume = resolve; });
      }
      return answer;
    };
    const read = thrown(receiveProject(b.h.core, a.coreId, {method: 'read', route: {source: a.ref, target: m.ref}, requestId: 'held-read', sharedProjectId: offer.shared.id,
      grantRevision: m.h.core.sharedProjects.require(offer.shared.id).access[1].revision, source: {kind: 'human', project: a.ref}, params: {target}}, false));
    await waitFor(() => held);
    // Simulate a delayed mirror: only the gateway knows the new policy so far.
    const mark = b.h.core.contacts.members.mark.bind(b.h.core.contacts.members);
    b.h.core.contacts.members.mark = () => {};
    await b.client.call('contacts.grant', {coreId: a.coreId, projectId: m.ref.projectId, machine: m.coreId, readThreads: false});
    b.h.core.contacts.members.mark = mark;
    resume();
    expect(await read).toThrow('grant changed during request');
  } finally { resume(); await f.close(); }
}, 60000);
