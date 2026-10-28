<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { MessageSquare, Settings2, SquareKanban } from '@lucide/svelte';
  import type { SharedProjectScope, SharedProjectThread } from '@boite/contracts';
  import type { Store } from '../../lib/store.svelte';
  import { experimentOn } from '../../lib/experiments.svelte';
  import { errorText } from '../../lib/errors';
  import { sameSharedProject } from '../../lib/shared-ui';
  import { fill, strings } from '../../lib/strings';
  import ProviderLogo from '../ProviderLogo.svelte';
  let { store, projectId, active, children }: { store: Store; projectId: string; active: boolean; children: Snippet } = $props();
  let thread = $derived(store.projectBoardThread(projectId) ?? store.threadsOf(projectId).find(t => !t.archived && !t.incognito));
  let projects = $derived(thread ? (store.shared.projects[thread.id] ?? []).filter(p => p.shared.state === 'active') : []);
  let localMachine = $derived(projects.map(p => store.shared.view({threadId: thread!.id, sharedProjectId: p.shared.id})?.threads.find(row => sameSharedProject(row.ref.project, p.local))?.machine).find(Boolean) ?? store.core?.hostname ?? strings.machines.local);
  let settings = $state<SharedProjectScope | null>(null);
  let selected = $state<{scope: SharedProjectScope; target: SharedProjectThread} | null>(null);
  let error = $state('');
  $effect(() => {
    const client = store.client, id = thread?.id;
    if (!active || !id || !experimentOn('contacts') || store.connection !== 'ready' || !client) return;
    let alive = true, version = 0;
    const load = () => {
      const request = ++version;
      void store.shared.load(id).then(() => {if (alive && request === version) error = '';})
        .catch(e => {if (alive && request === version) error = errorText(e);});
    };
    untrack(load);
    const release = client.on('contacts.updated', load);
    return () => { alive = false; release(); };
  });
  // Key only the association identities, so a refresh never tears its own watches down.
  let keys = $derived(active && thread ? JSON.stringify(projects.map(p => p.shared.id)) : '[]');
  $effect(() => {
    const ids: string[] = JSON.parse(keys), id = thread?.id;
    if (!id) return;
    const releases = untrack(() => ids.map(sharedProjectId => store.shared.watch({threadId: id, sharedProjectId}, ['threads'])));
    return () => { for (const release of releases) release(); };
  });
  async function board(scope: SharedProjectScope) {
    await store.open(scope.threadId);
    store.shared.boards[scope.threadId] = scope.sharedProjectId;
    store.showBoard();
  }
</script>

{#if projects.length}<div class="person" data-testid="shared-local-person">{strings.shared.you} · {localMachine}</div>{/if}
{@render children()}
{#if active && thread}
  {#each projects as project (project.shared.id)}
    {@const scope = {threadId: thread.id, sharedProjectId: project.shared.id}}
    {@const view = store.shared.view(scope)}
    {@const remote = view?.threads.filter(row => sameSharedProject(row.ref.project, project.remote)) ?? []}
    <section class="shared" data-testid="shared-project-people" data-shared-project={project.shared.id}>
      <header><span class="person">{project.contact.name} · {remote[0]?.machine ?? ''}</span>
        {#if store.core?.features?.projectBoard}<button type="button" class="ghost icon" aria-label={strings.shared.board} disabled={!project.shared.access.every(a => a.board)} onclick={() => void board(scope)} data-testid="shared-open-board"><SquareKanban size={13} /></button>{/if}
        <button type="button" class="ghost icon" aria-label={strings.shared.heading} onclick={() => { settings = scope; }} data-testid="shared-open-settings"><Settings2 size={13} /></button>
      </header>
      {#each remote as row (store.shared.threadKey(row.ref))}
        <div class="thread" data-testid="shared-thread" data-ref={store.shared.threadKey(row.ref)}>
          <button type="button" class="ghost main" data-testid="shared-thread-open" onclick={() => { selected = {scope, target: row}; }} title={row.agent.title}>
            <ProviderLogo providerId={row.agent.agent?.split(' ')[0] ?? ''} size={13} /><span>{row.agent.title}</span>
          </button>
          <button type="button" class="ghost icon" aria-label={fill(strings.shared.with, {name: project.contact.name}) + ': ' + strings.shared.write} onclick={() => { selected = {scope, target: row}; }} data-testid="shared-thread-write"><MessageSquare size={13} /></button>
        </div>
      {:else}<p class="hint">{project.connection === 'connected' ? strings.shared.noThreads : strings.shared.offline}</p>{/each}
      {#if view?.unavailable.length}<p class="hint" role="status">{strings.shared.offline}</p>{/if}
      {#if view?.error}<p class="error" role="alert">{view.error}</p>{/if}
    </section>
  {/each}
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if settings}{#await import('./SharedProjectDialog.svelte') then module}<module.default {store} scope={settings} onclose={() => { settings = null; }} />{/await}{/if}
{#if selected}{#await import('./SharedThreadDialog.svelte') then module}<module.default {store} scope={selected.scope} target={selected.target} onclose={() => { selected = null; }} />{/await}{/if}

<style>
  .person { min-width: 0; padding: 6px 8px 3px; color: var(--color-muted-foreground); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shared { border-top: 1px solid var(--color-border); margin-top: 4px; }
  header { display: flex; align-items: center; gap: 2px; } header .person { flex: 1; }
  .thread { display: flex; align-items: center; border-radius: var(--radius-sm); }
  .thread:hover { background: var(--color-hover); }
  .main { flex: 1; min-width: 0; justify-content: flex-start; gap: 8px; height: var(--row); font-size: var(--text-sm); background: none; border: none; text-align: left; }
  .main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon { flex: none; width: var(--control-sm); height: var(--control-sm); padding: 0; display: grid; place-items: center; }
  .hint, .error { padding-inline: 8px; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .error { color: var(--color-danger); }
  @media (max-width: 720px) { .main, .icon { min-height: var(--touch-target); } .icon { min-width: var(--touch-target); } }
</style>
