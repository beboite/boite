import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { sharedFlow } from '../../test/shared-flow';
import { Store } from '../../lib/store.svelte';
import { FakeClient } from '../../lib/fake-client';
import { setExperiment } from '../../lib/experiments';
import { sharedProjectDialog } from '../../lib/deferred-parts';
import SharedProjectThreads from './SharedProjectThreads.svelte';
import SharedProjectDialog from './SharedProjectDialog.svelte';
import SharedAssociations from './SharedAssociations.svelte';
import SharedThreadDialog from './SharedThreadDialog.svelte';
import ProjectBoard from '../ProjectBoard.svelte';

const cleanup: (() => unknown)[] = [];
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value: function(this: HTMLDialogElement) {this.open = true;}});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value: function(this: HTMLDialogElement) {this.open = false;}});
  HTMLElement.prototype.scrollTo = function(this: HTMLElement, options: ScrollToOptions | number) {this.scrollLeft = typeof options === 'number' ? options : options.left ?? 0;} as typeof HTMLElement.prototype.scrollTo;
});
afterEach(async () => {for (const run of cleanup.splice(0).reverse()) await run(); vi.restoreAllMocks(); sharedProjectDialog.current = undefined; sharedProjectDialog.failed = false; setExperiment('contacts', false); setExperiment('goal2', false); document.body.innerHTML = '';});
async function settle() {for (let i = 0; i < 8; i++) {await new Promise(r => setTimeout(r, 0)); await tick();} flushSync();}
async function setup() {
  setExperiment('contacts', true); setExperiment('goal2', true);
  const pair = await sharedFlow(); cleanup.push(() => pair.close());
  const store = new Store(); store.attach(pair.a); await store.connect(); await store.open(pair.local.id);
  cleanup.push(() => store.detach());
  return {...pair, store};
}
const el = <T extends HTMLElement = HTMLButtonElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`)!;
async function click(id: string) {expect(el(id)).not.toBeNull(); el(id).click(); await settle();}
async function fill(id: string, value: string) {const input = el<HTMLInputElement>(id); input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true})); await settle();}
function show<C extends import('svelte').Component<any>>(component: C, props: import('svelte').ComponentProps<C>) {const instance = mount(component, {target: document.body, props}); cleanup.push(() => unmount(instance)); return instance;}

test('shared project rows separate both owners, preserve local navigation, deny a private transcript and send an attested human letter', async () => {
  const {store, a, b, aid, bid, bp, localScope} = await setup();
  setExperiment('goal2', false);
  const open = vi.spyOn(store, 'open');
  show(SharedProjectThreads, {store, projectId: bp.id, active: true, children: createRawSnippet(() => ({render: () => '<div data-testid="local-row">Local row</div>'}))});
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=shared-thread]').length).toBeGreaterThan(1));
  expect(el('shared-local-person').textContent).toContain('You');
  expect(el('shared-project-people').textContent).toContain('Pat');
  expect(el('local-row')).not.toBeNull();
  expect(document.querySelector('[data-testid=shared-open-board]')).toBeNull();
  const privateProject = (await b.call('projects.list', {})).find(p => p.id !== bp.id)!;
  const privateThread = (await b.call('threads.list', {})).find(t => t.projectId === privateProject.id)!;
  expect(el('shared-project-people').textContent).not.toContain(privateThread.title);
  await click('shared-thread-write');
  await vi.waitFor(() => expect(el('shared-no-read')).not.toBeNull());
  expect(open).not.toHaveBeenCalled();
  await fill('shared-human-message', 'Please verify the shared change.'); await click('shared-human-send');
  await vi.waitFor(() => expect(el('shared-human-status')).not.toBeNull());
  const messages = (await Promise.all((await b.call('threads.list', {projectId: bp.id})).map(t => b.call('collaboration.get', {threadId: t.id})))).flatMap(view => view.messages);
  // The selected first directory row and its public address determine the recipient.
  const letter = messages.find(m => m.text === 'Please verify the shared change.');
  expect(letter).toMatchObject({origin: 'contact-human', contact: {name: 'Alex'}});
  expect(letter!.from.coreId).toBe(aid);
  expect((await a.call('threads.list', {projectId: bp.id})).some(t => t.id === letter!.from.threadId)).toBe(true);
  expect(letter!.to.coreId).toBe(bid);
  expect(await a.call('sharedProjects.read', {...localScope, target: (await a.call('sharedProjects.threads', localScope)).threads.find(t => t.ref.project.coreId === bid)!.ref}).catch(e => e)).toHaveProperty('code');
  expect(aid).not.toBe(bid);
});

test('the existing board starts one claimed goal, shows owner/machine/checklist and supports phone menus and revoke', async () => {
  const {store, a, b, as, bs, localScope} = await setup();
  await a.call('sharedProjects.configure', {sharedProjectId: as.sharedProjectId, board: true});
  await b.call('sharedProjects.configure', {sharedProjectId: bs.sharedProjectId, board: true});
  store.shared.boards[localScope.threadId] = localScope.sharedProjectId;
  show(ProjectBoard, {store, threadId: localScope.threadId, narrow: true}); await settle();
  await click('board-add'); await fill('board-add-input', 'Verify the shared release');
  el('board-add-input').closest('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
  await vi.waitFor(() => expect(el('board-card-text')?.textContent).toBe('Verify the shared release'));
  expect(el('board-card').getAttribute('draggable')).toBe('false');
  await click('board-card-menu'); document.querySelector<HTMLButtonElement>('[data-value="move:doing"]')!.click(); await settle();
  await vi.waitFor(() => expect(el('board-card-agent')?.textContent).toContain('You'));
  const page = await a.call('sharedBoard.get', localScope); expect(page.kind).toBe('snapshot');
  if (page.kind !== 'snapshot') throw new Error('expected snapshot');
  const worker = page.cards[0]!.assignment!.worker.threadId;
  await vi.waitFor(() => expect(el('board-card-progress')?.textContent).toMatch(/\d\/\d/));
  await click('board-card-text');
  expect(document.querySelector('[data-testid=goal-checklist-item]')).not.toBeNull();
  expect(el('board-card-agent').textContent).toContain('echo');
  await click('board-card-menu'); document.querySelector<HTMLButtonElement>('[data-value="move:done"]')!.click(); await settle();
  expect(document.querySelector('[data-column=done] [data-testid=board-card]')).not.toBeNull();
  await b.call('sharedProjects.revoke', {sharedProjectId: bs.sharedProjectId, requestId: 'close'});
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=board-card]')).toHaveLength(0));
  expect(el('board-sharing').textContent).toContain('Access revoked');
});

test('host consent/contribution autosave, supported routes, job follow/cancel and protection stay in the owning Store', async () => {
  const {store, a, b, localScope, base, bs} = await setup();
  const calls = vi.spyOn(a, 'call');
  show(SharedProjectDialog, {store, scope: localScope, onclose() {}}); await settle();
  await vi.waitFor(() => expect(el('shared-compute-start')).not.toBeNull());
  el<HTMLDetailsElement>('shared-host-settings').open = true; await settle();
  await click('shared-profile-conversation'); await fill('shared-contribution', '4'); await click('shared-compute-consent');
  await vi.waitFor(async () => expect((await a.call('sharedProjects.get', localScope)).shared.access[0].compute).toMatchObject({enabled: true, maxConcurrent: 4, profiles: ['conversation']}));
  await fill('shared-compute-base', base); await fill('shared-compute-task', 'Check the shared project');
  await vi.waitFor(() => expect(el<HTMLButtonElement>('shared-compute-start').disabled).toBe(false));
  expect([...el('shared-compute-start').closest('form')!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].map(input => [input.value, input.checkValidity()])).toEqual([[base, true], ['Check the shared project', true]]);
  await click('shared-compute-start');
  expect(calls.mock.calls.filter(([method]) => method === 'sharedCompute.start')).toHaveLength(1);
  expect(el<HTMLInputElement>('shared-profile-conversation').disabled).toBe(true);
  expect(el<HTMLInputElement>('shared-compute-consent').disabled).toBe(false);
  expect(document.querySelector('[data-testid=shared-compute] [role=alert]')?.textContent ?? '').toBe('');
  await vi.waitFor(() => expect(el('shared-job')).not.toBeNull());
  const jobId = el('shared-job').dataset.job!;
  b.finishSharedCompute(jobId, 'Verified result'); await settle(); await click('shared-job-follow');
  await vi.waitFor(() => expect(el('shared-job-detail').textContent).toContain('Verified result'));
  expect(el('shared-job-detail').textContent).toContain(base);
  await fill('shared-compute-task', 'Second shared job'); await click('shared-compute-start');
  await vi.waitFor(() => expect(el('shared-job-cancel')).not.toBeNull()); await click('shared-job-cancel');
  await vi.waitFor(async () => expect((await a.call('sharedCompute.list', localScope)).some(j => j.status === 'cancelled')).toBe(true));
  await click('shared-compute-consent');
  await vi.waitFor(() => expect(el<HTMLInputElement>('shared-profile-conversation').disabled).toBe(false));
  await click('shared-profile-conversation');
  await vi.waitFor(async () => expect((await a.call('sharedProjects.get', localScope)).shared.access[0].compute).toMatchObject({enabled: false, profiles: []}));
  expect(el('shared-protection-state').textContent).toContain('Secret files blocked by default');
  expect(el('shared-review-state').textContent).toContain('Off');
  await b.call('sharedProjects.revoke', {sharedProjectId: bs.sharedProjectId, requestId: 'host-close'});
  await vi.waitFor(() => expect(el('shared-project-state').textContent).toContain('Access revoked'));
  expect(document.querySelector('[data-testid=shared-job-detail]')).toBeNull();
});

test('a paired phone can send and follow existing work while host administration remains absent', async () => {
  const {store, a, b, localScope, bs, base} = await setup();
  await a.call('sharedCompute.start', {...localScope, host: (await a.call('sharedProjects.get', localScope)).remote, profileId: 'conversation', task: 'An existing job', baseCommit: base, requestId: 'phone-job'});
  a.becomes('session'); store.detach(); store.attach(a); await store.connect(); await store.open(localScope.threadId);
  show(SharedProjectDialog, {store, scope: localScope, onclose() {}}); await settle();
  expect(document.querySelector('[data-testid=shared-host-settings]')).toBeNull();
  expect(document.querySelector('[data-testid=shared-compute-start]')).toBeNull();
  expect(el('shared-board-consent').hasAttribute('disabled')).toBe(true);
  expect(document.querySelector('[data-testid=shared-project-revoke]')).toBeNull();
  await vi.waitFor(() => expect(el('shared-job-follow')).not.toBeNull());
  await click('shared-job-follow');
  expect(el('shared-job-detail').textContent).toContain('Running');
  await click('shared-job-cancel');
  await vi.waitFor(async () => expect((await a.call('sharedCompute.list', localScope))[0]?.status).toBe('cancelled'));
  await b.call('sharedProjects.revoke', {sharedProjectId: bs.sharedProjectId, requestId: 'phone-close'}); await settle();
  expect(el('shared-project-state').textContent).toContain('Access revoked');
});

test('reopening host settings restores the chosen conversation and unchanged policy preserves running jobs', async () => {
  const {store, a, b, as, bs, local, base} = await setup();
  const policy = {enabled: true, profiles: ['conversation'], permissionMode: 'default' as const, maxConcurrent: 4};
  const configured = await a.call('sharedProjects.configure', {sharedProjectId: as.sharedProjectId, computeThreadId: local.id, compute: policy});
  const job = await b.call('sharedCompute.start', {...bs, host: configured.local, profileId: 'conversation', task: 'Keep the host authority', baseCommit: base, requestId: 'retained-host'});
  expect(job.status).toBe('running');
  expect(as.threadId).not.toBe(local.id);
  const calls = vi.spyOn(a, 'call');
  show(SharedProjectDialog, {store, scope: as, onclose() {}}); await settle();
  await vi.waitFor(() => expect(el('shared-host-thread')?.textContent).toContain('Shared delivery'));
  expect(calls).toHaveBeenCalledWith('delegation.get', {threadId: local.id});
  await fill('shared-contribution', '04');
  expect(calls.mock.calls.filter(([method]) => method === 'sharedProjects.configure')).toEqual([
    ['sharedProjects.configure', {sharedProjectId: as.sharedProjectId, compute: policy}],
  ]);
  const current = await a.call('sharedProjects.get', as);
  expect(current.shared.access).toEqual(configured.shared.access);
  expect((await a.call('sharedCompute.list', as)).find(j => j.id === job.id)?.status).toBe('running');
  expect((await b.call('sharedCompute.list', bs)).find(j => j.id === job.id)?.status).toBe('running');
});

test.each(['threads', 'associations'] as const)('shared %s clears a recovered load error and ignores failures from older requests', async surface => {
  const {store, a, ap, bid} = await setup();
  let rejectFirst!: (error: Error) => void, rejectSecond!: (error: Error) => void;
  const first = new Promise<never>((_, reject) => {rejectFirst = reject;}), second = new Promise<never>((_, reject) => {rejectSecond = reject;});
  const original = store.shared.load.bind(store.shared);
  const load = vi.spyOn(store.shared, 'load').mockImplementationOnce(() => first);
  if (surface === 'threads') show(SharedProjectThreads, {store, projectId: ap.id, active: true,
    children: createRawSnippet(() => ({render: () => '<div>Local thread</div>'}))});
  else show(SharedAssociations, {store, projectId: ap.id, contact: (await a.call('contacts.get', {})).contacts.find(c => c.coreId === bid)!});
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rejectFirst(new Error('Transient shared load failure')); await settle();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Transient shared load failure');
  await a.call('contacts.update', {coreId: bid, name: 'Recovered contact'});
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2)); await settle();
  expect(document.querySelector('[role=alert]')).toBeNull();
  load.mockImplementationOnce(() => second);
  await a.call('contacts.update', {coreId: bid, name: 'Slow contact update'});
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await a.call('contacts.update', {coreId: bid, name: 'Latest contact update'});
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4)); await settle();
  rejectSecond(new Error('Obsolete request failure')); await settle();
  expect(document.querySelector('[role=alert]')).toBeNull();
  load.mockImplementation(original);
});

test('association needs the second owner consent and an open Contacts page can refresh an incoming offer', async () => {
  const {a, b, ap, bp, aid, as, bid} = await setup();
  await a.call('sharedProjects.revoke', {sharedProjectId: as.sharedProjectId, requestId: 'replace'});
  const other = new Store(); other.attach(b); await other.connect();
  cleanup.push(() => other.detach());
  const contact = (await b.call('contacts.get', {})).contacts.find(row => row.coreId === aid)!;
  show(SharedAssociations, {store: other, contact, projectId: bp.id}); await settle();
  const pending = await a.call('sharedProjects.offer', {coreId: bid, projectId: ap.id, remote: {ownerCoreId: bid, coreId: bid, projectId: bp.id}, requestId: 'another-offer'});
  expect(pending.shared.state).toBe('pending');
  await click('shared-associations-refresh');
  await vi.waitFor(() => expect(el('shared-association-accept')).not.toBeNull());
  await click('shared-association-accept');
  await vi.waitFor(() => expect(document.querySelector('[data-testid=shared-association][data-state=active]')).not.toBeNull());
  expect((await a.call('sharedProjects.get', {...as, sharedProjectId: pending.shared.id})).shared.state).toBe('active');
  expect(el<HTMLButtonElement>('shared-associate').disabled).toBe(true);
});

test.each(['ownerCoreId', 'projectId'] as const)('an outgoing pending association does not offer consent for a colliding core with another %s', async field => {
  const {store, a, ap, bid, as} = await setup();
  const view = await a.call('sharedProjects.get', as);
  const recipient = {...view.local, [field]: `different-${field}`};
  const pending = {...view, shared: {...view.shared, state: 'pending' as const, projects: [view.local, recipient] as typeof view.shared.projects}};
  vi.spyOn(store.shared, 'load').mockImplementation(async threadId => {
    store.shared.projects[threadId] = [pending];
    return [pending];
  });
  const contact = (await a.call('contacts.get', {})).contacts.find(c => c.coreId === bid)!;
  show(SharedAssociations, {store, contact, projectId: ap.id}); await settle();
  expect(document.querySelector('[data-testid=shared-association][data-state=pending]')).not.toBeNull();
  expect(el('shared-association-accept')).toBeNull();
});

test('an association dialog chunk failure offers feedback and a retry that opens the same scope', async () => {
  const {store, a, ap, bid, as} = await setup();
  const load = vi.spyOn(sharedProjectDialog, 'load')
    .mockImplementationOnce(async () => { sharedProjectDialog.failed = true; throw new Error('offline'); })
    .mockImplementationOnce(async () => { sharedProjectDialog.failed = false; sharedProjectDialog.current = SharedProjectDialog; return SharedProjectDialog; });
  const contact = (await a.call('contacts.get', {})).contacts.find(c => c.coreId === bid)!;
  const calls = vi.spyOn(a, 'call');
  show(SharedAssociations, {store, contact, projectId: ap.id}); await settle();
  expect(load).not.toHaveBeenCalled();
  await click('shared-association-open');
  expect(el('deferred-failed')).not.toBeNull();
  expect(el('shared-project-dialog')).toBeNull();
  await click('deferred-retry');
  await vi.waitFor(() => expect(el('shared-project-dialog')).not.toBeNull());
  expect(el('deferred-failed')).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
  expect(calls).toHaveBeenCalledWith('sharedProjects.get', expect.objectContaining({sharedProjectId: as.sharedProjectId}));
  el<HTMLButtonElement>('shared-project-dialog').querySelector<HTMLButtonElement>('[data-testid=shared-dialog-close]')!.click(); await settle();
  expect(el('shared-project-dialog')).toBeNull();
});

test('association choices distinguish a gateway and its member with the same project id', async () => {
  const {store, a, b, ap, bp, aid, bid, as} = await setup();
  await a.call('sharedProjects.revoke', {sharedProjectId:as.sharedProjectId,requestId:'replace-for-member'});
  const memberId = 'c'.repeat(64), member = new FakeClient({delayMs:0,coreId:memberId});
  cleanup.push(() => member.close()); await member.connect();
  await b.call('group.create', {name:'Shared fixtures'});
  await member.call('group.join', {invite:(await b.call('group.invite',{})).invite});
  await b.call('contacts.grant', {coreId:aid,projectId:bp.id,machine:memberId});
  const contact = (await a.call('contacts.get',{})).contacts.find(c=>c.coreId===bid)!;
  expect(contact.offers.filter(o=>o.projectId===bp.id)).toHaveLength(2);
  const calls = vi.spyOn(a,'call');
  show(SharedAssociations,{store,contact,projectId:ap.id}); await settle();
  await click('shared-associate');
  const options = [...document.querySelectorAll<HTMLButtonElement>('[data-value]')];
  const keys = options.map(o=>JSON.parse(o.dataset.value!));
  expect(keys).toEqual(expect.arrayContaining([[bid,bid,bp.id],[bid,memberId,bp.id]]));
  options.find(o=>JSON.parse(o.dataset.value!)[1]===memberId)!.click(); await settle();
  expect(calls).toHaveBeenCalledWith('sharedProjects.offer', expect.objectContaining({coreId:bid,projectId:ap.id,remote:{ownerCoreId:bid,coreId:memberId,projectId:bp.id}}));
});

test('a remote board worker opens through its canonical directory, never as a colliding local thread', async () => {
  const {store, a, b, as, bs, localScope, remote, bid} = await setup();
  await a.call('sharedProjects.configure', {sharedProjectId: as.sharedProjectId, board: true});
  await b.call('sharedProjects.configure', {sharedProjectId: bs.sharedProjectId, board: true});
  const added = await b.call('sharedBoard.apply', {...bs, command: {kind: 'add', cardId: 'foreign-card', text: 'Remote card', requestId: 'foreign-add'}});
  const project = (await b.call('sharedProjects.get', bs)).local;
  const claim = await b.call('sharedBoard.apply', {...bs, command: {kind: 'claim', cardId: 'foreign-card', expectedRevision: added.card!.revision, worker: {project, threadId: remote.id, address: {coreId: bid, threadId: remote.id}}, requestId: 'foreign-claim'}});
  await b.call('sharedBoard.start', {...bs, threadId: remote.id, cardId: 'foreign-card', claimId: claim.card!.assignment!.claimId});
  store.shared.boards[localScope.threadId] = localScope.sharedProjectId;
  show(ProjectBoard, {store, threadId: localScope.threadId, narrow: false});
  await vi.waitFor(() => expect(el('board-card-agent')?.textContent).toContain('Pat'));
  const open = vi.spyOn(store, 'open');
  await click('board-card-menu');
  expect(document.querySelector('[data-value=resume]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-value=open]')!.click(); await settle();
  await vi.waitFor(() => expect(el('shared-thread-dialog')).not.toBeNull());
  expect(open).not.toHaveBeenCalled();
  expect(el('shared-thread-dialog').textContent).toContain('Pat');
});

test('revoke hides a foreign transcript immediately and fences an already pending read', async () => {
  const {store, a, b, aid, bs, bp, localScope, bid} = await setup();
  await b.call('contacts.grant', {coreId: aid, projectId: bp.id, readThreads: true});
  const target = (await a.call('sharedProjects.threads', localScope)).threads.find(t => t.ref.project.coreId === bid)!;
  const real = a.call.bind(a);
  let resolve!: (value: unknown) => void;
  vi.spyOn(a, 'call').mockImplementation(((method: never, params: never) => method === 'sharedProjects.read' ? new Promise<unknown>(r => {resolve = r;}) : real(method, params)) as typeof a.call);
  show(SharedThreadDialog, {store, scope: localScope, target, onclose() {}});
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await b.call('sharedProjects.revoke', {sharedProjectId: bs.sharedProjectId, requestId: 'pending-read-close'});
  await vi.waitFor(() => expect(document.querySelector('[data-testid=shared-human-message]')).toBeNull());
  resolve({entries: [{id: 'late', at: Date.now(), role: 'assistant', text: 'LATE PRIVATE TEXT'}], more: false}); await settle();
  expect(el('shared-thread-dialog').textContent).not.toContain('LATE PRIVATE TEXT');
  expect(el('shared-thread-dialog').textContent).toContain('Access revoked');
});


test('manual and background association refreshes only publish their latest result', async () => {
  const {store, a, ap, bid} = await setup();
  show(SharedAssociations, {store, projectId: ap.id, contact: (await a.call('contacts.get', {})).contacts.find(c => c.coreId === bid)!});
  await settle();
  let reject!: (error: Error) => void;
  const original = store.shared.load.bind(store.shared);
  const load = vi.spyOn(store.shared, 'load').mockImplementationOnce(() => new Promise<never>((_, r) => {reject = r;}));
  await click('shared-associations-refresh');
  await a.call('contacts.update', {coreId: bid, name: 'Newest background'});
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2)); await settle();
  reject(new Error('Obsolete manual failure')); await settle();
  expect(document.querySelector('[role=alert]')).toBeNull();
  let resolve!: (value: Awaited<ReturnType<typeof original>>) => void;
  load.mockImplementationOnce(() => new Promise<Awaited<ReturnType<typeof original>>>(r => {resolve = r;}));
  await a.call('contacts.update', {coreId: bid, name: 'Held background'});
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  load.mockRejectedValueOnce(new Error('Current manual failure'));
  await click('shared-associations-refresh');
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Current manual failure');
  resolve([]); await settle();
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Current manual failure');
  load.mockImplementation(original);
});
