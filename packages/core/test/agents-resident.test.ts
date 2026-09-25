import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { AgentProfile, AgentRuntimeConfig } from '@boite/contracts';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { Core } from '../src/core.ts';
import { SCHEMA_VERSION } from '../src/journal.ts';
import { nextOccurrence } from '../src/agents/routines.ts';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { connect } from '../src/client.ts';
let h: TestCore;
let agent: AgentProfile;
let client: Awaited<ReturnType<TestCore['connect']>>;
beforeEach(async () => {
 h = await startTestCore(); client = await h.connect();
 h.core.workforce.setLimits({ paused: true, backgroundConcurrency: 2, kebaccExperiment: false });
 const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
 agent = await client.call('agents.profile.save', { value: { name:'Resident', domain:'Research', instructions:'Keep useful notes.', avatar:'', status:'active', tools:['memory','messages','decisions'], accountIntegration:'provider', selection:{providerId:'echo',accountId:account.id,model:'echo',effort:null,permissionMode:'default'} } });
});
afterEach(async () => { await h?.stop(); });
function policy(): AgentRuntimeConfig { return { defaultRoute:agent.selection,allowedRoutes:[{...agent.selection,model:'echo',id:'main',name:'Main'}], subagents:structuredClone(DEFAULT_DELEGATION_CONFIG),compactAfterTurns:8,maxRunMinutes:10 }; }
function unpause(){h.core.workforce.setLimits({paused:false,backgroundConcurrency:2,kebaccExperiment:false});}
test('each identity owns a durable brain, with revision-checked edits',async()=>{
 const brain = await client.call('agents.brain.get',{agentId:agent.id});
 expect(existsSync(brain.path)).toBe(true);
 const saved = await client.call('agents.brain.save',{agentId:agent.id,expectedRevision:brain.revision,instructions:'Always verify sources.',memory:'Keep the prototype private.'});
 expect(saved.memory).toBe('Keep the prototype private.');
 await expect(client.call('agents.brain.save',{agentId:agent.id,expectedRevision:brain.revision,instructions:'stale',memory:''})).rejects.toThrow('revision');
});
test('default route must be allowed; account grants restrict identity and child routes',async()=>{
 await expect(client.call('agents.runtime.configure',{agentId:agent.id,expectedRevision:agent.revision,config:{...policy(),allowedRoutes:[]}})).rejects.toThrow('default');
 await client.call('agents.accounts.set',{grants:[{accountId:agent.selection.accountId,agentIds:[]}]});
 await expect(client.call('agents.runtime.configure',{agentId:agent.id,expectedRevision:agent.revision,config:policy()})).rejects.toThrow('account');
});

test('removing an account drops its grant, so later grant edits still apply',async()=>{
 const spare=await client.call('accounts.add',{providerId:'echo',label:'Spare'});
 await client.call('agents.accounts.set',{grants:[{accountId:spare.id,agentIds:[]}]});
 await client.call('accounts.remove',{accountId:spare.id});
 const {accountGrants}=await client.call('agents.snapshot',{});
 expect(accountGrants).toEqual([]);
 expect(await client.call('agents.accounts.set',{grants:accountGrants})).toEqual([]);
});

test('paired clients receive resident updates and cannot impersonate agents or change model policy', async () => {
 const {grant}=await client.call('pairing.grant',{});
 const remote=await connect(h.url,'',{grant,client:{name:'Remote PC',version:'test'}});
 try {
  const changed=remote.next('agents.changed',()=>true,2000);
  const sent=await remote.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:'From remote client',requestId:'remote-message-001'});
  await changed;
  expect(sent.senderId).toBeNull();
  expect((await remote.call('agents.snapshot',{})).work).toHaveLength(1);
  expect((await remote.call('agents.runtime.get',{agentId:agent.id})).defaultRoute.model).toBe('echo');
  await expect(remote.call('agents.message.send',{threadId:'not-my-session',scope:{kind:'agent',id:agent.id},recipientIds:[],text:'Impersonation',requestId:'remote-message-002'})).rejects.toThrow('threadId');
  await expect(remote.call('agents.runtime.configure',{agentId:agent.id,expectedRevision:agent.revision,config:policy()})).rejects.toThrow('owner');
 } finally { remote.close(); }
});

