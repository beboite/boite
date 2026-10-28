/** Human admission and contact mail, separate from the ordinary owner's composer. */
import type { AgentLetter, RpcParams } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { coordinationConfig, fakeAgentContact, fakeCore } from './coordination';
import { contactState, modelTier, fakeNoteSent, fakeMayReach } from './contacts';
import { secureId } from '../secure-id';
import { assertSharedActive, cloneShared, endpoints, onceShared, projectAddress, reconcileShared, requireShared, refusedShared, remoteShared, sharedContact, sharedScope, sharedState, sharedText } from './shared-state';

const mailCores=new Set<FakeContext>();
/** Reconnects and policy changes recheck mail before the paused destination can use it. */
function flushContactMail():void {
  for(const source of mailCores)for(const [threadId,letters] of source.letters)for(const letter of letters) {
    if(!letter.contact||(!letter.sharedProjectId&&letter.origin!=='contact-human')||(letter.from.sharedThread?.project.coreId ?? letter.from.coreId)!==source.identity.coreId||(letter.from.sharedThread?.threadId ?? letter.from.threadId)!==threadId||!['queued','received'].includes(letter.status))continue;
    const shared=letter.sharedProjectId?requireShared(source,letter.sharedProjectId):undefined,refs=shared?endpoints(source,shared):undefined;
    const target=refs?remoteShared(source,shared!):fakeCore(letter.to.coreId),outbound=sharedContact(source,letter.to.coreId,refs?.local);
    const inbound=target?sharedContact(target,refs?.local.ownerCoreId ?? source.identity.coreId,refs?.remote):undefined;
    if(!target||outbound?.link!=='connected'||inbound?.link!=='connected')continue;
    const recipient=refs?[...target.threads.values()].find(t=>t.projectId===refs.remote.projectId&&projectAddress(refs.remote,t.id).threadId===letter.to.threadId):target.threads.get(letter.to.threadId),human=letter.origin==='contact-human';
    const config=recipient?coordinationConfig(target,recipient.id):null;
    let allowed=!!recipient&&!!inbound&&!!config&&fakeMayReach(target,refs?.local.ownerCoreId ?? source.identity.coreId,recipient.id)&&config.mode!=='off'&&config.remote;
    if(human&&inbound?.capabilities?.humanLetters!==1)allowed=false;
    const sender=source.threads.get(threadId);
    if(!human&&(!sender||modelTier(sender.providerId,sender.model)>contactState(target).settings.minTier))allowed=false;
    if(letter.sharedProjectId){try{
      const shared=requireShared(target,letter.sharedProjectId);assertSharedActive(target,shared);
      const refs=endpoints(target,shared),from=letter.from.sharedThread;
      if(!from||from.project.ownerCoreId!==refs.remote.ownerCoreId||from.project.coreId!==refs.remote.coreId||from.project.projectId!==refs.remote.projectId||recipient?.projectId!==refs.local.projectId)allowed=false;
    }catch{allowed=false;}}
    const before=letter.status;
    if(letter.expiresAt<=Date.now())letter.status='expired';
    else if(!allowed){letter.status='rejected';letter.error='letter.to: not a thread of a project opened to you';}
    else letter.status=config!.paused||recipient!.status==='waiting'||recipient!.status==='queued'?'received':'delivered';
    const messages=target.letters.get(recipient?.id ?? letter.to.threadId)??[],received=messages.find(l=>l.id===letter.id);
    if(received){received.status=letter.status;received.error=letter.error;}
    else if(allowed)target.letters.set(recipient!.id,[...messages,{...cloneShared(letter),toTitle:recipient!.title,contact:{coreId:refs?.local.ownerCoreId ?? source.identity.coreId,name:inbound!.name}}]);
    if(before!==letter.status){source.emit('collaboration.changed',{threadId});target.emit('collaboration.changed',{threadId:recipient?.id ?? letter.to.threadId});}
  }
}

