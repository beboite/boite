/** One behavioral contract is run over real signed/sealed cores and the in-memory transport. */
import { RpcErrorCode, type SharedProjectRef } from '../../packages/contracts/src/index.ts';
import type { ContractEnv, Scenario } from './scenarios.ts';

function check(ok:unknown,reason:string):asserts ok{if(!ok)throw new Error(reason);}
async function refused(call:Promise<unknown>,code:number=RpcErrorCode.Refused){
  let failure:unknown;try{await call;}catch(error){failure=error;}
  const e=failure as {code?:number;rpc?:{code:number}}|undefined;
  check((e?.rpc?.code??e?.code)===code,`expected ${code}, got ${String(failure)}`);
}
async function until(test:()=>Promise<boolean>,reason='contact contract timed out'){const end=Date.now()+5000;while(!await test()){check(Date.now()<end,reason);await new Promise(r=>setTimeout(r,10));}}
async function source(env:ContractEnv){
  const account=(await env.call('accounts.list',{})).find(a=>a.providerId==='echo')!;
  const project=await env.call('projects.add',{path:await env.newFolder(),name:'Shared contract'});
  const thread=await env.call('threads.create',{projectId:project.id,providerId:'echo',accountId:account.id,title:'Shared source'});
  const coreId=(await env.call('collaboration.identity',{})).coreId;
  const ref:SharedProjectRef={ownerCoreId:coreId,coreId,projectId:project.id};
  return {project,thread,ref};
}
export const SHARED_SCENARIOS:Record<string,Scenario>={
  'shared projects, board receipts, human provenance and host-only protection agree across transports':async env=>{
    const peer=await env.newContact();
    const a=await source(env),b=await source(peer);
    await peer.call('contacts.join',{link:(await env.call('contacts.invite',{share:false})).link});
    await env.call('contacts.grant',{coreId:b.ref.coreId,projectId:a.project.id});
    await peer.call('contacts.grant',{coreId:a.ref.coreId,projectId:b.project.id});
    await until(async()=>((await env.call('contacts.get',{})).contacts.find(c=>c.coreId===b.ref.coreId)?.capabilities?.humanLetters===1));
    const offered=await env.call('sharedProjects.offer',{coreId:b.ref.coreId,projectId:a.project.id,remote:b.ref,requestId:'offer-contract'});
    const as={threadId:a.thread.id,sharedProjectId:offered.shared.id},bs={threadId:b.thread.id,sharedProjectId:offered.shared.id};
    await refused(env.call('sharedProjects.threads',as));
    await peer.call('sharedProjects.decide',{sharedProjectId:as.sharedProjectId,accept:true,requestId:'accept-contract'});
    await until(async()=>(await env.call('sharedProjects.get',as)).shared.state==='active');
    const directory=await env.call('sharedProjects.threads',as),remote=directory.threads.find(t=>t.ref.project.coreId===b.ref.coreId);
    check(remote,'destination thread missing');check(directory.threads.length===2,'private or duplicate shared threads');
    await refused(env.call('sharedProjects.read',{...as,target:remote.ref}));
    await peer.call('contacts.grant',{coreId:a.ref.coreId,projectId:b.project.id,readThreads:true});
    await until(async()=>{try{return (await env.call('sharedProjects.threads',as)).threads.find(t=>t.ref.project.coreId===b.ref.coreId)?.readThreads===true;}catch{return false;}});
    check((await env.call('sharedProjects.read',{...as,target:remote.ref})).contact.threadId===b.thread.id,'wrong transcript');
    await refused(env.call('sharedBoard.get',as));
    await env.call('sharedProjects.configure',{sharedProjectId:as.sharedProjectId,board:true});await peer.call('sharedProjects.configure',{sharedProjectId:bs.sharedProjectId,board:true});
    await until(async()=>(await env.call('sharedProjects.get',as)).shared.access.every(a=>a.board));
    const command={kind:'add' as const,cardId:'contract-card',requestId:'add-contract',text:'Shared card'};
    const receipt=await env.call('sharedBoard.apply',{...as,command});
    check(receipt.outcome==='applied','add refused');
    check(JSON.stringify(await env.call('sharedBoard.apply',{...as,command}))===JSON.stringify(receipt),'receipt is not idempotent');
    await refused(env.call('sharedBoard.apply',{...as,command:{...command,text:'changed'}}),RpcErrorCode.InvalidParams);
    const page=await peer.call('sharedBoard.get',bs);check(page.kind==='snapshot'&&page.cards[0]?.text===command.text,'replica card missing');
    const todo=(await peer.call('todos.list',{threadId:b.thread.id})).find(t=>t.shared?.sharedProjectId===as.sharedProjectId&&t.id===command.cardId);
    check(todo?.text===command.text,'shared card missing from the existing board');
    await peer.call('todos.update',{threadId:b.thread.id,todoId:command.cardId,sharedProjectId:as.sharedProjectId,text:'Edited through existing board'});
    await until(async()=>{
      const updated=await env.call('sharedBoard.get',as);
      return updated.kind==='snapshot'&&updated.cards[0]?.text==='Edited through existing board';
    },'existing board edit did not replicate');
    await env.call('sharedBoard.apply',{...as,command:{kind:'remove',cardId:command.cardId,requestId:'delete-contract'}});
    await until(async()=>{
      const result=await peer.call('sharedBoard.apply',{...bs,command:{...command,requestId:'resurrect-contract'}});
      if(result.outcome==='queued')return false;
      check(result.outcome==='deleted',`deleted card resurrected: ${result.outcome}`);
      return true;
    });
    for(const [side,scope] of [[env,as],[peer,bs]] as const){
      const deleted=await side.call('sharedBoard.get',scope);
      check(deleted.kind==='snapshot'&&!deleted.cards.some(card=>card.id===command.cardId),'deleted card present after terminal receipt');
    }
    await peer.call('collaboration.configure',{threadId:b.thread.id,config:{mode:'brief',remote:true,paused:true,resources:''}});
    await peer.call('contacts.update',{coreId:a.ref.coreId,name:'Receiver chosen name'});
    const letter={threadId:a.thread.id,to:remote.ref.address,text:'External human letter',requestId:'human-contract'};
    const sent=await env.call('contacts.sendHuman',letter);
    check(sent.origin==='contact-human'&&!sent.from.agent,'human provenance missing or has a model');
    check((await env.call('contacts.sendHuman',letter)).id===sent.id,'human retry duplicated');
    await until(async()=>(await peer.call('collaboration.get',{threadId:b.thread.id})).messages.some(l=>l.id===sent.id));
    const incoming=(await peer.call('collaboration.get',{threadId:b.thread.id})).messages.find(l=>l.id===sent.id)!;
    check(incoming.origin==='contact-human'&&incoming.contact?.name==='Receiver chosen name','sender supplied contact identity');
    check((await peer.call('threads.get',{threadId:b.thread.id})).messages.length===0,'external letter became owner prompt');
    check((await env.call('sharedAccess.reviewConfig',{sharedProjectId:as.sharedProjectId})).enabled===false,'reviewer default enabled');
    const activity=await env.call('sharedAccess.get',as);check(Array.isArray(activity.events)&&Array.isArray(activity.verdicts),'missing sanitized access page');
    await refused(env.call('sharedAccess.override',{sharedProjectId:as.sharedProjectId,requestId:'execute',override:{path:'.env',actions:['execute'],jobId:null,reason:'Unsafe override',expiresAt:Date.now()+60000}}),RpcErrorCode.InvalidParams);
    check((await env.call('sharedCompute.host',{sharedProjectId:as.sharedProjectId})).threadId===null,'unconfigured host binding leaked or was invented');
    await refused(env.call('sharedCompute.models',{...as,host:b.ref}));
    await env.call('sharedProjects.subscribe',{...as,enabled:true});
    await env.call('sharedProjects.subscribe',{...as,enabled:false});
    await peer.call('sharedProjects.revoke',{sharedProjectId:bs.sharedProjectId,requestId:'revoke-contract'});
    await until(async()=>(await env.call('sharedProjects.get',as)).shared.state==='revoked');
    await refused(env.call('sharedProjects.threads',as));await refused(env.call('sharedBoard.get',as));await refused(env.call('sharedCompute.list',as));
  },
};
