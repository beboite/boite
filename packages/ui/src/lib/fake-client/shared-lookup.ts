/** Shared discovery never infers a canonical target from a public relay address. */
import type { AgentMatch, SharedThreadRef } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { cloneShared, invalidShared, refusedShared, remoteShared, sameProject, sharedScope, sharedThreads, sharedText, sharedTextProjection } from './shared-state';
import { recordSharedAccess } from './shared-access';

export function sharedLookupMethods(ctx: FakeContext) {
  function directory(p: {threadId:string;sharedProjectId:string}) {
    const scope=sharedScope(ctx,p), target=remoteShared(ctx,scope.shared);
    const threads=[...sharedThreads(ctx,scope.shared,scope.local,ctx),...(target?sharedThreads(target,scope.shared,scope.remote,ctx):[])];
    return {...scope,target,threads};
  }
  function transcript(host: FakeContext, ref: SharedThreadRef, limit=30,before?:number,search=false) {
    if (!Number.isSafeInteger(limit)||limit<1||limit>100) throw invalidShared('limit: expected 1 to 100');
    if (before!==undefined&&!Number.isSafeInteger(before)) throw invalidShared('before: expected a timestamp');
    const entries=host.thread(ref.threadId).messages.filter(m=>before===undefined||m.createdAt<before).map(m=>({id:m.id,role:m.role,at:m.createdAt,
      text:m.parts.flatMap(p=>p.type==='text'&&m.role!=='system'?[p.text]:[]).join('\n'),tools:m.parts.flatMap(p=>p.type==='tool'?[p.name]:[])})).map(e=>({...e,text:(search&&sharedTextProjection(e.text)!==e.text?'':sharedTextProjection(e.text)).slice(0,4000)})).filter(e=>e.text||e.tools.length);
    return {entries:entries.slice(-limit),more:entries.length>limit};
  }
  return {
    'sharedProjects.search': async p => {
      const words=[...new Set(sharedText(p.query,'query',500).toLowerCase().split(/\s+/).filter(w=>w.length>=2))].slice(0,8);
      if (!words.length) throw invalidShared('query: expected a word of two characters or more');
      const d=directory(p), matches:AgentMatch[]=[];
      for (const entry of d.threads) {
        const fields={title:entry.agent.title,project:entry.agent.project??'',branch:entry.agent.branch??'',agent:entry.agent.agent??'',resources:entry.agent.resources};
        const host=sameProject(entry.ref.project,d.local)?ctx:d.target!;
        const chat=entry.readThreads?transcript(host,entry.ref,100,undefined,true).entries.filter(e=>e.role!=='system').map(e=>e.text):[];
        const matched=new Set<AgentMatch['matched'][number]>();
        if (!words.every(word=>{
          const hits=(Object.keys(fields) as (keyof typeof fields)[]).filter(k=>fields[k].toLowerCase().includes(word)); hits.forEach(k=>matched.add(k));
          const inChat=chat.some(t=>t.toLowerCase().includes(word)); if(inChat)matched.add('chat'); return hits.length>0||inChat;
        })) continue;
        matches.push({...entry.agent,matched:[...matched],excerpts:matched.has('chat')?chat.filter(t=>words.some(w=>t.toLowerCase().includes(w))).slice(-3).map(t=>t.slice(0,200)):[]});
      }
      if(d.target)recordSharedAccess(d.target,d.shared,d.source,'read');
      return cloneShared({matches,unavailable:d.target?[]:[d.remote]});
    },
    'sharedProjects.read': async p => {
      const d=directory(p), ref=p.target;
      const found=d.threads.find(t=>sameProject(t.ref.project,ref.project)&&t.ref.threadId===ref.threadId&&t.ref.address.coreId===ref.address.coreId&&t.ref.address.threadId===ref.address.threadId);
      if(!found)throw refusedShared('target: expected an available thread of this shared project');
      if(!found.readThreads)throw refusedShared('target.threadId: destination project requires readThreads');
      const host=sameProject(ref.project,d.local)?ctx:d.target!;
      if(host!==ctx)recordSharedAccess(host,d.shared,d.source,'read');
      return cloneShared({contact:found.agent,...transcript(host,ref,p.limit,p.before)});
    },
  } satisfies Partial<FakeMethods>;
}