export function sharedLetterMethods(ctx:FakeContext,ordinary:Pick<FakeMethods,'collaboration.send'|'collaboration.configure'|'collaboration.get'>){
  mailCores.add(ctx);
  ctx.bus.onState(state=>{if(state==='closed')mailCores.delete(ctx);});
  ctx.bus.observe('contacts.updated',flushContactMail);
  sharedState(ctx).listeners.add(flushContactMail);
  async function send(p:RpcParams<'contacts.sendHuman'>,human:boolean):Promise<AgentLetter>{
    const contact=sharedContact(ctx,p.to?.coreId);
    if(!contact){if(human)throw refusedShared('to.coreId: expected a contact with negotiated humanLetters version 1');return ordinary['collaboration.send'](p);}
    const associations=[...sharedState(ctx).projects.values()].filter(s=>endpoints(ctx,s).remote.ownerCoreId===contact.coreId&&(s.state==='active'||s.state==='revoked'));
    // The ordinary transport owns mutual trust and durable group mailboxes.
    // Scoped mail must never fall back after an association was revoked.
    if(!human&&!associations.length)return ordinary['collaboration.send'](p);
    if(human&&contact.capabilities?.humanLetters!==1)throw refusedShared('to.coreId: contact must negotiate humanLetters version 1');
    const thread=ctx.thread(p.threadId),config=coordinationConfig(ctx,thread.id),text=sharedText(p.text,'text',4000);
    if(thread.archived||config.mode==='off'||config.paused||!config.remote)throw refusedShared('coordination is off, paused or remote-disabled for this thread');
    if(!human&&modelTier(thread.providerId,thread.model)>contactState(ctx).settings.minTier)throw refusedShared('threadId: model is below the contact tier');
    let from=fakeAgentContact(ctx,thread,ctx.identity.coreId,ctx.identity.name),sharedProjectId:string|undefined;
    let target=fakeCore(p.to.coreId),recipient=target?.threads.get(p.to.threadId);
    if(associations.length){
      const s=associations.find(s=>{const {local,remote}=endpoints(ctx,s);return local.projectId===thread.projectId&&s.state==='active'&&[...(fakeCore(remote.coreId)?.threads.values()??[])].some(t=>t.projectId===remote.projectId&&projectAddress(remote,t.id).coreId===p.to.coreId&&projectAddress(remote,t.id).threadId===p.to.threadId);});
      if(!s)throw refusedShared('to: expected an allowed thread of this source project association');
      const scope=sharedScope(ctx,{threadId:thread.id,sharedProjectId:s.id});
      target=remoteShared(ctx,s);
      if(!target)throw refusedShared('to: expected an available thread of this source project association');
      recipient=[...target.threads.values()].find(t=>t.projectId===scope.remote.projectId&&projectAddress(scope.remote,t.id).threadId===p.to.threadId);
      from={...from,...projectAddress(scope.local,thread.id),sharedThread:{project:scope.local,threadId:thread.id,address:projectAddress(scope.local,thread.id)}};sharedProjectId=s.id;
    }
    if(human){const {agent:_model,...person}=from;from=person;}
    if(p.replyTo){const previous=(ctx.letters.get(thread.id)??[]).find(l=>l.id===p.replyTo);if(!previous||previous.from.coreId!==p.to.coreId||previous.from.threadId!==p.to.threadId||previous.to.coreId!==ctx.identity.coreId||previous.to.threadId!==thread.id)throw refusedShared('replyTo: expected an incoming message from this recipient');}
    const requestId=sharedText(p.requestId,'requestId',128);
    const saved=onceShared(ctx,`letter:${thread.id}:${requestId}`,{to:p.to,text,replyTo:p.replyTo??null,human},()=>{
      const createdAt=Date.now(),letter:AgentLetter={id:secureId(),from,to:cloneShared(p.to),toTitle:recipient?.title??p.to.threadId,toMachine:contact.name,text,replyTo:p.replyTo??null,createdAt,expiresAt:createdAt+15*60_000,status:'queued',error:null,
        ...(human?{origin:'contact-human' as const}:{}),contact:{coreId:contact.coreId,name:contact.name},...(sharedProjectId?{sharedProjectId}:{})};
      ctx.letters.set(thread.id,[...(ctx.letters.get(thread.id)??[]),letter]);ctx.emit('collaboration.changed',{threadId:thread.id});
      fakeNoteSent(ctx,thread.id,contact.coreId);flushContactMail();
      return letter;
    }, true);
    return cloneShared(ctx.letters.get(thread.id)!.find(l=>l.id===saved.id)!);
  }
  return {
    'contacts.sendHuman':async p=>send(p,true),
    'collaboration.send':async p=>send(p,false),
    'collaboration.configure':async p=>{await ordinary['collaboration.configure'](p);reconcileShared(ctx);flushContactMail();return ordinary['collaboration.get']({threadId:p.threadId});},
  } satisfies Partial<FakeMethods>;
}
