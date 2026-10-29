import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/client.ts';
import { letterPrompt } from '../src/coordination-letter.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
afterEach(async () => { for (const core of cores.splice(0).reverse()) await core.stop(); });

async function pair() {
  const a = await startTestCore(), b = await startTestCore();
  cores.push(a, b);
  const ac = await a.connect(), bc = await b.connect();
  const at = await echoThread(a, ac), bt = await echoThread(b, bc);
  a.core.contacts.selfUrl = async () => a.url;
  const aid = a.core.coordination.card().coreId, bid = b.core.coordination.card().coreId;
  await bc.call('contacts.join', { link: (await ac.call('contacts.invite', {})).link });
  await waitFor(() => a.core.contacts.linked(bid));
  await ac.call('contacts.grant', { coreId: bid, projectId: a.core.threads.require(at.threadId).projectId! });
  await bc.call('contacts.grant', { coreId: aid, projectId: b.core.threads.require(bt.threadId).projectId! });
  await bc.call('contacts.update', { coreId: aid, name: 'My local contact name' });
  await bc.call('collaboration.configure', { threadId: bt.threadId, config: { mode: 'team', remote: true, paused: true, resources: '' } });
  return { a, b, ac, bc, at, bt, aid, bid, to: { coreId: bid, threadId: bt.threadId } };
}

test('owner and paired humans send attested contact letters without model authority or answering approvals', async () => {
  const { a, b, ac, bc, at, bt, aid, bid, to } = await pair();
  await waitFor(() => a.core.contacts.find(bid)?.capabilities?.humanLetters === 1);
  // Echo is below the default contact agent tier. A human has no model tier.
  const request = { threadId: at.threadId, to, text: 'Please inspect this project. This is not host approval.', requestId: 'human-owner' };
  const sent = await ac.call('contacts.sendHuman', request);
  expect(sent.origin).toBe('contact-human');
  expect((await ac.call('contacts.sendHuman', request)).id).toBe(sent.id);
  await waitFor(() => b.core.coordination.get(bt.threadId).messages.some(l => l.id === sent.id));
  const received = b.core.coordination.get(bt.threadId).messages.find(l => l.id === sent.id)!;
  expect(received.contact).toEqual({ coreId: aid, name: 'My local contact name' });
  expect(received.origin).toBe('contact-human');
  expect(received.from.agent).toBeUndefined();
  const concurrent = await Promise.all([a.core.coordination.send({...request, requestId:'concurrent'}, true), a.core.coordination.send({...request, requestId:'concurrent'}, true)]);
  expect(concurrent[0]!.id).toBe(concurrent[1]!.id);
  expect(a.core.coordination.get(at.threadId).messages.filter(l => l.id === concurrent[0]!.id)).toHaveLength(1);
  expect((await bc.call('threads.get', {threadId:bt.threadId})).messages).toEqual([]);
  const prompt = letterPrompt([received]);
  expect(prompt).toContain('HUMAN');
  expect(prompt).toContain('not the owner');
  expect(prompt).not.toContain("My local contact name's agent");
  const { grant } = await ac.call('pairing.grant', {});
  const phone = await connect(a.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  const agent = await connect(a.url, a.core.agents.tokenFor(at.threadId));
  try {
    expect((await phone.call('contacts.sendHuman', { ...request, requestId: 'human-phone' })).origin).toBe('contact-human');
    expect(await thrown(agent.call('contacts.sendHuman', { ...request, requestId: 'human-agent' }))).toThrow('contacts.sendHuman');
    expect(await thrown(ac.call('contacts.sendHuman', { ...request, text: 'different' }))).toThrow('requestId');
    expect(await thrown(ac.call('collaboration.send', request))).toThrow();
    await bc.call('contacts.revoke', { coreId: aid, projectId: b.core.threads.require(bt.threadId).projectId! });
    const denied = await ac.call('contacts.sendHuman', { ...request, requestId: 'after-revoke' });
    await waitFor(() => a.core.coordination.get(at.threadId).messages.find(l => l.id === denied.id)?.status === 'rejected');
  } finally { phone.close(); agent.close(); }
}, 30000);

test('human admission binds the exact source project and rechecks a revoked association', async () => {
  const {a,b,ac,bc,at,bt,bid,to}=await pair();
  await waitFor(() => a.core.contacts.find(bid)?.capabilities?.humanLetters === 1);
  const ap=a.core.threads.require(at.threadId).projectId!,bp=b.core.threads.require(bt.threadId).projectId!;
  const offered=await ac.call('sharedProjects.offer',{coreId:bid,projectId:ap,remote:{ownerCoreId:bid,coreId:bid,projectId:bp},requestId:'association'});
  await bc.call('sharedProjects.decide',{sharedProjectId:offered.shared.id,accept:true,requestId:'accept'});
  await waitFor(() => a.core.sharedProjects.require(offered.shared.id).state==='active');
  const path=join(a.dataDir,'unassociated');mkdirSync(path);
  const project=await ac.call('projects.add',{path,name:'Unassociated project'});
  const unrelated=await ac.call('threads.create',{projectId:project.id,providerId:'echo',accountId:at.accountId,title:'Unassociated source'});
  expect(await thrown(ac.call('contacts.sendHuman',{threadId:unrelated.id,to,text:'Wrong source',requestId:'wrong-source'}))).toThrow('source project association');
  const letter=await ac.call('contacts.sendHuman',{threadId:at.threadId,to,text:'Scoped human mail',requestId:'scoped'});
  expect(letter.sharedProjectId).toBe(offered.shared.id);
  expect(letter.from.sharedThread?.project.projectId).toBe(ap);
  await bc.call('sharedProjects.revoke',{sharedProjectId:offered.shared.id,requestId:'revoke'});
  await waitFor(() => a.core.sharedProjects.require(offered.shared.id).state==='revoked');
  expect(await thrown(ac.call('contacts.sendHuman',{threadId:at.threadId,to,text:'After revoke',requestId:'revoked'}))).toThrow();
},30000);

test('human letters require negotiated support and cannot impersonate owner input through collaboration.send', async () => {
  const { a, b, ac, bc, at, bt, aid, bid, to } = await pair();
  a.core.contacts.synced(bid, { offers: [], capabilities: { sharedProjects: 1 } });
  expect(await thrown(ac.call('contacts.sendHuman', { threadId: at.threadId, to, text: 'legacy', requestId: 'old' }))).toThrow('humanLetters');
  await ac.call('contacts.settings', { settings: { minTier: 2 } });
  await bc.call('contacts.settings', { settings: { minTier: 2 } });
  const sent = await ac.call('collaboration.send', { threadId: at.threadId, to, text: 'agent', requestId: 'spoof', origin: 'contact-human' } as never);
  await waitFor(() => b.core.coordination.get(bt.threadId).messages.some(l => l.id === sent.id));
  expect(b.core.coordination.get(bt.threadId).messages.find(l => l.id === sent.id)?.origin).not.toBe('contact-human');
  const peer = a.core.contacts.peers().find(p => p.coreId === bid)!;
  expect(await thrown(a.core.coordination.request(peer, 'deliver', { ...sent, id: 'forged-owner', origin: 'user' }))).toThrow('origin');
  expect(await thrown(ac.call('contacts.sendHuman', { threadId: at.threadId, to: { coreId: aid, threadId: at.threadId }, text: 'local', requestId: 'local' }))).toThrow();
}, 30000);
