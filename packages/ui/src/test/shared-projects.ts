import { FakeClient, type FakeClientOptions } from '../lib/fake-client';
export async function sharedPair(options:FakeClientOptions={}){
  const a=new FakeClient({...options,delayMs:0,coreId:'a'.repeat(64)}),b=new FakeClient({delayMs:0,coreId:'b'.repeat(64)});
  await a.connect();await b.connect();
  const ap=(await a.call('projects.list',{}))[0]!,bp=(await b.call('projects.list',{}))[0]!;
  const at=(await a.call('threads.list',{})).find(t=>t.projectId===ap.id&&!t.archived)!,bt=(await b.call('threads.list',{})).find(t=>t.projectId===bp.id&&!t.archived)!;
  const aid=a.core!.coreId!,bid=b.core!.coreId!;
  await b.call('contacts.join',{link:(await a.call('contacts.invite',{share:false})).link});
  await a.call('contacts.grant',{coreId:bid,projectId:ap.id});await b.call('contacts.grant',{coreId:aid,projectId:bp.id});
  const remote={ownerCoreId:bid,coreId:bid,projectId:bp.id};
  const offer=await a.call('sharedProjects.offer',{coreId:bid,projectId:ap.id,remote,requestId:'offer'});
  await b.call('sharedProjects.decide',{sharedProjectId:offer.shared.id,accept:true,requestId:'accept'});
  const as={threadId:at.id,sharedProjectId:offer.shared.id},bs={threadId:bt.id,sharedProjectId:offer.shared.id};
  return {a,b,ap,bp,at,bt,aid,bid,as,bs,remote,offer,close(){a.close();b.close();}};
}