test('the main model and helper model have independent allowlists', async () => {
 const provider=h.core.providers.require('echo');
 provider.models.push({...provider.models[0]!,id:'helper',name:'Helper',default:false});
 const config=policy();
 config.subagents={...config.subagents,enabled:true,profiles:[{...config.allowedRoutes[0]!,id:'helper',model:'helper'}]};
 agent=await client.call('agents.runtime.configure',{agentId:agent.id,expectedRevision:agent.revision,config});
 expect(h.core.workforce.resident.allowed(agent.id,{...agent.selection,model:'helper'})).toBe(false);
 expect(h.core.workforce.resident.allowed(agent.id,{...agent.selection,model:'helper'},true)).toBe(true);
 expect(h.core.workforce.resident.allowed(agent.id,agent.selection,true)).toBe(false);
 unpause();
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:'Prepare one task',requestId:'helper-main-001'});
 await waitFor(()=>h.core.workforce.records.list('work').some(w=>w.status==='done'));
 const session=h.core.workforce.records.list('session')[0]!;
 const child=await client.call('delegation.spawn',{threadId:session.threadId,profileId:'helper',task:'Check one fact',requestId:'helper-spawn-001'});
 expect(child.thread.model).toBe('helper');
 await client.call('agents.accounts.set',{grants:[{accountId:agent.selection.accountId,agentIds:[]}]});
 expect(h.core.workforce.resident.allowed(agent.id,child.thread,true)).toBe(false);
});
test('missed routine creates one durable work item, never overlaps or catches up in a burst',async()=>{
 const routine = await client.call('agents.routine.save',{value:{agentId:agent.id,name:'Daily review',prompt:'Review new ideas',schedule:{kind:'interval',everyMinutes:60},enabled:true,nextAt:Date.now()-86400000,lastWorkId:null,lastScheduledAt:null}});
 const p={routineId:routine.id,requestId:'routine-once-001'};
 const first=await client.call('agents.routine.run',p);
 expect((await client.call('agents.routine.run',p)).id).toBe(first.id);
 await expect(client.call('agents.routine.run',{...p,requestId:'routine-once-002'})).rejects.toThrow('unfinished');
 expect((await client.call('agents.snapshot',{})).work).toHaveLength(1);
});

