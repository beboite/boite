import {sharedProtection} from './shared-compute';
/** Deterministic in-memory authority, receipts, terminal deletes and offline replica edits. */
import { TODO_STATUSES, TODO_TEXT_MAX, type SharedBoardCard, type SharedBoardChange, type SharedBoardCommand, type SharedBoardPage, type SharedBoardReceipt, type SharedProject, type SharedProjectActor, type SharedProjectScope, type SharedThreadRef, type Todo } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { fakeCore } from './coordination';
import { activityMethods } from './activity';
import { secureId } from '../secure-id';
import { assertSharedActive, cloneShared, endpoints, invalidShared, notifyShared, onceShared, projectAddress, remoteShared, refusedShared, sameProject, sharedScope, sharedState, sharedText } from './shared-state';

interface Board {revision:number; changes:SharedBoardChange[]; cards:Map<string,SharedBoardCard>; tombstones:Map<string,{id:string;revision:number;deletedAt:number}>; pending:{scope:SharedProjectScope;source:SharedProjectActor;command:SharedBoardCommand}[]; starts:Set<string>; generations:Map<string,number>}
const boards = new WeakMap<FakeContext,Map<string,Board>>();
function boardOf(ctx:FakeContext,id:string):Board {
  let map=boards.get(ctx); if(!map){map=new Map();boards.set(ctx,map);}
  let board=map.get(id); if(!board){board={revision:0,changes:[],cards:new Map(),tombstones:new Map(),pending:[],starts:new Set(),generations:new Map()};map.set(id,board);}
  return board;
}
function check(ctx:FakeContext,p:SharedProjectScope){const scope=sharedScope(ctx,p); if(!scope.shared.access.every(a=>a.board))throw refusedShared('sharedBoard: both project owners must enable board access');return scope;}
function authority(ctx:FakeContext,s:SharedProject):FakeContext|undefined{return sameProject(endpoints(ctx,s).local,s.authority)?ctx:remoteShared(ctx,s);}
function integer(n:unknown,min=0):number{if(!Number.isSafeInteger(n)||(n as number)<min)throw invalidShared('revision: expected a safe nonnegative integer');return n as number;}
function commandOf(c:SharedBoardCommand):SharedBoardCommand {
  const base={requestId:sharedText(c?.requestId,'command.requestId'),cardId:sharedText(c?.cardId,'command.cardId',128)};
  if(c.kind==='add')return {...base,kind:c.kind,text:sharedText(c.text,'command.text',TODO_TEXT_MAX)};
  if(c.kind==='update'){
    if(c.status!==undefined&&!TODO_STATUSES.includes(c.status))throw invalidShared('command.status: expected open, claimed or done');
    if(c.text===undefined&&c.status===undefined)throw invalidShared('command.update: expected text or status');
    return {...base,kind:c.kind,...(c.text===undefined?{}:{text:sharedText(c.text,'command.text',TODO_TEXT_MAX)}),...(c.status===undefined?{}:{status:c.status})};
  }
  if(c.kind==='remove')return {...base,kind:c.kind};
  if(c.kind==='claim')return {...base,kind:c.kind,expectedRevision:integer(c.expectedRevision,1),worker:cloneShared(c.worker)};
  if(c.kind==='release')return {...base,kind:c.kind,claimId:sharedText(c.claimId,'command.claimId')};
  throw invalidShared('command.kind: expected add, update, remove, claim or release');
}
function append(board:Board,change:SharedBoardChange):void {
  board.revision=change.revision;board.changes.push(cloneShared(change));
  if(change.kind==='deleted'){board.cards.delete(change.tombstone.id);board.tombstones.set(change.tombstone.id,change.tombstone);}
  else if(!board.tombstones.has(change.card.id))board.cards.set(change.card.id,change.card);
}
const sameWorker=(a:SharedThreadRef,b:SharedThreadRef)=>sameProject(a.project,b.project)&&a.threadId===b.threadId&&a.address.coreId===b.address.coreId&&a.address.threadId===b.address.threadId;
function applied(host:FakeContext,source:SharedProjectActor,s:SharedProject,c:SharedBoardCommand):SharedBoardReceipt {
  assertSharedActive(host,s);
  const board=boardOf(host,s.id),receipt=(outcome:SharedBoardReceipt['outcome']):SharedBoardReceipt=>({requestId:c.requestId,outcome,revision:board.revision,card:board.cards.get(c.cardId)??null});
  return cloneShared(onceShared(host,`board:${s.id}:${JSON.stringify(source)}:${c.requestId}`,c,()=>{
    const old=board.cards.get(c.cardId);
    if(board.tombstones.has(c.cardId))return receipt('deleted');
    if(source.kind==='agent'&&(c.kind==='remove'||c.kind==='update'&&c.status==='done'||old?.status==='done'))throw refusedShared('board: only the user confirms, removes or reopens a confirmed card');
    if(source.kind==='agent'&&c.kind==='update'&&c.status==='claimed'&&old?.status!=='open')return receipt('conflict');
    // Match the core's existing agent card abuse boundary, not a work/exchange limit.
    if(source.kind==='agent'&&c.kind==='add'&&[...board.cards.values()].filter(c=>c.status!=='done').length>=200)throw refusedShared('board: an agent adds fewer than 200 open or claimed cards');
    if((c.kind==='add')===!!old)return receipt('conflict');
    const revision=board.revision+1,now=Date.now();
    if(c.kind==='remove'){append(board,{kind:'deleted',revision,tombstone:{id:c.cardId,revision,deletedAt:now}});return receipt('applied');}
    let card:SharedBoardCard=c.kind==='add'?{id:c.cardId,text:c.text,status:'open',revision,createdBy:source,assignment:null,goal:null,createdAt:now,updatedAt:now}:{...old!,revision,updatedAt:now};
    if(c.kind==='update')card={...card,...(c.text===undefined?{}:{text:c.text}),...(c.status===undefined?{}:{status:c.status})};
    if(c.kind==='claim'){
      const worker=c.worker,workerHost=fakeCore(worker?.project?.coreId),thread=workerHost?.threads.get(worker?.threadId);
      if(!worker||!sameProject(worker.project,source.project)||worker.address.coreId!==projectAddress(worker.project,worker.threadId).coreId||worker.address.threadId!==projectAddress(worker.project,worker.threadId).threadId||source.kind==='agent'&&worker.threadId!==source.threadId)throw refusedShared('command.worker: expected the authenticated source worker on its own host');
      if(!thread||thread.archived||thread.projectId!==worker.project.projectId)throw refusedShared('command.worker: expected an available local worker');
      if(old!.revision!==c.expectedRevision||old!.status!=='open'||old!.assignment||[...board.cards.values()].some(card=>card.assignment&&sameWorker(card.assignment.worker,worker)))return receipt('conflict');
      card.assignment={claimId:secureId(),actor:source,worker,state:'reserved',workerInfo:{agent:`${thread.providerId} ${thread.model??''}`.trim(),machine:workerHost!.identity.name}};
      card.goal=null;
    }
    if(c.kind==='release'){
      const assignment=card.assignment;
      if(!assignment||assignment.claimId!==c.claimId)return receipt('conflict');
      if(source.kind==='agent'&&JSON.stringify(source)!==JSON.stringify(assignment.actor))throw refusedShared('claimId: only the claimant agent or a user releases a reservation');
      const workerHost=fakeCore(assignment.worker.project.coreId);if(!workerHost)throw refusedShared('claimId: worker host must confirm execution stopped');
      // Fence progress before removing the goal: its activity event is synchronous.
      boardOf(workerHost,s.id).starts.add(`stopped:${c.claimId}`);
      const thread=workerHost.thread(assignment.worker.threadId); if(thread.activity?.goal&&(workerHost.activityGenerations.get(`${thread.id}:goal`)??0)===boardOf(workerHost,s.id).generations.get(c.claimId))void activityMethods(workerHost)['threads.activity.control']({threadId:thread.id,kind:'goal',action:'remove'});
      for(const ref of s.projects){const side=fakeCore(ref.coreId);if(side)sharedState(side).stopClaim?.(s.id,c.claimId,assignment.worker);}
      if(sharedState(workerHost).workerScopes.get(thread.id)===s.id)sharedState(workerHost).workerScopes.delete(thread.id);
      card={...card,assignment:null,goal:null,status:'open'};
    }
    append(board,{kind:'card',card,revision});return receipt('applied');
  }));
}
function synchronize(ctx:FakeContext,s:SharedProject):void {
  const host=authority(ctx,s),local=boardOf(ctx,s.id);
  if(!host)return;
  const main=boardOf(host,s.id);
  for(const queued of [...local.pending]){
    try{check(ctx,queued.scope);applied(host,queued.source,s,queued.command);}catch{/* Policy refusal closes the optimistic edit. */}
    local.pending.splice(local.pending.indexOf(queued),1);
  }
  if(host!==ctx)for(const change of main.changes.filter(c=>c.revision>local.revision))append(local,cloneShared(change));
}
function snapshot(board:Board):Extract<SharedBoardPage,{kind:'snapshot'}>{
  const cards=new Map([...board.cards].map(([id,c])=>[id,cloneShared(c)]));
  for(const {command:c,source} of board.pending){
    const old=cards.get(c.cardId);
    if(c.kind==='remove')cards.delete(c.cardId);
    else if(c.kind==='add'&&!old&&!board.tombstones.has(c.cardId))cards.set(c.cardId,{id:c.cardId,text:c.text,status:'open',revision:0,createdBy:source,assignment:null,goal:null,createdAt:0,updatedAt:0,pending:true});
    else if(c.kind==='update'&&old)cards.set(c.cardId,{...old,...(c.text===undefined?{}:{text:c.text}),...(c.status===undefined?{}:{status:c.status}),pending:true});
  }
  return {kind:'snapshot',revision:board.revision,cards:[...cards.values()],tombstones:[...board.tombstones.values()]};
}
export function sharedTodos(ctx:FakeContext,projectId:string):Todo[]{
  return [...sharedState(ctx).projects.values()].filter(s=>endpoints(ctx,s).local.projectId===projectId&&s.state==='active'&&s.access.every(a=>a.board)).flatMap(s=>{
    synchronize(ctx,s);return snapshot(boardOf(ctx,s.id)).cards.map(c=>({id:c.id,text:c.text,status:c.status,projectId,threadId:null,...(c.goal?{goal:c.goal}:{}),goalThreadId:c.assignment&&sameProject(c.assignment.worker.project,endpoints(ctx,s).local)?c.assignment.worker.threadId:null,createdAt:c.createdAt,updatedAt:c.updatedAt,shared:{sharedProjectId:s.id,card:c}}));
  });
}
export async function applySharedBoard(ctx:FakeContext,p:import('@boite/contracts').RpcParams<'sharedBoard.apply'>){
      const {shared,source}=check(ctx,p),command=commandOf(p.command),host=authority(ctx,shared);
      if(source.kind==='agent'&&(command.kind==='remove'||command.kind==='update'&&command.status==='done'))throw refusedShared('sharedBoard: only the user confirms or removes a card');
      if(!host){
        if(command.kind==='claim'||command.kind==='release')throw refusedShared('sharedBoard: claim authority unavailable');
        const board=boardOf(ctx,shared.id),existing=board.pending.find(e=>JSON.stringify(e.source)===JSON.stringify(source)&&e.command.requestId===command.requestId);
        if(existing&&JSON.stringify(existing.command)!==JSON.stringify(command))throw refusedShared('requestId: already used for different content');
        if(!existing)board.pending.push({scope:{threadId:p.threadId,sharedProjectId:p.sharedProjectId},source,command});
        return {requestId:command.requestId,outcome:'queued' as const,revision:board.revision,card:null};
      }
      const result=applied(host,source,shared,command);synchronize(ctx,shared);notifyShared(ctx,shared.id);return result;
}
export function sharedBoardMethods(ctx:FakeContext){
  // Read the worker's current activity, never foreign RPC progress fields.
  ctx.bus.observe('thread.activity', ({threadId}) => {
    const thread=ctx.threads.get(threadId);
    for(const shared of sharedState(ctx).projects.values()) {
      if(shared.state!=='active'||!shared.access.every(a=>a.board))continue;
      const host=authority(ctx,shared);if(!host)continue;
      const board=boardOf(host,shared.id),local=endpoints(ctx,shared).local;
      for(const card of [...board.cards.values()]) {
        const assignment=card.assignment;
        if(!assignment||!sameProject(assignment.worker.project,local)||assignment.worker.threadId!==threadId)continue;
        if(boardOf(ctx,shared.id).starts.has(`stopped:${assignment.claimId}`))continue;
        const generation=boardOf(ctx,shared.id).generations.get(assignment.claimId);
        if(generation!==undefined&&generation!==(ctx.activityGenerations.get(`${threadId}:goal`)??0)&&sharedState(ctx).workerScopes.get(threadId)===shared.id)sharedState(ctx).workerScopes.delete(threadId);
        const activity=thread?.projectId===local.projectId&&!thread.archived?thread.activity?.goal:null;
        const goal=activity?.review?{status:activity.status,reviewing:activity.review.phase==='reviewing',checklist:activity.checklist??null}:null;
        if(JSON.stringify(card.goal)===JSON.stringify(goal))continue;
        const verdict=activity?.review?.verdicts.at(-1),status=card.status==='open'&&goal?.status==='complete'&&verdict?.verdict==='pass'?'claimed':card.status;
        const revision=board.revision+1;
        append(board,{kind:'card',revision,card:{...card,goal:cloneShared(goal),status,revision,assignment:{...assignment,state:goal===null?'uncertain':goal.status==='complete'?'complete':'running'}}});
        notifyShared(ctx,shared.id);
      }
    }
  });
  sharedState(ctx).checkClaim=(shared,source,claimId)=>{
    const main=authority(ctx,shared);if(!main||!shared.access.every(a=>a.board)||![...boardOf(main,shared.id).cards.values()].some(c=>c.assignment?.claimId===claimId&&sameWorker(c.assignment.worker,source)))throw refusedShared('compute.claimId: expected the authority current source reservation');
  };
  sharedState(ctx).listeners.add(id=>{
    const shared=sharedState(ctx).projects.get(id)!;
    if(shared.state==='active'&&shared.access.every(a=>a.board)){synchronize(ctx,shared);return;}
    const board=boardOf(ctx,id);board.pending=[];
    for(const card of board.cards.values())if(card.assignment?.worker.project.coreId===ctx.identity.coreId&&board.starts.has(card.assignment.claimId)){
      const thread=ctx.threads.get(card.assignment.worker.threadId);board.starts.add(`stopped:${card.assignment.claimId}`);
      if(sharedState(ctx).workerScopes.get(card.assignment.worker.threadId)===id)sharedState(ctx).workerScopes.delete(card.assignment.worker.threadId);
      if(thread?.activity?.goal && (ctx.activityGenerations.get(`${thread.id}:goal`)??0)===board.generations.get(card.assignment.claimId))void activityMethods(ctx)['threads.activity.control']({threadId:thread.id,kind:'goal',action:'remove'});
    }
  });
  return {
    'sharedBoard.get':async p=>{
      const {shared}=check(ctx,p);synchronize(ctx,shared);const board=boardOf(ctx,shared.id),available=!!authority(ctx,shared);
      if(p.after===undefined||board.pending.length)return cloneShared({...snapshot(board),authorityAvailable:available});
      const after=integer(p.after);if(after>board.revision)throw invalidShared('after: expected a revision at or below the board head');
      const changes=board.changes.filter(c=>c.revision>after).slice(0,64),to=changes.at(-1)?.revision??after;
      return cloneShared({kind:'delta' as const,from:after,to,changes,more:to<board.revision,authorityAvailable:available});
    },
    'sharedBoard.apply':async p=>applySharedBoard(ctx,p),
    'sharedBoard.start':async p=>{
      const {shared,local}=check(ctx,p),host=authority(ctx,shared);if(!host)throw refusedShared('sharedBoard: claim authority unavailable');
      const card=boardOf(host,shared.id).cards.get(p.cardId),assignment=card?.assignment,board=boardOf(ctx,shared.id);
      if(!assignment||assignment.claimId!==p.claimId||!sameProject(assignment.worker.project,local)||assignment.worker.threadId!==p.threadId||board.starts.has(`stopped:${p.claimId}`))throw refusedShared('claimId: expected this host worker reservation');
      const worker=ctx.thread(p.threadId),protocol=ctx.providers.find(provider=>provider.id===worker.providerId)?.protocol;
      if(!protocol||!sharedProtection(ctx,protocol,worker.providerId,worker.permissionMode).supported||protocol==='echo'&&worker.permissionMode!=='default')throw refusedShared('shared file policy: protected shared execution requires an enforceable host boundary');
      if(!board.starts.has(p.claimId)){
        board.starts.add(p.claimId);
        await activityMethods(ctx)['threads.activity.set']({threadId:p.threadId,goal:{objective:card!.text,review:true}});
        board.generations.set(p.claimId,ctx.activityGenerations.get(`${p.threadId}:goal`)??0);
        sharedState(ctx).workerScopes.set(p.threadId,shared.id);
        sharedState(ctx).workerRevisions.set(p.threadId,shared.access[endpoints(ctx,shared).index].revision);
        assignment.state='running';card!.goal={status:'active',reviewing:false,checklist:null};
        append(boardOf(host,shared.id),{kind:'card',card:{...card!,revision:boardOf(host,shared.id).revision+1},revision:boardOf(host,shared.id).revision+1});notifyShared(ctx,shared.id);
      }
      return cloneShared({requestId:p.claimId,outcome:'applied' as const,revision:boardOf(host,shared.id).revision,card:boardOf(host,shared.id).cards.get(p.cardId)!});
    },
  } satisfies Partial<FakeMethods>;
}
