import { afterEach, expect, test, vi } from 'vitest';
import type { RpcEventName, SharedProjectThread } from '@boite/contracts';
import { sharedPair } from '../test/shared-projects';
import { Store } from './store.svelte';

const releases:(()=>void)[]=[];
afterEach(()=>{for(const release of releases.splice(0).reverse())release();});
async function setup(){
  const pair=await sharedPair();releases.push(()=>pair.close());
  const sa=new Store(),sb=new Store();sa.machineId=pair.aid;sb.machineId=pair.bid;
  sa.attach(pair.a);sb.attach(pair.b);await sa.connect();await sb.connect();
  releases.push(()=>{sa.detach();sb.detach();});return {...pair,sa,sb};
}

test('Store owns the transport, canonical identity and relay address even when project/thread ids collide',async()=>{
  const {a,b,sa,sb,as,bs,bid}=await setup();
  const ac=vi.spyOn(a,'call'),bc=vi.spyOn(b,'call');
  releases.push(sa.shared.watch(as,['threads']),sb.shared.watch(bs,['threads']));
  await vi.waitFor(()=>expect(sa.shared.view(as)?.threads.length).toBeGreaterThan(1));
  await vi.waitFor(()=>expect(sb.shared.view(bs)?.threads.length).toBeGreaterThan(1));
  const remote=sa.shared.view(as)!.threads.find(t=>t.ref.project.coreId===bid)!;
  const alias:SharedProjectThread['ref']={...remote.ref,project:{...remote.ref.project,ownerCoreId:'link-owner',coreId:'actual-member'},address:{coreId:'link-owner',threadId:'public-route-alias'}};
  expect(sa.shared.threadKey(remote.ref)).not.toBe(sa.shared.threadKey({...remote.ref,project:{...remote.ref.project,coreId:'another-machine'}}));
  // A future group relay changes the public address, never the canonical key.
  expect(sa.shared.threadKey(alias)).toBe(JSON.stringify(['link-owner','actual-member',alias.project.projectId,alias.threadId]));
  await sa.shared.sendHuman({threadId:as.threadId,to:remote.ref.address,text:'Owner transport',requestId:'transport'});
  expect(ac.mock.calls.some(([m,p])=>m==='contacts.sendHuman'&&(p as {to?:unknown}).to===remote.ref.address)).toBe(true);
  expect(bc.mock.calls.some(([m])=>m==='contacts.sendHuman')).toBe(false);
});

test('a reconnect clears stale data and reestablishes exactly the live scopes; old reads cannot repopulate them',async()=>{
  const {a,sa,as}=await setup();
  const real=a.call.bind(a);let resolve!:(value:unknown)=>void;let blocked=true;
  const spy=vi.spyOn(a,'call').mockImplementation(((m:never,p:never)=>{
    if(m==='sharedProjects.threads'&&blocked)return new Promise<unknown>(r=>{resolve=r;});
    return real(m,p);
  }) as typeof a.call);
  const release=sa.shared.watch(as,['threads']);releases.push(release);
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
  a.drop();expect(sa.shared.view(as)?.threads).toEqual([]);expect(a.sharedSubscriptions).toEqual([]);
  blocked=false;await a.restore();
  await vi.waitFor(()=>expect(sa.shared.view(as)?.threads.length).toBeGreaterThan(1));
  resolve({threads:[{agent:{title:'STALE'}}],unavailable:[]});
  await Promise.resolve();await Promise.resolve();
  expect(JSON.stringify(sa.shared.view(as))).not.toContain('STALE');
  expect(a.sharedSubscriptions).toEqual([as]);
  release();await vi.waitFor(()=>expect(a.sharedSubscriptions).toEqual([]));
  expect(sa.shared.view(as)).toBeUndefined();spy.mockRestore();
});

