<script lang="ts">
  import { untrack } from 'svelte';
  import { Cpu, ShieldCheck, Users } from '@lucide/svelte';
  import type { SharedProjectScope } from '@boite/contracts';
  import type { Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { sameSharedProject } from '../../lib/shared-ui';
  import { strings } from '../../lib/strings';
  import SharedDialog from './SharedDialog.svelte';
  import SharedCompute from './SharedCompute.svelte';
  import SharedHostSettings from './SharedHostSettings.svelte';
  import SharedProtection from './SharedProtection.svelte';
  let { store, scope, onclose }: { store: Store; scope: SharedProjectScope; onclose: () => void } = $props();
  let view = $derived(store.shared.view(scope));
  let project = $derived(view?.project);
  let error = $state('');
  let busy = $state(false);
  let confirming = $state(false);
  const uid = $props.id();
  const tabs = ['sharing', 'tasks', 'protection'] as const;
  let tab = $state<(typeof tabs)[number]>('sharing');
  function navigate(event: KeyboardEvent) {
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    tab = tabs[index]!;
    document.getElementById(`${uid}-${tab}`)?.focus();
  }
  $effect(() => { const captured = scope; return untrack(() => store.shared.watch(captured, ['threads', 'compute', 'access'])); });
  async function configure(board: boolean) {
    if (!store.owner || busy) return;
    busy = true; error = '';
    try { await store.shared.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, board}); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
  async function revoke() {
    if (!store.owner || busy) return;
    busy = true; error = '';
    try { await store.shared.call('sharedProjects.revoke', {sharedProjectId: scope.sharedProjectId, requestId: secureId()}); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
</script>

<SharedDialog title={project ? `${strings.shared.heading} · ${project.contact.name}` : strings.shared.heading} {onclose} compact testid="shared-project-dialog">
  {#if project}
    <p class="state" data-testid="shared-project-state">{strings.shared.state[project.shared.state]}{#if project.connection !== 'connected'} · {strings.shared.offline}{/if}</p>
    {#if project.shared.state === 'active'}
      {@const local = project.shared.access.find(access => sameSharedProject(access.project, project.local))!}
      <div class="tabs" role="tablist" aria-label={strings.shared.heading}>
        {#each tabs as item (item)}
          <button type="button" role="tab" id="{uid}-{item}" aria-selected={tab === item} aria-controls="{uid}-{item}-panel" tabindex={tab === item ? 0 : -1}
            data-testid="shared-tab-{item}" onclick={() => { tab = item; }} onkeydown={navigate}>
            {#if item === 'sharing'}<Users size={15} />{:else if item === 'tasks'}<Cpu size={15} />{:else}<ShieldCheck size={15} />{/if}
            <span class="ui-label">{strings.shared.tabs[item]}</span>
          </button>
        {/each}
      </div>
      <div class="panel" id="{uid}-sharing-panel" role="tabpanel" aria-labelledby="{uid}-sharing" hidden={tab !== 'sharing'} data-testid="shared-panel-sharing">
        <label class="row"><span>{strings.shared.boardConsent}</span><input type="checkbox" role="switch" checked={local.board} disabled={!store.owner || busy} data-testid="shared-board-consent" onchange={e => void configure(e.currentTarget.checked)} /></label>
        {#if !project.shared.access.every(access => access.board)}<p class="state">{strings.shared.boardWaiting}</p>{/if}
        {#if store.owner}<SharedHostSettings {store} {scope} {project} />{:else}<p class="state">{strings.shared.ownerOnly}</p>{/if}
        {#if store.owner}
          <footer>
            {#if confirming}<div class="revoke" role="alertdialog" aria-label={strings.shared.revokeTitle}>
              <p>{strings.shared.revokeBody}</p><div class="actions"><button type="button" class="ghost" disabled={busy} onclick={() => { confirming = false; }} data-testid="shared-revoke-cancel">{strings.contacts.requests.cancel}</button><button type="button" class="destructive" disabled={busy} onclick={() => void revoke()} data-testid="shared-revoke-confirm">{strings.shared.revoke}</button></div>
            </div>{:else}<button type="button" class="ghost danger small" disabled={busy} onclick={() => { confirming = true; }} data-testid="shared-project-revoke">{strings.shared.revoke}</button>{/if}
          </footer>
        {/if}
      </div>
      <div class="panel" id="{uid}-tasks-panel" role="tabpanel" aria-labelledby="{uid}-tasks" hidden={tab !== 'tasks'} data-testid="shared-panel-tasks">
        <SharedCompute {store} {scope} {project} />
      </div>
      <div class="panel" id="{uid}-protection-panel" role="tabpanel" aria-labelledby="{uid}-protection" hidden={tab !== 'protection'} data-testid="shared-panel-protection">
        <SharedProtection {store} {scope} {project} />
      </div>
    {/if}
  {:else if !view?.error}<p>{strings.parts.loading}</p>{/if}
  {#if error || view?.error}<p class="error" role="alert">{error || view?.error}</p>{/if}
</SharedDialog>

<style>
  .state { margin: 0 0 12px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: var(--text-sm); padding-block: 12px; }
  .tabs { display: flex; gap: 4px; padding: 4px; background: var(--color-surface-2); border-radius: var(--radius-md); }
  .tabs button { flex: 1; min-width: 0; display: flex; justify-content: center; align-items: center; gap: 6px; padding: 8px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .tabs button[aria-selected='true'] { color: var(--color-accent); background: var(--color-accent-soft); }
  .panel { padding-top: 12px; }
  footer { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .revoke { padding: 12px; background: var(--color-surface-2); border-radius: var(--radius-md); font-size: var(--text-sm); }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 720px) { button { min-height: var(--touch-target); } }
</style>