test('routine results appear once in the identity conversation', async () => {
 const routine=await client.call('agents.routine.save',{value:{agentId:agent.id,name:'Proposal',prompt:'A private puzzle prototype proposal',schedule:{kind:'interval',everyMinutes:60},enabled:false,nextAt:null,lastWorkId:null,lastScheduledAt:null}});
 const request={routineId:routine.id,requestId:'routine-result-001'};
 const work=await client.call('agents.routine.run',request);
 unpause();
 await waitFor(()=>h.core.workforce.records.get('work',work.id).status==='done');
 await client.call('agents.routine.run',request);
 const messages=h.core.workforce.records.list('message');
 expect(messages).toHaveLength(1);
 expect(messages[0]?.senderId).toBe(agent.id);
 expect(messages[0]?.text).toContain('puzzle prototype proposal');
 expect(messages[0]?.scope).toEqual({kind:'agent',id:agent.id});
});
test('a routine run keeps its prompt once: receipts and events name the record, and a replay reads it back',async()=>{
 // The echo agent would stream 16,000 characters back for seconds: the run sleeps and is cancelled instead.
 const prompt=`[sleep:60000]${'p'.repeat(16000-13)}`;
 const routine=await client.call('agents.routine.save',{value:{agentId:agent.id,name:'Long',prompt,schedule:{kind:'interval',everyMinutes:60},enabled:false,nextAt:null,lastWorkId:null,lastScheduledAt:null}});
 const since=(h.core.journal.db.query('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as {id:number}).id;
 const request={routineId:routine.id,requestId:'routine-long-001'};
 const work=await client.call('agents.routine.run',request);
 unpause();
 await waitFor(()=>h.core.workforce.records.list('run').some(r=>r.workId===work.id&&r.status==='running'));
 const running=h.core.workforce.records.get('work',work.id);
 await client.call('agents.work.control',{workId:work.id,expectedRevision:running.revision,action:'cancel'});
 await waitFor(()=>h.core.workforce.records.get('work',work.id).status==='cancelled'&&h.core.workforce.records.list('run').every(r=>r.status!=='running'));
 const receipt=h.core.journal.db.query('SELECT result, created_at FROM agent_requests WHERE request_id = ?').get(request.requestId) as {result:string;created_at:number};
 expect(receipt.result.length).toBeLessThan(1024);
 expect(receipt.created_at).toBeGreaterThan(0);
 const events=h.core.journal.db.query("SELECT payload FROM events WHERE type = 'agents.record' AND id > ?").all(since) as {payload:string}[];
 expect(events.length).toBeGreaterThan(3);
 for(const event of events)expect(event.payload.length).toBeLessThan(1024);
 const replayed=await client.call('agents.routine.run',request);
 expect(replayed).toEqual(h.core.workforce.records.get('work',work.id));
 expect(replayed.prompt).toBe(prompt);
 expect(replayed.status).toBe('cancelled');
 // A receipt past the retention is dropped by the next command.
 h.core.journal.db.query('UPDATE agent_requests SET created_at = 1 WHERE request_id = ?').run(request.requestId);
 (h.core.workforce.records as unknown as {pruned:number}).pruned=0;
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:'After the prune',requestId:'routine-long-002'});
 expect(h.core.journal.db.query('SELECT 1 FROM agent_requests WHERE request_id = ?').get(request.requestId)).toBeNull();
});
test('brain and checkpoint survive compaction without publishing the summary as a reply',async()=>{
 unpause();
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[agent.id],text:'Remember the prototype is a puzzle game.',requestId:'context-first-001'});
 await waitFor(()=>h.core.workforce.records.list('work').some(w=>w.status==='done'));
 const session=h.core.workforce.records.list('session')[0]!;
 const count=h.core.workforce.records.list('message').length;
 const work=await client.call('agents.context.compact',{sessionId:session.id,requestId:'context-compact-001'});
 await waitFor(()=>h.core.workforce.records.get('work',work.id).status==='done');
 expect(h.core.threads.require(session.threadId).sessionId).toBeNull();
 expect(h.core.workforce.records.list('message')).toHaveLength(count);
 expect(h.core.journal.getSetting(`agents:checkpoint:${session.id}`)).toBeTruthy();
});
test('subagents use their own approved routes on a projectless persistent session',async()=>{
 const config=policy();config.subagents={...config.subagents,enabled:true,profiles:config.allowedRoutes};
 agent=await client.call('agents.runtime.configure',{agentId:agent.id,expectedRevision:agent.revision,config});
 unpause();
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[agent.id],text:'Prepare research',requestId:'delegate-main-001'});
 await waitFor(()=>h.core.workforce.records.list('work').some(w=>w.status==='done'));
 const session=h.core.workforce.records.list('session')[0]!;
 const child=await client.call('delegation.spawn',{threadId:session.threadId,profileId:'main',task:'Check one source',requestId:'delegate-child-001'});
 expect(child.thread.projectId).toBeNull();
 await waitFor(()=>h.core.workforce.records.list('work').filter(w=>w.status==='done').length>=2,5000);
});

test('revoking an account stops active work and holds queued work until explicit review', async () => {
 unpause();
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:'[sleep:60000]',requestId:'revoke-running-001'});
 await waitFor(()=>h.core.workforce.records.list('run').some(r=>r.status==='running'));
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:'Queued request',requestId:'revoke-queued-001'});
 await client.call('agents.accounts.set',{grants:[{accountId:agent.selection.accountId,agentIds:[]}]});
 await waitFor(()=>h.core.workforce.records.list('work').every(w=>w.status==='paused'));
 expect(h.core.workforce.records.list('run')).toHaveLength(1);
 agent=await client.call('agents.profile.save',{id:agent.id,expectedRevision:agent.revision,value:{...agent,status:'paused'}});
 expect(agent.status).toBe('paused');
});