test('revocation retires the scope and a delayed same-page access verdict triggers a new read',async()=>{
  const {a,b,sa,as,bs}=await setup();
  const handlers=new Map<string,(p:unknown)=>void>(),on=a.on.bind(a);
  const spy=vi.spyOn(a,'on').mockImplementation(((event:RpcEventName,handler:(p:unknown)=>void)=>{handlers.set(event,handler);return on(event,handler);}) as typeof a.on);
  // Re-attach so the event handler is captured; this also retires prior Store state.
  sa.attach(a);await sa.connect();
  const calls=vi.spyOn(a,'call');releases.push(sa.shared.watch(as,['access','threads']));
  await vi.waitFor(()=>expect(sa.shared.view(as)?.access).not.toBeNull());
  const before=calls.mock.calls.filter(([m])=>m==='sharedAccess.get').length;
  handlers.get('sharedProjects.changed')!(as);
  await vi.waitFor(()=>expect(calls.mock.calls.filter(([m])=>m==='sharedAccess.get').length).toBeGreaterThan(before));
  expect(calls.mock.calls.filter(([m])=>m==='sharedAccess.get').every(([,p])=>!('after' in p))).toBe(true);
  await b.call('sharedProjects.revoke',{sharedProjectId:bs.sharedProjectId,requestId:'revoke'});
  await vi.waitFor(()=>expect(sa.shared.view(as)?.project?.shared.state).toBe('revoked'));
  expect(sa.shared.view(as)?.threads).toEqual([]);expect(sa.shared.view(as)?.access).toBeNull();
  expect(a.sharedSubscriptions).toEqual([]);spy.mockRestore();
});

test('read-only shared calls do not invalidate their own watched view', async () => {
  const {sa, as} = await setup();
  releases.push(sa.shared.watch(as, ['threads']));
  await vi.waitFor(() => expect(sa.shared.view(as)?.threads.length).toBeGreaterThan(1));
  const refresh = vi.spyOn(sa.shared, 'refresh');
  await sa.shared.call('sharedProjects.get', as);
  await sa.shared.call('sharedAccess.reviewConfig', {sharedProjectId: as.sharedProjectId});
  await sa.shared.call('sharedAccess.overrides', {sharedProjectId: as.sharedProjectId});
  expect(refresh).not.toHaveBeenCalled();
});

test('access-only invalidations update verdicts without recursively reading watched threads', async () => {
  const {a,sa,as}=await setup();
  releases.push(sa.shared.watch(as,['threads','access','board','compute']));
  await vi.waitFor(()=>expect(sa.shared.view(as)?.loading).toBe(false));
  await vi.waitFor(()=>expect(sa.shared.view(as)?.threads.length).toBeGreaterThan(1));
  const calls=vi.spyOn(a,'call');
  sa.shared.changed({...as,kinds:['access']} as Parameters<typeof sa.shared.changed>[0]);
  await vi.waitFor(()=>expect(calls.mock.calls.some(([m])=>m==='sharedAccess.get')).toBe(true));
  await vi.waitFor(()=>expect(sa.shared.view(as)?.loading).toBe(false));
  expect(calls.mock.calls.filter(([m])=>m==='sharedProjects.threads')).toHaveLength(0);
  expect(calls.mock.calls.filter(([m])=>m==='sharedCompute.list'||m==='sharedBoard.get')).toHaveLength(0);
  expect(calls.mock.calls.filter(([m])=>m==='sharedProjects.get')).toHaveLength(1);
});


test('access pagination waits for the queued refresh after an already pending read', async () => {
  const {a, sa, as} = await setup();
  releases.push(sa.shared.watch(as, ['access']));
  await vi.waitFor(() => expect(sa.shared.view(as)?.loading).toBe(false));
  const original = a.call.bind(a);
  const resolve: ((value: unknown) => void)[] = [];
  const calls = vi.spyOn(a, 'call').mockImplementation(((method: never, params: never) => {
    if (method === 'sharedAccess.get') return new Promise<unknown>(r => {resolve.push(r);});
    return original(method, params);
  }) as typeof a.call);
  let finished = false;
  const first = sa.shared.refresh(as);
  await vi.waitFor(() => expect(resolve).toHaveLength(1));
  const next = sa.shared.accessPage(as, 'next-page').then(() => {finished = true;});
  try {
    resolve[0]!({events: [], next: 'next-page'});
    await vi.waitFor(() => expect(resolve).toHaveLength(2));
    expect(finished).toBe(false);
    expect(calls.mock.calls.filter(([m]) => m === 'sharedAccess.get')[1]![1]).toMatchObject({after: 'next-page'});
  } finally {
    resolve[1]?.({events: [], next: null}); await first; await next; calls.mockRestore();
  }
});
