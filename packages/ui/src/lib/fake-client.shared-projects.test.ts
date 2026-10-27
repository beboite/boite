import { afterEach, expect, test } from 'vitest';
import { CONVERSATION_PROFILE_ID, RpcErrorCode } from '@boite/contracts';
import { FakeClient, type FakeClientOptions } from './fake-client';
import { sharedPair as createSharedPair } from '../test/shared-projects';

const clients:FakeClient[]=[];
async function sharedPair(options:FakeClientOptions={}){const pair=await createSharedPair(options);clients.push(pair.a,pair.b);return pair;}
afterEach(()=>{for(const client of clients.splice(0))client.close();});

test('a group member owns its association, public worker address, read consent and revocation', async () => {
  const {a,b,aid,bid,ap,bp,at} = await sharedPair();
  const member = new FakeClient({delayMs:0,coreId:'c'.repeat(64)}); clients.push(member); await member.connect();
  await b.call('group.create', {name:'Shared host group'});
  await member.call('group.join', {invite:(await b.call('group.invite', {})).invite});
  const mp=(await member.call('projects.list', {}))[0]!,mt=(await member.call('threads.list', {projectId:mp.id})).find(t=>!t.archived)!;
  await b.call('contacts.grant', {coreId:aid,projectId:mp.id,machine:member.core!.coreId!});
  const ref={ownerCoreId:bid,coreId:member.core!.coreId!,projectId:mp.id};
  expect((await a.call('contacts.get', {})).contacts.find(c=>c.coreId===bid)!.offers.some(o=>JSON.stringify(o.sharedProject)===JSON.stringify(ref))).toBe(true);
  const offered=await a.call('sharedProjects.offer', {coreId:bid,projectId:ap.id,remote:ref,requestId:'member-offer'});
  await member.call('sharedProjects.decide', {sharedProjectId:offered.shared.id,accept:true,requestId:'member-accept'});
  const scope={threadId:at.id,sharedProjectId:offered.shared.id},mscope={...scope,threadId:mt.id};
  expect((await b.call('sharedProjects.list', {threadId:mt.id})).some(s=>s.shared.id===offered.shared.id)).toBe(false);
  const target=(await a.call('sharedProjects.threads',scope)).threads.find(t=>t.ref.project.coreId===ref.coreId)!;
  expect(target.ref.address).toEqual({coreId:bid,threadId:`${target.ref.threadId}~${ref.coreId.slice(0,16)}`});
  expect(await a.call('sharedProjects.read',{...scope,target:target.ref}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  await b.call('contacts.grant',{coreId:aid,projectId:mp.id,machine:ref.coreId,readThreads:true});
  expect((await a.call('sharedProjects.read',{...scope,target:target.ref})).contact.sharedThread).toEqual(target.ref);
  const human=await a.call('contacts.sendHuman',{threadId:at.id,to:target.ref.address,text:'Member human message',requestId:'member-human'});
  expect((await member.call('collaboration.get',{threadId:target.ref.threadId})).messages.find(l=>l.id===human.id)?.origin).toBe('contact-human');
  const reverse=await member.call('contacts.sendHuman',{threadId:mt.id,to:{coreId:aid,threadId:at.id},text:'Member reply',requestId:'member-reply'});
  expect((await a.call('collaboration.get',{threadId:at.id})).messages.find(l=>l.id===reverse.id)?.from.sharedThread?.project).toEqual(ref);
  for (const side of [a,member]) await side.call('sharedProjects.configure',{sharedProjectId:scope.sharedProjectId,board:true});
  const add=await a.call('sharedBoard.apply',{...scope,command:{kind:'add',requestId:'member-add',cardId:'member-card',text:'Member work'}});
  expect((await member.call('sharedBoard.apply',{...mscope,command:{kind:'claim',requestId:'member-claim',cardId:'member-card',expectedRevision:add.revision,worker:target.ref}})).outcome).toBe('applied');
  await b.call('contacts.revoke',{coreId:aid,projectId:mp.id,machine:ref.coreId});
  expect((await member.call('sharedProjects.get',mscope)).shared.state).toBe('revoked');
  expect((await a.call('sharedProjects.get',scope)).shared.state).toBe('revoked');
  await expect(a.call('collaboration.send',{threadId:at.id,to:target.ref.address,text:'Do not fall back to ordinary contact mail',requestId:'revoked-member-agent'})).rejects.toMatchObject({code:RpcErrorCode.Refused});
  expect((await b.call('contacts.get',{})).contacts.find(c=>c.coreId===aid)!.grants.some(g=>g.projectId===bp.id&&!g.machine)).toBe(true);
});

test('colliding ids stay canonical; transcript grants, owner administration and phone/agent rights agree',async()=>{
  const {a,b,as,bs,bid,aid,bp}=await sharedPair();
  const directory=await a.call('sharedProjects.threads',as),remote=directory.threads.find(t=>t.ref.project.coreId===bid)!;
  expect(remote.ref.threadId).toBe(directory.threads.find(t=>t.ref.project.coreId===aid)?.ref.threadId);
  expect(directory.unavailable).toEqual([]);
  expect(await a.call('sharedProjects.read',{...as,target:remote.ref}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  await b.call('contacts.grant',{coreId:aid,projectId:bp.id,readThreads:true});
  expect((await a.call('sharedProjects.read',{...as,target:remote.ref})).contact.coreId).toBe(bid);
  b.becomes('session');
  expect((await b.call('sharedProjects.get',bs)).shared.state).toBe('active');
  for(const method of ['sharedCompute.host','sharedAccess.reviewConfig','sharedAccess.overrides','sharedProjects.configure','sharedProjects.revoke','sharedCompute.start'] as const)expect(await b.call(method,{...bs,requestId:'phone'} as never).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  a.becomes('agent');expect(await a.call('contacts.sendHuman',{threadId:as.threadId,to:remote.ref.address,text:'impersonation',requestId:'agent'}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
});

test('bilateral boards arbitrate races, keep terminal deletes, queue offline edits and release subscriptions',async()=>{
  const {a,b,as,bs,bid}=await sharedPair();
  expect(await a.call('sharedBoard.get',as).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  await a.call('sharedProjects.configure',{sharedProjectId:as.sharedProjectId,board:true});await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,board:true});
  await a.call('sharedProjects.subscribe',{...as,enabled:true});await b.call('sharedProjects.subscribe',{...bs,enabled:true});
  const add={requestId:'add',cardId:'collision-card',kind:'add' as const,text:'Shared task'};
  const added=await a.call('sharedBoard.apply',{...as,command:add});
  expect(await a.call('sharedBoard.apply',{...as,command:add})).toEqual(added);
  expect((await b.call('sharedBoard.get',bs)).kind).toBe('snapshot');
  const ad=(await a.call('sharedProjects.threads',as)).threads.find(t=>t.ref.project.coreId===a.core!.coreId)!;
  const bd=(await b.call('sharedProjects.threads',bs)).threads.find(t=>t.ref.project.coreId===bid)!;
  const claims=await Promise.all([a.call('sharedBoard.apply',{...as,command:{kind:'claim',cardId:add.cardId,requestId:'claim-a',expectedRevision:added.card!.revision,worker:ad.ref}}),b.call('sharedBoard.apply',{...bs,command:{kind:'claim',cardId:add.cardId,requestId:'claim-b',expectedRevision:added.card!.revision,worker:bd.ref}})]);
  expect(claims.map(c=>c.outcome).sort()).toEqual(['applied','conflict']);
  await a.call('sharedBoard.apply',{...as,command:{kind:'remove',cardId:add.cardId,requestId:'remove'}});
  expect((await b.call('sharedBoard.apply',{...bs,command:{...add,requestId:'resurrect'}})).outcome).toBe('deleted');
  b.setContactConnected(a.core!.coreId!,false);
  expect((await b.call('sharedBoard.apply',{...bs,command:{...add,cardId:'offline',requestId:'offline'}})).outcome).toBe('queued');
  expect((await b.call('sharedBoard.get',bs))).toMatchObject({kind:'snapshot',authorityAvailable:false,cards:[{id:'offline',pending:true}]});
  b.setContactConnected(a.core!.coreId!,true);
  expect((await a.call('sharedBoard.get',as))).toMatchObject({kind:'snapshot',cards:[{id:'offline'}]});
  b.drop();expect(b.sharedSubscriptions).toEqual([]);await b.restore();expect(b.sharedSubscriptions).toEqual([]);
  await a.call('sharedProjects.revoke',{sharedProjectId:as.sharedProjectId,requestId:'revoke'});
  expect(a.sharedSubscriptions).toEqual([]);
  expect(await b.call('sharedBoard.get',bs).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
});

test('human mail uses the destination contact name; provenance is not RPC input and retries bind content',async()=>{
  const {a,b,aid,bid,as,bs}=await sharedPair();
  await b.call('contacts.update',{coreId:aid,name:'Local person'});
  const request={threadId:as.threadId,to:{coreId:bid,threadId:bs.threadId},text:'Human instruction for shared work',requestId:'human'};
  a.becomes('session');const sent=await a.call('contacts.sendHuman',request);
  expect(sent.origin).toBe('contact-human');expect(sent.from.agent).toBeUndefined();
  const incoming=(await b.call('collaboration.get',{threadId:bs.threadId})).messages.find(l=>l.id===sent.id)!;
  expect(incoming.contact?.name).toBe('Local person');expect(incoming.origin).toBe('contact-human');
  expect((await a.call('contacts.sendHuman',request)).id).toBe(sent.id);
  expect(await a.call('contacts.sendHuman',{...request,text:'changed'}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  expect((await b.call('threads.get',{threadId:bs.threadId})).messages.every(m=>!m.parts.some(p=>p.type==='text'&&p.text===request.text))).toBe(true);
});

test('native capability fixtures retain host mode/account and leave unsupported adapters refused',async()=>{
  const {a,b,ap,bp,as,bs,remote}=await sharedPair();
  await a.call('contacts.settings',{settings:{minTier:2}});
  const base='b'.repeat(40);a.setSharedRepository(ap.id,'https://example.test/shared.git',base);b.setSharedRepository(bp.id,'https://example.test/shared.git',base);
  const nativeSeen:string[]=[];
  const accounts=await b.call('accounts.list',{}),{loaded:providers}=await b.call('providers.list',{});
  for(const protocol of ['claude-sdk','codex-appserver','muse','acp','pi'] as const){
    const provider=providers.find(p=>p.protocol===protocol&&p.available);
    if(!provider)continue;
    const account=accounts.find(a=>a.providerId===provider.id)!;
    const parent=await b.call('threads.create',{projectId:bp.id,providerId:provider.id,accountId:account.id});
    await b.call('delegation.configure',{threadId:parent.id,config:{enabled:true,paused:false,profiles:[]}});
    const mode=protocol==='acp'?'default':'yolo';
    if(protocol==='acp'){
      await expect(b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,computeThreadId:parent.id,compute:{enabled:true,profiles:['conversation'],permissionMode:'yolo',maxConcurrent:null}})).rejects.toMatchObject({code:RpcErrorCode.Refused});
      if(provider.id!=='opencode')continue;
    }
    await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,computeThreadId:parent.id,compute:{enabled:true,profiles:['conversation'],permissionMode:mode,maxConcurrent:null}});
    b.setSharedNativeExecution(false);
    expect((await a.call('sharedCompute.models',{...as,host:remote}))[0]?.protection.supported).toBe(false);
    b.setSharedNativeExecution(true);
    expect((await a.call('sharedCompute.models',{...as,host:remote}))[0]).toMatchObject({providerId:provider.id,permissionMode:mode,protection:{supported:true,boundary:'isolated-process'}});
    nativeSeen.push(protocol);
    const job=await a.call('sharedCompute.start',{...as,host:remote,profileId:'conversation',baseCommit:base,requestId:protocol,task:'Synthetic protected native fixture'});
    expect(job).toMatchObject({providerId:provider.id,permissionMode:mode});
    expect((await b.call('threads.list',{projectId:bp.id})).find(t=>t.id===job.worker!.threadId)?.accountId).toBe(account.id);
  }
  expect(nativeSeen).toEqual(['claude-sdk','codex-appserver','muse','acp','pi']);
});

test('compute uses the selected host profile, refuses unsafe execution, scopes jobs and revokes results',async()=>{
  const {a,b,ap,bp,aid,bid,as,bs,remote}=await sharedPair();
  await a.call('contacts.settings',{settings:{minTier:2}});
  const echo=(await b.call('accounts.list',{})).find(a=>a.providerId==='echo')!;
  const parent=await b.call('threads.create',{projectId:bp.id,providerId:'echo',accountId:echo.id,title:'Host team'});
  await b.call('delegation.configure',{threadId:parent.id,config:{enabled:true,paused:false,profiles:[]}});
  await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,computeThreadId:parent.id,compute:{enabled:true,profiles:[CONVERSATION_PROFILE_ID],permissionMode:'default',maxConcurrent:null}});
  const base='a'.repeat(40);a.setSharedRepository(ap.id,'https://example.test/shared.git',base);b.setSharedRepository(bp.id,'https://example.test/shared.git',base);
  const models=await a.call('sharedCompute.models',{...as,host:remote});expect(models[0]).toMatchObject({protocol:'echo',protection:{supported:true,boundary:'no-tools'}});
  const input={...as,requestId:'compute',host:remote,profileId:CONVERSATION_PROFILE_ID,task:'Work on this repository',baseCommit:base};
  const job=await a.call('sharedCompute.start',input);expect(job.worker?.project.coreId).toBe(bid);expect(job.source.project.coreId).toBe(aid);
  await b.call('files.write',{threadId:bs.threadId,path:'.env',text:'password=compute-fixture'});
  expect((await b.call('files.read',{threadId:bs.threadId,path:'.env'})).kind).toBe('text');
  expect(await b.call('files.read',{threadId:job.worker!.threadId,path:'.env'}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  const permit=await b.call('sharedAccess.override',{sharedProjectId:bs.sharedProjectId,requestId:'job-file',override:{jobId:job.id,path:'.env',actions:['read'],reason:'Exact job fixture',expiresAt:Date.now()+60000}});
  expect((await b.call('files.read',{threadId:job.worker!.threadId,path:'.env'})).kind).toBe('text');
  await b.call('sharedAccess.revokeOverride',{sharedProjectId:bs.sharedProjectId,overrideId:permit.id});
  expect(await b.call('files.read',{threadId:job.worker!.threadId,path:'.env'}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  const other=await a.call('sharedProjects.offer',{coreId:bid,projectId:ap.id,remote,requestId:'another-association'});
  await b.call('sharedProjects.decide',{sharedProjectId:other.shared.id,accept:true,requestId:'another-accept'});
  expect((await b.call('sharedProjects.list',{threadId:job.worker!.threadId})).map(v=>v.shared.id)).toEqual([bs.sharedProjectId]);
  expect(await b.call('sharedProjects.get',{threadId:job.worker!.threadId,sharedProjectId:other.shared.id}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  expect((await a.call('sharedCompute.start',input)).id).toBe(job.id);
  expect((await a.call('sharedCompute.list',as)).length).toBe(1);
  a.setContactConnected(bid,false);
  expect(await a.call('sharedCompute.get',{...as,jobId:job.id}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  const pending=await a.call('sharedCompute.cancel',{...as,jobId:job.id,requestId:'offline-cancel'});
  expect(pending).toMatchObject({status:'uncertain',error:'Cancellation pending',result:null});
  a.setContactConnected(bid,true);
  expect(await a.call('sharedCompute.get',{...as,jobId:job.id})).toMatchObject({status:'cancelled'});
  const second=await a.call('sharedCompute.start',{...input,requestId:'compute-again'});
  b.finishSharedCompute(second.id,'Result');const done=await a.call('sharedCompute.get',{...as,jobId:second.id});
  expect(done).toMatchObject({status:'done',result:{baseCommit:base,commit:base,repository:'https://example.test/shared.git'}});
  expect(JSON.stringify(done)).not.toMatch(/accountId|token|executable/);
  expect(await a.call('sharedCompute.cancel',{...as,jobId:second.id,requestId:'late-cancel'})).toEqual(done);
  expect(await b.call('sharedCompute.get',{...bs,jobId:second.id})).toEqual(done);
  const raced=await a.call('sharedCompute.start',{...input,requestId:'cancel-race'});
  a.setContactConnected(bid,false);
  await a.call('sharedCompute.cancel',{...as,jobId:raced.id,requestId:'held-cancel'});
  b.finishSharedCompute(raced.id,'Completed before cancellation arrived');
  a.setContactConnected(bid,true);
  expect(await a.call('sharedCompute.get',{...as,jobId:raced.id})).toMatchObject({status:'done',result:{text:'Completed before cancellation arrived'}});
  await b.call('sharedProjects.revoke',{sharedProjectId:bs.sharedProjectId,requestId:'revoke'});
  expect(await a.call('sharedCompute.get',{...as,jobId:job.id}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
});

test('shared transcript, directory and search redact credentials without exposing search hits',async()=>{
  const {a,b,as,bs,aid,bid,bp}=await sharedPair();
  await b.call('contacts.grant',{coreId:aid,projectId:bp.id,readThreads:true});
  await b.call('threads.update',{threadId:bs.threadId,title:'api_key=fixture-secret'});
  await b.call('turns.start',{threadId:bs.threadId,prompt:'password=fixture-password'});
  await b.call('turns.stop',{threadId:bs.threadId});
  const remote=(await a.call('sharedProjects.threads',as)).threads.find(t=>t.ref.project.coreId===bid&&t.ref.threadId===bs.threadId)!;
  expect(remote.agent.title).toBe('[Shared file policy withheld credential-like text]');
  const transcript=await a.call('sharedProjects.read',{...as,target:remote.ref});
  expect(JSON.stringify(transcript)).not.toMatch(/fixture-secret|fixture-password/);
  expect((await a.call('sharedProjects.search',{...as,query:'fixture-password'})).matches).toEqual([]);
});

test('shared goals publish progress to the existing board and releases preserve owner replacements',async()=>{
  const {a,b,as,bs,bp}=await sharedPair();
  await a.call('sharedProjects.configure',{sharedProjectId:as.sharedProjectId,board:true});
  await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,board:true});
  const account=(await b.call('accounts.list',{})).find(a=>a.providerId==='echo')!;
  const worker=await b.call('threads.create',{projectId:bp.id,providerId:'echo',accountId:account.id,title:'Board worker'});
  const source={...bs,threadId:worker.id};
  const ref=(await b.call('sharedProjects.threads',source)).threads.find(t=>t.ref.project.coreId===b.core!.coreId&&t.ref.threadId===worker.id)!.ref;
  const added=await a.call('sharedBoard.apply',{...as,command:{kind:'add',cardId:'goal-card',requestId:'goal-add',text:'Shared work'}});
  const claim=await b.call('sharedBoard.apply',{...source,command:{kind:'claim',cardId:'goal-card',requestId:'goal-claim',expectedRevision:added.card!.revision,worker:ref}});
  await b.call('sharedBoard.start',{...source,cardId:'goal-card',claimId:claim.card!.assignment!.claimId});
  await b.call('threads.activity.control',{threadId:worker.id,kind:'goal',action:'pause'});
  expect((await a.call('todos.list',{threadId:as.threadId})).find(t=>t.id==='goal-card')?.goal?.status).toBe('paused');
  await b.call('threads.tasks.set',{threadId:worker.id,tasks:[{id:'unrelated-task',text:'Owner task list',status:'pending'}]});
  const before=await a.call('sharedBoard.get',as);
  const released=await b.call('sharedBoard.apply',{...source,command:{kind:'release',cardId:'goal-card',requestId:'first-release',claimId:claim.card!.assignment!.claimId}});
  const delta=await a.call('sharedBoard.get',{...as,after:before.kind==='snapshot'?before.revision:before.to});
  expect(delta.kind==='delta'&&delta.changes.map(c=>c.revision)).toEqual([released.revision]);
  expect((await b.call('threads.get',{threadId:worker.id})).activity?.goal).toBeNull();
  const replacement=await b.call('sharedBoard.apply',{...source,command:{kind:'claim',cardId:'goal-card',requestId:'reclaim',expectedRevision:released.card!.revision,worker:ref}});
  await b.call('sharedBoard.start',{...source,cardId:'goal-card',claimId:replacement.card!.assignment!.claimId});
  await b.call('threads.activity.set',{threadId:worker.id,goal:{objective:'Owner replacement'}});
  await b.call('sharedBoard.apply',{...source,command:{kind:'release',cardId:'goal-card',requestId:'goal-release',claimId:replacement.card!.assignment!.claimId}});
  expect((await b.call('threads.get',{threadId:worker.id})).activity?.goal?.objective).toBe('Owner replacement');
});

test('paused contact mail is rechecked before delivery after revocation',async()=>{
  const {a,b,as,bs,bid}=await sharedPair();
  await b.call('collaboration.configure',{threadId:bs.threadId,config:{mode:'team',remote:true,paused:true,resources:''}});
  const sent=await a.call('contacts.sendHuman',{threadId:as.threadId,to:{coreId:bid,threadId:bs.threadId},text:'Pending external request',requestId:'paused'});
  expect(sent.status).toBe('received');
  await a.call('sharedProjects.revoke',{sharedProjectId:as.sharedProjectId,requestId:'revoke-pending'});
  await b.call('collaboration.configure',{threadId:bs.threadId,config:{mode:'team',remote:true,paused:false,resources:''}});
  expect((await b.call('collaboration.get',{threadId:bs.threadId})).messages.find(l=>l.id===sent.id)).toMatchObject({status:'rejected'});
});

test('an authenticated agent uses only its own source and cannot confirm a shared card or change host policy',async()=>{
  const {a,b,as,bs,ap}=await sharedPair({agentThreadId:'t-trace'});
  expect(as.threadId).toBe('t-trace');
  await a.call('contacts.settings',{settings:{minTier:3}});
  await a.call('sharedProjects.configure',{sharedProjectId:as.sharedProjectId,board:true});
  await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,board:true});
  const account=(await a.call('accounts.list',{})).find(a=>a.providerId==='echo')!;
  const other=await a.call('threads.create',{projectId:ap.id,providerId:'echo',accountId:account.id,title:'Other source'});
  a.becomes('agent');
  expect((await a.call('sharedProjects.threads',as)).threads.length).toBeGreaterThan(0);
  expect(await a.call('sharedProjects.threads',{...as,threadId:other.id}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  for(const method of ['sharedCompute.host','sharedProjects.configure','sharedProjects.revoke','sharedAccess.override','sharedAccess.reviewConfig','contacts.sendHuman'] as const)expect(await a.call(method,{...as} as never).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  const added=await a.call('sharedBoard.apply',{...as,command:{kind:'add',cardId:'agent-card',requestId:'agent-add',text:'Proposed work'}});
  expect(added.card?.createdBy.kind).toBe('agent');
  expect(await a.call('sharedBoard.apply',{...as,command:{kind:'update',cardId:'agent-card',requestId:'agent-confirm',status:'done'}}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
  expect(await a.call('sharedBoard.apply',{...as,command:{kind:'remove',cardId:'agent-card',requestId:'agent-remove'}}).catch(e=>e)).toMatchObject({code:RpcErrorCode.Refused});
});

test('host review routes and exact file overrides stay private, scoped and revocable',async()=>{
  const {a,b,as,bs}=await sharedPair();
  const account=(await b.call('accounts.list',{})).find(a=>a.providerId==='echo')!;
  await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,reviewer:{enabled:true,providerId:'echo',accountId:account.id,model:null,effort:null,revokeOnViolation:false}});
  expect(await a.call('sharedAccess.reviewConfig',{sharedProjectId:as.sharedProjectId})).toEqual({enabled:false});
  expect(await b.call('sharedAccess.reviewConfig',{sharedProjectId:bs.sharedProjectId})).toMatchObject({enabled:true,accountId:account.id});
  expect(JSON.stringify(await a.call('sharedProjects.get',as))).not.toContain('accountId');
  await b.call('files.write',{threadId:bs.threadId,path:'.env',text:'password=fixture-only'});
  const input={sharedProjectId:bs.sharedProjectId,requestId:'override',override:{path:'.env',actions:['read' as const],jobId:null,reason:'Permit exact fixture',expiresAt:Date.now()+60000}};
  const override=await b.call('sharedAccess.override',input);
  expect((await b.call('sharedProjects.get',bs)).protection?.activeOverrides).toBe(1);
  expect((await a.call('sharedProjects.get',as)).protection?.activeOverrides).toBe(0);
  await b.call('files.write',{threadId:bs.threadId,path:'.env',text:'password=replaced-fixture'});
  expect((await b.call('sharedProjects.get',bs)).protection?.activeOverrides).toBe(0);
  await b.call('sharedAccess.revokeOverride',{sharedProjectId:bs.sharedProjectId,overrideId:override.id});
  expect((await b.call('sharedAccess.overrides',{sharedProjectId:bs.sharedProjectId}))[0]?.revokedAt).not.toBeNull();
  await b.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,reviewer:{enabled:false}});
  expect(await b.call('sharedAccess.reviewConfig',{sharedProjectId:bs.sharedProjectId})).toEqual({enabled:false});
});
