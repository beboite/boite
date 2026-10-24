import { sharedPair } from './shared-projects';

/** Explicit two-owner fixture. No network, real repository, account or provider inference. */
export async function sharedFlow() {
  const pair = await sharedPair({coreName: 'Studio PC'});
  const {a, b, ap, bp, aid, bid, as, bs} = pair;
  await a.call('contacts.update', {coreId: bid, name: 'Pat'});
  await b.call('contacts.update', {coreId: aid, name: 'Alex'});
  await a.call('contacts.settings', {settings: {minTier: 3}});
  await b.call('contacts.settings', {settings: {minTier: 3}});
  const accountsA = await a.call('accounts.list', {}), accountsB = await b.call('accounts.list', {});
  const local = await a.call('threads.create', {projectId: ap.id, providerId: 'echo', accountId: accountsA.find(account => account.providerId === 'echo')!.id, title: 'Shared delivery'});
  const remote = await b.call('threads.create', {projectId: bp.id, providerId: 'echo', accountId: accountsB.find(account => account.providerId === 'echo')!.id, title: 'Remote tests'});
  await b.call('threads.update', {threadId: bs.threadId, title: 'Contact review'});
  const base = 'a'.repeat(40);
  a.setSharedRepository(ap.id, 'https://example.test/shared.git', base);
  b.setSharedRepository(bp.id, 'https://example.test/shared.git', base);
  await b.call('sharedProjects.configure', {sharedProjectId: bs.sharedProjectId, computeThreadId: remote.id, compute: {enabled: true, profiles: ['conversation'], permissionMode: 'default', maxConcurrent: 5}});
  return {...pair, local, remote, base, localScope: {...as, threadId: local.id}};
}
