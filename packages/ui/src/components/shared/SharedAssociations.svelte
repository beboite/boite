<script lang="ts">
  import { untrack } from 'svelte';
  import type { Contact, ContactOffer, SharedProjectRef, SharedProjectScope } from '@boite/contracts';
  import type { Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { strings } from '../../lib/strings';
  import { sameSharedProject } from '../../lib/shared-ui';
  import { sharedProjectDialog } from '../../lib/deferred-parts';
  import Deferred from '../Deferred.svelte';
  import Menu from '../Menu.svelte';
  let { store, contact, projectId }: { store: Store; contact: Contact; projectId: string } = $props();
  let thread = $derived(store.projectBoardThread(projectId) ?? store.threadsOf(projectId).find(t => !t.archived && !t.incognito));
  let projects = $derived(thread ? (store.shared.projects[thread.id] ?? []).filter(p => p.contact.coreId === contact.coreId) : []);
  let busy = $state(false), error = $state('');
  let selected = $state<SharedProjectScope | null>(null);
  let loadVersion = 0;
  async function load() {
    const owner = store, id = thread?.id, client = owner.client, request = ++loadVersion;
    if (!id || owner.connection !== 'ready' || !client) return;
    const current = () => request === loadVersion && store === owner && owner.client === client && thread?.id === id;
    try {await owner.shared.load(id); if (current()) error = '';}
    catch (e) {if (current()) error = errorText(e);}
  }
  async function refresh() {
    if (!thread || busy) return;
    busy = true; error = '';
    try { await load(); }
    finally { busy = false; }
  }
  $effect(() => {
    const id = thread?.id, client = store.client;
    if (!id || store.connection !== 'ready' || !client) return;
    untrack(() => {void load();});
    const release = client.on('contacts.updated', () => {void load();});
    return () => { loadVersion++; release(); };
  });
  const remoteOf = (offer: ContactOffer): SharedProjectRef => offer.sharedProject ?? {ownerCoreId: contact.coreId, coreId: contact.coreId, projectId: offer.projectId};
  const keyOf = (ref: SharedProjectRef) => JSON.stringify([ref.ownerCoreId, ref.coreId, ref.projectId]);
  let offers = $derived(contact.offers.filter(o => !projects.some(p => p.shared.state !== 'revoked' && p.shared.state !== 'declined' && keyOf(p.remote) === keyOf(remoteOf(o)))));
  async function offer(key: string) {
    if (!store.owner || busy || !thread) return;
    const selected = offers.find(o => keyOf(remoteOf(o)) === key);
    if (!selected) return;
    busy = true; error = '';
    try {
      await store.shared.call('sharedProjects.offer', {coreId: contact.coreId, projectId, remote: remoteOf(selected), requestId: secureId()});
      await store.shared.load(thread.id);
    } catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
  async function decide(sharedProjectId: string, accept: boolean) {
    if (!store.owner || busy || !thread) return;
    busy = true; error = '';
    try { await store.shared.call('sharedProjects.decide', {sharedProjectId, accept, requestId: secureId()}); await store.shared.load(thread.id); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
</script>

<div class="associations" data-testid="shared-associations" data-project={projectId}>
  <button type="button" class="ghost small" disabled={busy || !thread} onclick={() => void refresh()} data-testid="shared-associations-refresh">{strings.shared.refresh}</button>
  {#each projects as project (project.shared.id)}
    <div class="row" data-testid="shared-association" data-state={project.shared.state}>
      <span>{contact.offers.find(o => keyOf(remoteOf(o)) === keyOf(project.remote))?.name ?? strings.shared.heading} · {strings.shared.state[project.shared.state]}</span>
      {#if project.shared.state === 'pending' && sameSharedProject(project.shared.projects[1], project.local) && store.owner}
        <button type="button" class="small" disabled={busy} onclick={() => void decide(project.shared.id, true)} data-testid="shared-association-accept">{strings.shared.accept}</button>
        <button type="button" class="ghost small" disabled={busy} onclick={() => void decide(project.shared.id, false)}>{strings.shared.decline}</button>
      {:else if project.shared.state === 'active' && thread}
        <button type="button" class="ghost small" onclick={() => { selected = {threadId: thread!.id, sharedProjectId: project.shared.id}; }} data-testid="shared-association-open">{strings.shared.heading}</button>
      {/if}
    </div>
  {/each}
  {#if store.owner && contact.capabilities?.sharedProjects === 1}
    <Menu items={offers.map(o => ({id: keyOf(remoteOf(o)), label: o.name}))}
      label={strings.shared.pickProject} disabled={busy || !thread || !offers.length} onpick={id => void offer(id)} testid="shared-associate"><span>{strings.shared.associate}</span></Menu>
    {#if !thread}<p class="hint">{strings.shared.needsThread}</p>{:else if !contact.offers.length}<p class="hint">{strings.shared.noOffers}</p>{/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
{#if selected}
  {@const scope = selected}
  <Deferred part={sharedProjectDialog} floating>
    {#snippet children(Component)}<Component {store} {scope} onclose={() => { selected = null; }} />{/snippet}
  </Deferred>
{/if}

<style>
  .associations { padding: 0 0 12px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-block: 8px; font-size: var(--text-sm); }
  .row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .hint, .error { color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; } .error { color: var(--color-danger); }
  @media (max-width: 720px) { button { min-height: var(--touch-target); } }
</style>