test('automatic compaction keeps the pending request and starts it in a fresh context', async () => {
 agent=await client.call('agents.runtime.configure',{agentId:agent.id,expectedRevision:agent.revision,config:{...policy(),compactAfterTurns:2}});
 unpause();
 for(let i=0;i<3;i++){
  await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:`Question ${i}`,requestId:`automatic-compact-${i}`});
  await waitFor(()=>h.core.workforce.records.list('work').filter(w=>w.purpose!=='compaction'&&w.status==='done').length===i+1,10000);
 }
 expect(h.core.workforce.records.list('work').filter(w=>w.purpose==='compaction'&&w.status==='done')).toHaveLength(1);
 expect(h.core.workforce.records.list('message').filter(m=>m.senderId===agent.id)).toHaveLength(3);
 const latest=h.core.workforce.records.list('run').at(-1)!;
 expect(latest.context.instructions).toContain('Continuation note');
 expect(latest.context.instructions).toContain('Question 2');
}, 15000);

test('restart preserves the brain and catches up one due routine without duplicate work', async () => {
 const brain=h.core.workforce.resident.brain(agent.id);
 h.core.workforce.resident.saveBrain({agentId:agent.id,expectedRevision:brain.revision,instructions:'Review evidence',memory:'Private notes'});
 const routine=h.core.workforce.routines.save({value:{agentId:agent.id,name:'Overdue',prompt:'Review once',schedule:{kind:'once',at:Date.now()-60000},enabled:true,nextAt:null,lastWorkId:null,lastScheduledAt:null}});
 await h.server.stop(); await h.core.close();
 const restarted=new Core({dataDir:h.dataDir,token:h.token});
 try {
  expect(restarted.workforce.resident.brain(agent.id).memory).toBe('Private notes');
  restarted.workforce.setLimits({...restarted.workforce.limits(),paused:false});
  restarted.workforce.routines.tick(); restarted.workforce.routines.tick();
  expect(restarted.workforce.records.list('work')).toHaveLength(1);
  expect(restarted.workforce.records.get('routine',routine.id).enabled).toBe(false);
 } finally { await restarted.close(); }
});

test('daily routines run once per local date across the autumn clock change', () => {
 const next=nextOccurrence({kind:'daily',time:'02:30',timezone:'Europe/Paris'},Date.parse('2026-10-25T00:30:00Z'));
 expect(new Date(next!).toISOString()).toBe('2026-10-26T01:30:00.000Z');
});

test('schema 14 from the earlier persistent branch upgrades without losing projectless sessions', async () => {
 unpause();
 await client.call('agents.message.send',{scope:{kind:'agent',id:agent.id},recipientIds:[],text:'Preserve this history',requestId:'migration-history-001'});
 await waitFor(()=>h.core.workforce.records.list('work').some(w=>w.status==='done'));
 const session=h.core.workforce.records.list('session')[0]!;
 await h.server.stop(); await h.core.close();
 const db=new Database(join(h.dataDir,'journal.db'));
 db.exec('DROP TABLE delegated_agents; DROP TABLE delegation_messages; DROP INDEX threads_parent; ALTER TABLE threads DROP COLUMN parent_thread_id; ALTER TABLE threads DROP COLUMN prompt_cache; PRAGMA user_version=14');
 db.close();
 const next=new Core({dataDir:h.dataDir,token:h.token});
 try {
  const thread=next.threads.get(session.threadId);
  expect(thread.projectId).toBeNull();
  expect(thread.agentSessionId).toBe(session.id);
  expect(thread.turns).toHaveLength(1);
  expect(next.workforce.records.get('profile',agent.id).name).toBe(agent.name);
  expect(next.journal.db.query('PRAGMA user_version').get()).toEqual({user_version:SCHEMA_VERSION});
 } finally { await next.close(); }
});
